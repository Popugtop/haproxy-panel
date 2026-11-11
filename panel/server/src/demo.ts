/**
 * Демо-режим (DEMO=1): три ноды с историей и «фейковый агент», который каждые 15 с отдаёт правдоподобные метрики.
 *
 * Гарантии, что демо не попадёт в прод:
 *  - DEMO=1 при NODE_ENV=production — ошибка конфигурации (config.ts);
 *  - демо-ноды помечены is_demo, и обычный запуск без DEMO удаляет их (purgeDemo);
 *  - метрики идут через тот же Ingestor, что и настоящие, но соединение — заглушка, наружу ничего не открывается.
 */
import { createHash } from 'node:crypto';
import type { Metrics } from '@popug/protocol';
import { and, eq, sql } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import type { Ctx } from './app.js';
import { type DB, schema } from './db/index.js';
import type { Counters } from './db/schema.js';
import { ensureAlertRules } from './lib/alerts.js';
import { encryptSecret } from './lib/crypto.js';
import { compute } from './lib/ingest.js';
import { putSetting } from './lib/settings.js';
import { stateHash, renderConfig } from './lib/render.js';
import { cfgSha, desiredFor, loadRoutes } from './lib/routes.js';
import type { AgentConn } from './lib/registry.js';

const H = 3600e3;
const DAY = 24 * H;

interface DemoBackend {
  name: string;
  host: string;
  share: number;
  servers: string[];
  /** Бэкенд лёг за столько мс до старта демо; до этого нёс трафик. */
  downForMs?: number;
}

interface DemoNode {
  name: string;
  domain: string;
  hoster: string;
  ip: string;
  quotaTb: number;
  quotaCounts: 'tx' | 'txrx';
  /** Сколько суток назад начался расчётный период. */
  periodDaysAgo: number;
  haproxy: string;
  agentVersion: string;
  memTotal: number;
  /** Средняя пользовательская нагрузка за сутки, Мбит/с. */
  avgMbit: number;
  cpuBase: number;
  cpuPerMbit: number;
  clientsBase: number;
  phase: number;
  backends: DemoBackend[];
}

const NODES: DemoNode[] = [
  {
    name: 'Aeza · Стокгольм', domain: 'branch.popug.cloud', hoster: 'Aeza', ip: '203.0.113.21', quotaTb: 10, quotaCounts: 'tx', periodDaysAgo: 20,
    haproxy: '2.8.5', agentVersion: '0.2.0', memTotal: 2_086_989_824, avgMbit: 27, cpuBase: 4, cpuPerMbit: 0.32, clientsBase: 96, phase: 0.4,
    backends: [
      { name: 'be_se', host: 'se.popug.cloud', share: 0.3, servers: ['se1'] },
      { name: 'be_de', host: 'de.popug.cloud', share: 0.25, servers: ['de1', 'de2'] },
      { name: 'be_nl', host: 'nl.popug.cloud', share: 0.22, servers: ['nl1'] },
      { name: 'be_cz', host: 'cz.popug.cloud', share: 0.13, servers: ['cz1'] },
      { name: 'be_ee', host: 'ee.popug.cloud', share: 0.1, servers: ['ee1'] },
    ],
  },
  {
    name: 'xorekcloud · Москва', domain: 'bell.popug.cloud', hoster: 'xorekcloud', ip: '198.51.100.44', quotaTb: 20, quotaCounts: 'txrx', periodDaysAgo: 5,
    haproxy: '2.8.5', agentVersion: '0.3.0', memTotal: 4_135_641_088, avgMbit: 36, cpuBase: 5, cpuPerMbit: 0.3, clientsBase: 142, phase: 2.1,
    backends: [
      { name: 'be_de', host: 'de.popug.cloud', share: 0.42, servers: ['de1', 'de2'] },
      { name: 'be_nl', host: 'nl.popug.cloud', share: 0.36, servers: ['nl1'] },
      { name: 'be_sg', host: 'sg.popug.cloud', share: 0.22, servers: ['sg1'] },
    ],
  },
  {
    name: 'cloud4box · Санкт-Петербург', domain: 'perch.popug.cloud', hoster: 'cloud4box', ip: '192.0.2.88', quotaTb: 5, quotaCounts: 'tx', periodDaysAgo: 17,
    haproxy: '2.6.12', agentVersion: '0.2.0', memTotal: 1_040_187_392, avgMbit: 24, cpuBase: 38, cpuPerMbit: 0.95, clientsBase: 64, phase: 4.2,
    backends: [
      { name: 'be_de', host: 'de.popug.cloud', share: 0.5, servers: ['de1', 'de2'] },
      { name: 'be_nl', host: 'nl.popug.cloud', share: 0.3, servers: ['nl1'] },
      { name: 'be_sg', host: 'sg.popug.cloud', share: 0.2, servers: ['sg1'], downForMs: 40 * 60e3 },
    ],
  },
];

// ───────── модель нагрузки: детерминированная функция времени ─────────

