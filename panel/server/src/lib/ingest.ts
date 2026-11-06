import type { Metrics } from '@popug/protocol';
import { eq, sql } from 'drizzle-orm';
import { type DB, schema } from '../db/index.js';
import type { Counters, LiveData } from '../db/schema.js';

export const RAW_RES = 15;

/** Дельта накопительного счётчика. Значение меньше предыдущего — рестарт процесса: дельта = новое значение. */
export const delta = (cur: number, prev: number): number => (cur >= prev ? cur - prev : cur);

export interface Computed {
  live: LiveData;
  counters: Counters;
  /** null, если предыдущего снимка нет (первый после старта/регистрации) или интервал нулевой. */
  step: {
    dt: number;
    rx: number;
    tx: number;
    backends: { name: string; bin: number; bout: number; scur: number; up: number; total: number }[];
  } | null;
}

export function compute(m: Metrics, now: number, prev: Counters | null): Computed {
  const dt = prev ? (now - prev.ts) / 1000 : 0;
  const hasStep = prev !== null && dt > 0.5;

  const rx = hasStep ? delta(m.sys.net.rxBytes, prev.rx) : 0;
  const tx = hasStep ? delta(m.sys.net.txBytes, prev.tx) : 0;

  const counters: Counters = { ts: now, rx: m.sys.net.rxBytes, tx: m.sys.net.txBytes, backends: {} };
  const backendSteps: NonNullable<Computed['step']>['backends'] = [];
  const liveBackends: LiveData['backends'] = [];

  for (const b of m.haproxy.backends) {
    counters.backends[b.name] = { bin: b.bin, bout: b.bout };
    const p = prev?.backends[b.name];
    // Новый бэкенд при существующем предыдущем снимке = создан reload'ом: счётчик стартовал с нуля.
    const bin = hasStep ? (p ? delta(b.bin, p.bin) : b.bin) : 0;
    const bout = hasStep ? (p ? delta(b.bout, p.bout) : b.bout) : 0;
    const up = b.servers.filter((s) => s.status === 'UP').length;
    backendSteps.push({ name: b.name, bin, bout, scur: b.scur, up, total: b.servers.length });
    liveBackends.push({
      name: b.name,
      status: b.status,
      scur: b.scur,
      stot: b.stot,
      inBps: hasStep ? bin / dt : 0,
      outBps: hasStep ? bout / dt : 0,
      servers: b.servers,
    });
  }

  const live: LiveData = {
    ts: now,
    sys: {
      cpuPct: m.sys.cpuPct,
      load1: m.sys.load1,
      load5: m.sys.load5,
      load15: m.sys.load15,
      memTotal: m.sys.memTotal,
      memAvail: m.sys.memAvail,
      uptimeSec: m.sys.uptimeSec,
      rxBps: hasStep ? rx / dt : 0,
      txBps: hasStep ? tx / dt : 0,
      ifaces: m.sys.net.ifaces,
    },
    haproxy: { ok: m.haproxy.ok, error: m.haproxy.error, version: m.haproxy.version, uptimeSec: m.haproxy.uptimeSec },
    backends: liveBackends,
    sessions: liveBackends.reduce((a, b) => a + b.scur, 0),
    clients: m.clients,
    clientsError: m.clientsError,
  };
  return { live, counters, step: hasStep ? { dt, rx, tx, backends: backendSteps } : null };
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Кэш предыдущих счётчиков: БД читаем только после рестарта панели. */
export class Ingestor {
  private cache = new Map<string, Counters>();
  private lastSeenWrite = new Map<string, number>();

  constructor(private db: DB) {}

  forget(nodeId: string): void {
    this.cache.delete(nodeId);
    this.lastSeenWrite.delete(nodeId);
  }

  async ingest(nodeId: string, m: Metrics, nowMs = Date.now()): Promise<Computed> {
    let prev = this.cache.get(nodeId) ?? null;
    if (!prev) {
      const [row] = await this.db.select({ counters: schema.nodeLive.counters }).from(schema.nodeLive).where(eq(schema.nodeLive.nodeId, nodeId));
      prev = row?.counters ?? null;
    }
    const c = compute(m, nowMs, prev);
    this.cache.set(nodeId, c.counters);
    const at = new Date(nowMs);
    const day = utcDay(nowMs);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.nodeLive)
        .values({ nodeId, ts: at, data: c.live, counters: c.counters })
        .onConflictDoUpdate({ target: schema.nodeLive.nodeId, set: { ts: at, data: c.live, counters: c.counters } });

      if (c.step) {
        const s = c.step;
        await tx.insert(schema.nodeMetrics).values({
          nodeId,
          res: RAW_RES,
          ts: at,
          dt: s.dt,
          rxBytes: s.rx,
          txBytes: s.tx,
          cpuAvg: m.sys.cpuPct,
          cpuMax: m.sys.cpuPct,
          memTotal: m.sys.memTotal,
          memAvailAvg: m.sys.memAvail,
          load1Avg: m.sys.load1,
          sessionsAvg: c.live.sessions,
          sessionsMax: c.live.sessions,
          clientsAvg: m.clients?.active ?? null,
          clientsMax: m.clients?.active ?? null,
        });
        await tx
          .insert(schema.nodeDaily)
          .values({ nodeId, day, rxBytes: s.rx, txBytes: s.tx })
          .onConflictDoUpdate({
            target: [schema.nodeDaily.nodeId, schema.nodeDaily.day],
            set: { rxBytes: sql`${schema.nodeDaily.rxBytes} + ${s.rx}`, txBytes: sql`${schema.nodeDaily.txBytes} + ${s.tx}` },
          });
        if (s.backends.length > 0) {
          await tx.insert(schema.backendMetrics).values(
            s.backends.map((b) => ({
              nodeId,
              backend: b.name,
              res: RAW_RES,
              ts: at,
              dt: s.dt,
              binBytes: b.bin,
              boutBytes: b.bout,
              scurAvg: b.scur,
              scurMax: b.scur,
              serversUpMin: b.up,
              serversTotal: b.total,
            })),
          );
          for (const b of s.backends) {
            await tx
              .insert(schema.backendDaily)
              .values({ nodeId, backend: b.name, day, binBytes: b.bin, boutBytes: b.bout })
              .onConflictDoUpdate({
                target: [schema.backendDaily.nodeId, schema.backendDaily.backend, schema.backendDaily.day],
                set: { binBytes: sql`${schema.backendDaily.binBytes} + ${b.bin}`, boutBytes: sql`${schema.backendDaily.boutBytes} + ${b.bout}` },
              });
          }
        }
      }
    });

    // last_seen_at пишем не чаще раза в 30 с, чтобы не плодить апдейты строки ноды.
    if (nowMs - (this.lastSeenWrite.get(nodeId) ?? 0) >= 30_000) {
      this.lastSeenWrite.set(nodeId, nowMs);
      await this.db.update(schema.nodes).set({ lastSeenAt: at, haproxyVersion: m.haproxy.version ?? undefined }).where(eq(schema.nodes.id, nodeId));
    }
    return c;
  }
}