function load(n: DemoNode, t: number): number {
  const hour = (t / H) % 24; // UTC; вечерний пик по Москве ≈ 17:00 UTC, ночной провал
  const diurnal = 0.62 + 0.38 * Math.cos(((hour - 17) / 24) * 2 * Math.PI);
  const noise = 1 + 0.06 * Math.sin(t / 1.9e6 + n.phase) + 0.045 * Math.sin(t / 410e3 + n.phase * 2.3) + 0.025 * Math.sin(t / 97e3 + n.phase * 5);
  return (diurnal * noise) / 0.62;
}

/** Пользовательская нагрузка, байт/с. */
const throughput = (n: DemoNode, t: number) => ((n.avgMbit * 1e6) / 8) * load(n, t);

function activeShares(n: DemoNode, t: number, t0: number): number[] {
  const live = n.backends.map((b) => (b.downForMs && t > t0 - b.downForMs ? 0 : b.share));
  const sum = live.reduce((a, b) => a + b, 0);
  return live.map((s) => s / sum);
}

interface Sample {
  rx: number;
  tx: number;
  backends: { bin: number; bout: number; scur: number; up: number }[];
  cpu: number;
  memAvail: number;
  load1: number;
  clients: number;
}

/** Всё, что накопилось на интервале [t, t+dt) мс, и мгновенные величины в момент t. */
function sample(n: DemoNode, t: number, dtMs: number, t0: number): Sample {
  const T = throughput(n, t);
  const dt = dtMs / 1000;
  const mbit = (T * 8) / 1e6;
  const clients = Math.max(3, Math.round(n.clientsBase * load(n, t) * 0.85));
  const shares = activeShares(n, t, t0);
  const cpu = Math.min(97, Math.max(1.5, n.cpuBase + mbit * n.cpuPerMbit + 1.4 * Math.sin(t / 61e3 + n.phase)));
  return {
    rx: T * dt * 1.012,
    tx: T * dt * 1.008,
    backends: n.backends.map((b, i) => ({
      bout: T * shares[i]! * 0.93 * dt,
      bin: T * shares[i]! * 0.07 * dt,
      scur: Math.round(clients * 2.4 * shares[i]!),
      up: shares[i]! > 0 ? b.servers.length : 0,
    })),
    cpu,
    memAvail: n.memTotal * (1 - (0.21 + 0.015 * Math.sin(t / 3e6 + n.phase) + clients * 0.00035)),
    load1: (cpu / 100) * 1.6,
    clients,
  };
}

// ───────── фейковый агент ─────────

interface CounterState {
  rx: number;
  tx: number;
  b: Record<string, { bin: number; bout: number; stot: number }>;
  seq: number;
}

const IPS = Array.from({ length: 28 }, (_, i) =>
  i % 5 === 4 ? `2001:db8:${(i * 37).toString(16)}::${(i + 3).toString(16)}` : `${i % 2 ? '198.51.100' : '192.0.2'}.${10 + ((i * 7) % 60) + (i % 2 ? 0 : 100)}`,
);

function topClients(n: DemoNode, t: number, bootT: number, s: Sample) {
  const T = throughput(n, t);
  const weights = IPS.map((_, i) => 1 / (i + 1) ** 1.1);
  const total = weights.reduce((a, b) => a + b, 0);
  const rows = IPS.map((ip, i) => {
    const w = (weights[i]! / total) * 0.8 * (1 + 0.25 * Math.sin(t / 53e3 + i * 1.7));
    const since = bootT - (2 * H + i * 50 * 60e3);
    const age = (t - since) / 1000;
    const avg = ((n.avgMbit * 1e6) / 8) * w;
    return {
      ip,
      connCur: Math.max(0, Math.round(1 + s.clients * 0.05 * w * 40 - (i > 20 ? 1 : 0))),
      connCnt: 20 + i * 13 + Math.floor(age / 60),
      bytesIn: Math.round(avg * 0.07 * age),
      bytesOut: Math.round(avg * 0.93 * age),
      rateIn: T * 0.07 * w,
      rateOut: T * 0.93 * w,
    };
  });
  return rows;
}

function buildMetrics(n: DemoNode, st: CounterState, t: number, dtMs: number, bootT: number): Metrics {
  const s = sample(n, t, dtMs, bootT);
  st.rx += s.rx;
  st.tx += s.tx;
  const shares = activeShares(n, t, bootT);
  st.seq++;
  const backends = n.backends.map((b, i) => {
    const c = (st.b[b.name] ??= { bin: 1e9, bout: 8e9, stot: 1000 });
    c.bin += s.backends[i]!.bin;
    c.bout += s.backends[i]!.bout;
    c.stot += Math.round(s.backends[i]!.scur * 0.4 * (dtMs / 1000));
    const down = shares[i] === 0;
    return {
      name: b.name,
      status: down ? 'DOWN' : 'UP',
      bin: Math.round(c.bin),
      bout: Math.round(c.bout),
      stot: c.stot,
      scur: s.backends[i]!.scur,
      servers: b.servers.map((name) => ({
        name,
        status: down ? 'DOWN' : 'UP',
        check: down ? 'L4TOUT' : 'L4OK',
        checkMs: down ? null : 2 + ((t / 7000 + name.length) % 5),
      })),
    };
  });
  return {
    t: 'metrics',
    ts: t,
    seq: st.seq,
    sys: {
      cpuPct: s.cpu,
      load1: s.load1,
      load5: s.load1 * 0.9,
      load15: s.load1 * 0.8,
      memTotal: n.memTotal,
      memAvail: Math.round(s.memAvail),
      uptimeSec: Math.floor((t - (bootT - 19 * DAY)) / 1000),
      net: {
        rxBytes: Math.round(st.rx),
        txBytes: Math.round(st.tx),
        ifaces: [{ name: 'eth0', rx: Math.round(st.rx), tx: Math.round(st.tx) }],
      },
    },
    haproxy: {
      ok: true,
      error: null,
      version: n.haproxy,
      uptimeSec: Math.floor((t - (bootT - 6 * DAY)) / 1000),
      backends,
      frontends: [{ name: 'fe_sni', scur: backends.reduce((a, b) => a + b.scur, 0), bin: 1, bout: 1, stot: 1 }],
    },
    clients: { tracked: s.clients * 3 + 40, active: s.clients, flowing: Math.round(s.clients * 0.42), top: topClients(n, t, bootT, s) },
    clientsError: null,
  };
}

// ───────── каталог демо-выходов и маршрутов ─────────

const EXITS = [
  { key: 'se1', name: 'Швеция 1', country: 'SE', host: '203.0.113.11' },
  { key: 'de1', name: 'Германия 1', country: 'DE', host: '203.0.113.21' },
  { key: 'de2', name: 'Германия 2', country: 'DE', host: '203.0.113.22' },
  { key: 'nl1', name: 'Нидерланды 1', country: 'NL', host: '203.0.113.31' },
  { key: 'cz1', name: 'Чехия 1', country: 'CZ', host: '203.0.113.41' },
  { key: 'ee1', name: 'Эстония 1', country: 'EE', host: '203.0.113.51' },
  { key: 'sg1', name: 'Сингапур 1', country: 'SG', host: '203.0.113.61' },
];

const ROUTES = [
  { slug: 'se', name: 'Швеция (🇷🇺 → 🇸🇪)', exits: ['se1'], proxy: false, ms: 28, ipLimitMbit: 30 },
  { slug: 'de', name: 'Германия (🇷🇺 → 🇩🇪)', exits: ['de1', 'de2'], proxy: true, ms: 42 },
  { slug: 'nl', name: 'Нидерланды (🇷🇺 → 🇳🇱)', exits: ['nl1'], proxy: false, ms: 38, limitMbit: 400 },
  { slug: 'cz', name: 'Чехия (🇷🇺 → 🇨🇿)', exits: ['cz1'], proxy: false, ms: 55 },
  { slug: 'ee', name: 'Эстония (🇷🇺 → 🇪🇪)', exits: ['ee1'], proxy: false, ms: 51 },
  { slug: 'sg', name: 'Сингапур (🇷🇺 → 🇸🇬)', exits: ['sg1'], proxy: true, ms: 210 },
];

/** Исход проверки маршрута на ноде в момент t: ok/ms/ошибка. Здесь живут демо-сценарии для экрана проверок. */
function checkOutcome(node: DemoNode, slug: string, exitKey: string, t: number, bootT: number): { ok: boolean; ms: number | null; error: string | null } {
  const r = ROUTES.find((x) => x.slug === slug)!;
  const jitter = 1 + 0.18 * Math.sin(t / 41e3 + slug.length + exitKey.length);
  const down = node.backends.find((b) => b.name === `be_${slug}`)?.downForMs;
  if (down && t > bootT - down) return { ok: false, ms: null, error: `dial tcp ${EXITS.find((e) => e.key === exitKey)!.host}:443: i/o timeout` };
  // Эстония на Aeza два часа назад падала на 20 минут: в истории есть красный отрезок.
  if (node.name.startsWith('Aeza') && slug === 'ee' && t > bootT - 140 * 60e3 && t < bootT - 120 * 60e3) return { ok: false, ms: null, error: 'TLS: EOF' };
  // Чехия с Aeza медленная: жёлтая.
  const base = node.name.startsWith('Aeza') && slug === 'cz' ? 1350 : r.ms;
  return { ok: true, ms: Math.round(base * jitter * 10) / 10, error: null };
}

/** Заглушка сокета: отвечает на cmd так же, как настоящий агент, наружу ничего не открывает. */
function fakeSocket(n: DemoNode, getConn: () => AgentConn, ctx: Ctx, state: { cfg: string; sniMap: string; nodeId: string; bootT: number }): WebSocket {
  const reply = (id: string, r: Record<string, unknown>) => setTimeout(() => ctx.registry.resolve(getConn(), { t: 'result', id, ok: true, error: null, ...r } as never), 120);
  return {
    send(data: string) {
      const cmd = JSON.parse(data) as { t: string; id: string; op: string; args?: { cfg: string; sniMap: string; version: number; validateOnly: boolean } };
      if (cmd.t !== 'cmd') return; // checks_config и прочее: демо-агент проверяет по собственному расписанию
      if (cmd.op === 'get_config') {
        return reply(cmd.id, { data: { path: '/etc/haproxy/haproxy.cfg', content: state.cfg, sha256: cfgSha(state.cfg) } });
      }
      if (cmd.op === 'apply_config' && cmd.args) {
        const { cfg, sniMap, version, validateOnly } = cmd.args;
        // Демо-сценарий неудачи: SNI со словом «fail» HAProxy «не принимает», нода откатывается.
        if (sniMap.includes('fail')) {
          const bind = 'cannot bind socket [0.0.0.0:443]';
          return setTimeout(
            () => ctx.registry.resolve(getConn(), {
              t: 'result', id: cmd.id, ok: false, error: 'конфиг не применился, возвращён прежний: HAProxy не поднялся за 12s',
              data: { version, applied: false, rolledBack: true, rollbackFailed: false, sha256: cfgSha(state.cfg), output: `[ALERT] (demo) ${bind}\nHAProxy не поднялся за 12s (uptime 41 с больше времени после reload (12 с))`, durationMs: 13120 },
            }),
            1500,
          );
        }
        return setTimeout(() => {
          if (!validateOnly) {
            state.cfg = cfg;
            state.sniMap = sniMap;
          }
          ctx.registry.resolve(getConn(), { t: 'result', id: cmd.id, ok: true, error: null, data: { version, applied: !validateOnly, rolledBack: false, rollbackFailed: false, sha256: cfgSha(validateOnly ? state.cfg : cfg), output: 'Configuration file is valid', durationMs: 640 } });
        }, 900);
      }
      if (cmd.op === 'get_clients') {
        const now = Date.now();
        const smp = sample(n, now, 15_000, state.bootT);
        return reply(cmd.id, { data: { tracked: smp.clients * 3 + 40, active: smp.clients, flowing: Math.round(smp.clients * 0.42), top: topClients(n, now, state.bootT, smp) } });
      }
      if (cmd.op === 'apply_bans') return reply(cmd.id, { data: { active: 3, rejected: [] } });
      if (cmd.op === 'update_agent') {
        const a = (cmd as unknown as { args: { version: string } }).args;
        setTimeout(() => ctx.registry.resolve(getConn(), { t: 'result', id: cmd.id, ok: true, error: null, data: { from: n.agentVersion, to: a.version, restarting: true } }), 1200);
        return void setTimeout(() => void ctx.db.update(schema.nodes).set({ agentVersion: a.version }).where(eq(schema.nodes.id, state.nodeId)).then(() => { n.agentVersion = a.version; }), 4000);
      }
      if (cmd.op === 'run_checks') {
        return void (async () => {
          const routes = (await loadRoutes(ctx.db, { nodeId: state.nodeId })).filter((r) => r.enabled && r.healthCheck);
          const results = routes.flatMap((r) => r.exits.map((e) => ({ routeId: r.id, exitId: e.id, ...checkOutcome(n, r.slug, EXITS.find((x) => x.host === e.host)?.key ?? 'x', Date.now(), state.bootT) })));
          reply(cmd.id, { data: { results } });
        })();
      }
      return reply(cmd.id, { data: { pong: true } });
    },
    close() {},
    terminate() {},
  } as unknown as WebSocket;
}

// ───────── сид истории ─────────

const chunked = async <T>(rows: T[], size: number, fn: (c: T[]) => Promise<unknown>) => {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
};

type NodeMetricRow = typeof schema.nodeMetrics.$inferInsert;
type BackendMetricRow = typeof schema.backendMetrics.$inferInsert;
type CheckRow = typeof schema.checkResults.$inferInsert;

async function backfill(db: DB, nodeId: string, n: DemoNode, now: number) {
  const nm: NodeMetricRow[] = [];
  const bm: BackendMetricRow[] = [];
  const daily = new Map<string, { rx: number; tx: number; b: Map<string, { bin: number; bout: number }> }>();
  const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

  const push = (res: 15 | 60 | 3600, t: number, stepMs: number, samples: number) => {
    const s = sample(n, t + stepMs / 2, stepMs, now);
    const at = new Date(t + stepMs);
    const dt = stepMs / 1000;
    const clients = s.clients;
    nm.push({
      nodeId, res, ts: at, dt, n: samples,
      rxBytes: Math.round(s.rx), txBytes: Math.round(s.tx),
      cpuAvg: s.cpu, cpuMax: Math.min(100, s.cpu * (res === 15 ? 1 : 1.18)),
      memTotal: n.memTotal, memAvailAvg: s.memAvail, load1Avg: s.load1,
      sessionsAvg: s.backends.reduce((a, b) => a + b.scur, 0), sessionsMax: Math.ceil(s.backends.reduce((a, b) => a + b.scur, 0) * (res === 15 ? 1 : 1.2)),
      clientsAvg: clients, clientsMax: Math.ceil(clients * (res === 15 ? 1 : 1.1)),
    });
    n.backends.forEach((b, i) => {
      const x = s.backends[i]!;
      bm.push({
        nodeId, backend: b.name, res, ts: at, dt, n: samples,
        binBytes: Math.round(x.bin), boutBytes: Math.round(x.bout), scurAvg: x.scur, scurMax: Math.ceil(x.scur * (res === 15 ? 1 : 1.2)),
        serversUpMin: x.up, serversTotal: b.servers.length,
      });
    });
  };

  // сырые 15 с — последние 6 часов; минутные — 3 суток; часовые — 30 суток
  const rawFrom = Math.floor((now - 6 * H) / 15e3) * 15e3;
  for (let t = rawFrom; t + 15e3 <= now; t += 15e3) push(15, t, 15e3, 1);
  const minFrom = Math.floor((now - 3 * DAY) / 60e3) * 60e3;
  for (let t = minFrom; t + 60e3 <= now; t += 60e3) push(60, t, 60e3, 4);
  const hourFrom = Math.floor((now - 30 * DAY) / H) * H;
  for (let t = hourFrom; t + H <= now; t += H) push(3600, t, H, 240);

  // суточные суммы для квоты: 40 суток по часовой модели
  for (let t = Math.floor((now - 40 * DAY) / H) * H; t < now; t += H) {
    const step = Math.min(H, now - t);
    const s = sample(n, t + step / 2, step, now);
    const d = daily.get(dayOf(t)) ?? { rx: 0, tx: 0, b: new Map() };
    d.rx += s.rx;
    d.tx += s.tx;
    n.backends.forEach((b, i) => {
      const x = d.b.get(b.name) ?? { bin: 0, bout: 0 };
      x.bin += s.backends[i]!.bin;
      x.bout += s.backends[i]!.bout;
      d.b.set(b.name, x);
    });
    daily.set(dayOf(t), d);
  }

  await chunked(nm, 2000, (c) => db.insert(schema.nodeMetrics).values(c));
  await chunked(bm, 2000, (c) => db.insert(schema.backendMetrics).values(c));
  await db.insert(schema.nodeDaily).values([...daily].map(([day, d]) => ({ nodeId, day, rxBytes: Math.round(d.rx), txBytes: Math.round(d.tx) })));
  await db.insert(schema.backendDaily).values(
    [...daily].flatMap(([day, d]) => [...d.b].map(([backend, x]) => ({ nodeId, backend, day, binBytes: Math.round(x.bin), boutBytes: Math.round(x.bout) }))),
  );
}

export async function purgeDemo(db: DB): Promise<number> {
  const gone = await db.delete(schema.nodes).where(eq(schema.nodes.isDemo, true)).returning({ id: schema.nodes.id });
  await db.delete(schema.routes).where(eq(schema.routes.isDemo, true));
  await db.delete(schema.exits).where(eq(schema.exits.isDemo, true));
  await db.delete(schema.torrentEvents).where(eq(schema.torrentEvents.isDemo, true));
  await db.delete(schema.alerts).where(eq(schema.alerts.isDemo, true));
  // Демо-настройки (фейковый Remnawave) не должны остаться в реальной панели.
  await db.delete(schema.settings).where(sql`${schema.settings.value}->>'demo' = 'true'`);
  return gone.length;
}

const HAND_SNAPSHOT = `# ДЕМО: ручной конфиг, найденный на ноде при импорте
global
    log /dev/log local0
    stats socket /run/haproxy/admin.sock mode 660 level admin

defaults
    mode tcp
    timeout connect 5s
    timeout client 1h
    timeout server 1h

frontend fe_sni
    bind :443
    tcp-request inspect-delay 5s
    use_backend be_de if { req_ssl_sni -i de.popug.cloud }
    use_backend be_se if { req_ssl_sni -i se.popug.cloud }

backend be_de
    server de1 203.0.113.21:443 check
backend be_se
    server se1 203.0.113.11:443 check
`;

export async function startDemo(ctx: Ctx, log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m: string) => void }): Promise<() => void> {
  const { db } = ctx;
  await purgeDemo(db);
  const bootT = Date.now();
  // Демо «раздаёт» агента 0.3.0: у двух нод появляется кнопка «Обновить».
  ctx.release = () => ({ version: '0.3.0', files: { amd64: { sha256: 'd'.repeat(64), signed: true }, arm64: { sha256: 'e'.repeat(64), signed: true } }, hasPublicKey: true });

  // выходы и маршруты (общие для нод)
  const exitId = new Map<string, string>();
  for (const e of EXITS) {
    const [row] = await db.insert(schema.exits).values({ name: e.name, country: e.country, host: e.host, port: 443, isDemo: true }).returning();
    exitId.set(e.key, row!.id);
  }
  const routeId = new Map<string, string>();
  for (const r of ROUTES) {
    const [row] = await db.insert(schema.routes).values({ name: r.name, slug: r.slug, snis: [`${r.slug}.popug.cloud`], proxyProtocol: r.proxy, healthCheck: true, enabled: true, limitMbit: 'limitMbit' in r ? r.limitMbit : null, ipLimitMbit: 'ipLimitMbit' in r ? r.ipLimitMbit : null, isDemo: true }).returning();
    routeId.set(r.slug, row!.id);
    await db.insert(schema.routeExits).values(r.exits.map((k, position) => ({ routeId: row!.id, exitId: exitId.get(k)!, position })));
  }

  const states = new Map<string, { node: DemoNode; st: CounterState; last: number; agent: { cfg: string; sniMap: string; nodeId: string; bootT: number } }>();
  const idByNode = new Map<string, string>();

  for (const n of NODES) {
    const period = new Date(bootT - n.periodDaysAgo * DAY);
    const [row] = await db
      .insert(schema.nodes)
      .values({
        name: n.name, ip: n.ip, domain: n.domain, hoster: n.hoster, isDemo: true,
        quotaTb: n.quotaTb.toFixed(2), billingDay: period.getUTCDate(), quotaCounts: n.quotaCounts,
        keyHash: createHash('sha256').update(`demo-${n.name}-${bootT}`).digest('hex'), keyCreatedAt: new Date(bootT - 30 * DAY),
        agentVersion: n.agentVersion, arch: 'amd64', updateReady: true, protocol: 1, haproxyVersion: n.haproxy, haproxyInstalled: true, importDone: true,
        hostname: n.domain.split('.')[0], os: 'Debian GNU/Linux 12 (bookworm)', ops: ['ping', 'get_config', 'apply_config', 'run_checks', 'apply_bans', 'get_clients', 'update_agent'], addrs: [n.ip],
        lastRemoteIp: n.ip, lastConnectedAt: new Date(bootT), lastSeenAt: new Date(bootT),
      })
      .returning();
    const id = row!.id;
    idByNode.set(n.name, id);
    await db.insert(schema.routeNodes).values(n.backends.map((b) => ({ routeId: routeId.get(b.name.slice(3))!, nodeId: id })));
    await backfill(db, id, n, bootT);

    // Баны и персональные лимиты. Лимиты — до расчёта конфига, чтобы применённая версия уже их содержала.
    const ban = (ip: string, hours: number, reason: string, by: string, note: string | null) => ({ ip, nodeId: id, reason, createdBy: by, note, createdAt: new Date(bootT - 40 * 60e3), expiresAt: new Date(bootT + hours * H) });
    if (n.name.startsWith('Aeza')) {
      await db.insert(schema.bans).values([ban(IPS[3]!, 5.3, 'manual', 'admin', 'массовые обращения к чужим портам'), ban(IPS[7]!, 0.8, 'torrent', 'torrent-blocker', 'торрент-трафик, отчёт de-1')]);
      await db.insert(schema.ipLimits).values({ ip: IPS[0]!, nodeId: id, mbit: 20, note: 'качает за троих', createdBy: 'admin' });
    } else if (n.name.startsWith('xorek')) {
      await db.insert(schema.bans).values(ban(IPS[3]!, 22, 'manual', 'admin', null));
      await db.insert(schema.ipLimits).values({ ip: IPS[1]!, nodeId: id, mbit: 10, note: null, createdBy: 'admin' });
    }

    // История конфига: у каждой ноды применена версия, соответствующая её маршрутам.
    const desired = await desiredFor(db, { ...row!, defaultRouteId: null, extraConfig: null });
    const mk = (number: number, status: string, source: string, cfg: string, map: string, mins: number, output: string | null, by = 'admin') => ({
      nodeId: id, number, cfg, sniMap: map, sha256: stateHash(cfg, map), source, status, createdBy: by,
      createdAt: new Date(bootT - mins * 60e3), finishedAt: new Date(bootT - mins * 60e3 + 4000), output, durationMs: status === 'rolled_back' ? 13100 : 640,
    });
    const versions = [mk(1, 'imported', 'import', HAND_SNAPSHOT, '', 9 * 24 * 60, 'Снимок ручного конфига, найденного на ноде при импорте.')];
    if (n.name.startsWith('xorek')) {
      versions.push(mk(2, 'rolled_back', 'panel', desired.cfg.replace('timeout client 1h', 'timeout client 1h\n    # демо: неудачная попытка'), desired.sniMap, 6 * 24 * 60, '[ALERT] (demo) cannot bind socket [0.0.0.0:443]\nHAProxy не поднялся за 12s. Возвращён прежний конфиг.'));
      versions.push(mk(3, 'applied', 'panel', desired.cfg, desired.sniMap, 6 * 24 * 60 - 20, 'Configuration file is valid'));
    } else {
      versions.push(mk(2, 'applied', 'panel', desired.cfg, desired.sniMap, 8 * 24 * 60, 'Configuration file is valid'));
    }
    const inserted = await db.insert(schema.configVersions).values(versions).returning();
    const applied = inserted.find((v) => v.status === 'applied')!;
    await db.update(schema.nodes).set({ appliedVersionId: applied.id, configSha256: cfgSha(applied.cfg) }).where(eq(schema.nodes.id, id));

    const st: CounterState = { rx: 4e12, tx: 4e12, b: {}, seq: 0 };
    const t0 = bootT; // живые точки начинаются там, где закончился бэкфилл (иначе интервал посчитается дважды)
    const m0 = buildMetrics(n, st, t0, 0, bootT);
    const c0 = compute(m0, t0, null);
    await db.insert(schema.nodeLive).values({ nodeId: id, ts: new Date(t0), data: c0.live, counters: c0.counters as Counters });

    const agent = { cfg: applied.cfg, sniMap: applied.sniMap, nodeId: id, bootT };
    const conn: AgentConn = {
      nodeId: id, socket: undefined as unknown as WebSocket, connectedAt: new Date(), ready: true, ops: new Set(['ping', 'get_config', 'apply_config', 'run_checks', 'apply_bans', 'get_clients', 'update_agent']), pending: new Map(),
    };
    conn.socket = fakeSocket(n, () => conn, ctx, agent);
    ctx.registry.register(conn);
    states.set(id, { node: n, st, last: t0, agent });
  }

  // Ожидающее применение изменение: маршрут «Чехия» привязан к cloud4box уже после применения конфига.
  const c4 = idByNode.get(NODES[2]!.name)!;
  await db.insert(schema.routeNodes).values({ routeId: routeId.get('cz')!, nodeId: c4 });

  // История проверок за последние 3 часа: агент каждые 30 с, панель каждые 90 с.
  const checkRows: CheckRow[] = [];
  for (const [id, s] of states) {
    const routes = (await loadRoutes(db, { nodeId: id })).filter((r) => r.enabled && r.healthCheck && !(id === c4 && r.slug === 'cz'));
    for (let t = bootT - 3 * H; t < bootT; t += 30e3) {
      for (const r of routes) {
        for (const e of r.exits) {
          const o = checkOutcome(s.node, r.slug, EXITS.find((x) => x.host === e.host)!.key, t, bootT);
          checkRows.push({ nodeId: id, routeId: r.id, exitId: e.id, source: 'agent', ts: new Date(t), ...o });
        }
        if ((t / 30e3) % 3 === 0) {
          const o = checkOutcome(s.node, r.slug, r.exits[0] ? EXITS.find((x) => x.host === r.exits[0]!.host)!.key : 'x', t, bootT);
          checkRows.push({ nodeId: id, routeId: r.id, exitId: null, source: 'panel', ts: new Date(t + 4000), ok: o.ok, ms: o.ms === null ? null : o.ms + 9, error: o.ok ? null : 'мост не пропустил рукопожатие: ' + (o.error ?? '') });
        }
      }
    }
  }
  await chunked(checkRows, 2000, (c) => db.insert(schema.checkResults).values(c));

  let tickN = 0;
  const tick = async () => {
    const now = Date.now();
    tickN++;
    for (const [id, s] of states) {
      try {
        const m = buildMetrics(s.node, s.st, now, now - s.last, bootT);
        s.last = now;
        await ctx.ingestor.ingest(id, m, now);
        if (tickN % 2 === 0) {
          const routes = (await loadRoutes(db, { nodeId: id })).filter((r) => r.enabled && r.healthCheck && r.snis.length);
          const rows: CheckRow[] = [];
          for (const r of routes) {
            if (!s.agent.sniMap.includes(r.snis[0]!)) continue; // маршрут ещё не применён на ноду — агент его не проверяет
            for (const e of r.exits) rows.push({ nodeId: id, routeId: r.id, exitId: e.id, source: 'agent', ts: new Date(now), ...checkOutcome(s.node, r.slug, EXITS.find((x) => x.host === e.host)?.key ?? 'x', now, bootT) });
            if (tickN % 6 === 0) {
              const o = checkOutcome(s.node, r.slug, EXITS.find((x) => x.host === r.exits[0]!.host)?.key ?? 'x', now, bootT);
              rows.push({ nodeId: id, routeId: r.id, exitId: null, source: 'panel', ts: new Date(now), ok: o.ok, ms: o.ms === null ? null : o.ms + 9, error: o.ok ? null : 'мост не пропустил рукопожатие: ' + (o.error ?? '') });
            }
          }
          if (rows.length) await db.insert(schema.checkResults).values(rows);
        }
      } catch (err) {
        log.error({ err }, 'демо-агент: не удалось записать метрики');
      }
    }
  };

  // ── торрент-блокер и алерты: сид для экранов ──
  const secret = ctx.config.APP_SECRET;
  await putSetting(db, 'remnawave', { demo: true, enabled: true, url: 'https://rw.demo.popug.cloud', tokenEnc: encryptSecret('demo-token', secret), headersEnc: null, observeOnly: false, banMode: 'report', fixedBanSec: 3600, maxBanSec: 86400, pollIntervalSec: 15, allowlist: ['192.0.2.1'] });
  const torrentState = (now: number) => ({ demo: true, initialized: true, cursor: 1291, lastPollAt: new Date(now).toISOString(), lastOkAt: new Date(now).toISOString(), lastError: null, warning: null, allowIps: [], allowAt: new Date(now).toISOString() });
  await putSetting(db, 'torrent_state', torrentState(bootT));
  const ev = (minAgo: number, reportId: number, ip: string, user: string, node: string, action: string, reason: string | null, durationSec: number | null, nodesCount: number) => ({ at: new Date(bootT - minAgo * 60e3), reportId, ip, username: user, remnaNode: node, action, reason, durationSec, nodesCount, isDemo: true });
  await db.insert(schema.torrentEvents).values([
    ev(2, 1291, IPS[9]!, 'maria_k', 'nl-1', 'ban', null, 7200, 3),
    ev(11, 1290, IPS[12]!, 'dmitry88', 'de-1', 'already_banned', 'бан уже действует', null, 0),
    ev(47, 1288, IPS[7]!, 'alexey', 'de-1', 'ban', null, 3600, 3),
    ev(47, 1287, IPS[7]!, 'alexey', 'de-2', 'already_banned', 'бан уже действует', null, 0),
    ev(95, 1285, '10.8.0.14', 'olga_v', 'se-1', 'skip', 'частный адрес: банить нельзя', null, 0),
    ev(130, 1283, IPS[15]!, 'ivan.s', 'cz-1', 'skip', 'в списке исключений плагина Torrent Blocker', null, 0),
    ev(181, 1280, IPS[18]!, 'katya', 'ee-1', 'ban', null, 86400, 3),
    ev(240, 1276, '198.51.100.250', 'test_user', 'de-1', 'skip', 'адрес в вашем списке исключений', null, 0),
    ev(395, 1271, IPS[21]!, 'sergey_p', 'nl-1', 'ban', null, 3600, 3),
    ev(612, 1264, IPS[3]!, 'nikita', 'sg-1', 'error', 'ip: нельзя банить собственный выход', 3600, 0),
    ev(780, 1259, IPS[24]!, 'anna', 'de-1', 'ban', null, 7200, 3),
  ]);
  await ensureAlertRules(db);
  const nid = (prefix: string) => [...idByNode.entries()].find(([k]) => k.startsWith(prefix))![1];
  const inc = (kind: string, subject: string, label: string, severity: string, minAgo: number, lastMin: number | null, message: string, notified: number) => ({
    kind, subject, subjectLabel: label, severity, message, status: lastMin === null ? 'firing' : 'resolved', pendingSince: new Date(bootT - (minAgo + 2) * 60e3), firedAt: new Date(bootT - minAgo * 60e3),
    resolvedAt: lastMin === null ? null : new Date(bootT - lastMin * 60e3), lastNotifiedAt: notified ? new Date(bootT - minAgo * 60e3) : null, notifyCount: notified, isDemo: true,
  });
  await db.insert(schema.alerts).values([
    inc('config_failed', nid('cloud4box'), 'cloud4box · Санкт-Петербург', 'crit', 35, null, 'Конфиг откачен на прежний (версия 4): [ALERT] (demo) cannot bind socket [0.0.0.0:443]', 0),
    inc('node_offline', nid('cloud4box'), 'cloud4box · Санкт-Петербург', 'crit', 3 * 1440, 3 * 1440 - 9, 'Последние данные: 3 дня назад', 2),
    inc('config_failed', nid('xorek'), 'xorekcloud · Москва', 'crit', 6 * 1440, 6 * 1440 - 20, 'Конфиг откачен на прежний (версия 2): HAProxy не поднялся за 12s', 2),
    inc('ip_speed', `${nid('Aeza')}|${IPS[0]!}`, `${IPS[0]!} · Aeza · Стокгольм`, 'warn', 1440, 1440 - 26, '231 Мбит/с при пороге 200 Мбит/с', 2),
    inc('cpu', nid('xorek'), 'xorekcloud · Москва', 'warn', 4 * 1440, 4 * 1440 - 41, 'CPU 91% при пороге 85%', 2),
    inc('quota', nid('Aeza'), 'Aeza · Стокгольм', 'warn', 9 * 1440, 9 * 1440 - 2880, 'Использовано 82% квоты за прошлый период', 2),
    inc('route_red', `${routeId.get('sg')!}|${nid('cloud4box')}`, 'Сингапур (🇷🇺 → 🇸🇬) · cloud4box', 'crit', 310, 296, 'мост не доходит до выхода (проверка агента)', 2),
  ]);
  await tick();
  const timer = setInterval(() => void tick().then(() => putSetting(db, 'torrent_state', torrentState(Date.now()))).catch(() => undefined), 15_000);
  timer.unref();
  log.info({ nodes: NODES.length }, 'демо-режим: созданы демо-ноды, маршруты и фейковый агент (данные нереальные)');
  return () => clearInterval(timer);
}

export { and, renderConfig };
