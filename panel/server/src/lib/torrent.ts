/**
 * Торрент-блокер: панель опрашивает отчёты Remnawave (только чтение) и банит настоящий IP клиента на мостах.
 * Логика перенесена из popug-tb (~/Code/haproxy-torrent-agent): курсор по ID отчёта, пропуски с причинами,
 * действующий бан не продлевается и не укорачивается, старые отчёты при первом запуске не баним.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../app.js';
import { type DB, schema } from '../db/index.js';
import { audit } from './audit.js';
import { createBans, infraIps, normalizeIp, protectedReason } from './bans.js';
import { HttpError } from './http.js';
import { RemnaClient, RemnaError, type TorrentReport } from './remnawave.js';
import { allowlistMatcher, getSetting, loadRemna, putSetting, remnaCreds, type RemnaSettings } from './settings.js';

export interface TorrentState {
  initialized: boolean;
  cursor: number;
  lastPollAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** Предупреждение, не мешающее работе (например, не удалось получить список нод Remnawave). */
  warning: string | null;
  /** IP нод Remnawave: их баном можно отрезать собственную инфраструктуру. */
  allowIps: string[];
  allowAt: string | null;
}

const STATE_DEFAULTS: TorrentState = { initialized: false, cursor: 0, lastPollAt: null, lastOkAt: null, lastError: null, warning: null, allowIps: [], allowAt: null };
export const TORRENT_ACTIONS = ['ban', 'observe', 'skip', 'already_banned', 'error'] as const;
export type TorrentAction = (typeof TORRENT_ACTIONS)[number];

const ALLOW_REFRESH_MS = 10 * 60_000;
export const loadTorrentState = (db: DB): Promise<TorrentState> => getSetting(db, 'torrent_state', STATE_DEFAULTS);
const saveState = (db: DB, st: TorrentState) => putSetting(db, 'torrent_state', st);

const isCgnat = (ip: string): boolean => {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 100 && b >= 64 && b <= 127;
};

export interface PollResult {
  status: 'disabled' | 'not_configured' | 'initialized' | 'ok' | 'cursor_reset';
  processed: number;
  banned: number;
}

let running = false;

/** Один цикл опроса. Ошибки сети и API записываются в состояние и пробрасываются, курсор при этом не двигается. */
export async function pollOnce(ctx: Ctx, now = new Date()): Promise<PollResult> {
  const { db, config } = ctx;
  const s = await loadRemna(db);
  if (!s.enabled) return { status: 'disabled', processed: 0, banned: 0 };
  const creds = remnaCreds(s, config.APP_SECRET);
  if (!creds) return { status: 'not_configured', processed: 0, banned: 0 };
  if (running) return { status: 'ok', processed: 0, banned: 0 };
  running = true;
  const st = await loadTorrentState(db);
  st.lastPollAt = now.toISOString();
  try {
    const client = new RemnaClient(creds, ctx.http);
    st.warning = null;
    if (!st.allowAt || now.getTime() - new Date(st.allowAt).getTime() > ALLOW_REFRESH_MS) {
      try {
        st.allowIps = await collectRemnaIps(client);
        st.allowAt = now.toISOString();
      } catch (e) {
        st.warning = `Не удалось получить список нод Remnawave (${(e as Error).message}). Баны продолжаются, защищены адреса нод и выходов панели.`;
      }
    }
    if (!st.initialized) {
      st.cursor = await client.latest();
      st.initialized = true;
      st.lastOkAt = now.toISOString();
      st.lastError = null;
      await saveState(db, st);
      return { status: 'initialized', processed: 0, banned: 0 };
    }
    const res = await client.since(st.cursor);
    if (res.newest < st.cursor) {
      // Отчёты в Remnawave очистили, нумерация началась заново.
      st.cursor = res.newest;
      st.lastOkAt = now.toISOString();
      st.lastError = null;
      await saveState(db, st);
      return { status: 'cursor_reset', processed: 0, banned: 0 };
    }
    const env = await makeEnv(ctx, s, st, now);
    let banned = 0;
    for (const r of res.reports) {
      const ev = await handleReport(ctx, s, r, env);
      if (ev.action === 'ban') banned++;
      st.cursor = Math.max(st.cursor, r.id);
      await saveState(db, st); // курсор двигается только после обработанного отчёта: ошибка повторится без потерь
    }
    if (res.truncated) st.warning = `${st.warning ? st.warning + ' ' : ''}Непрочитанных отчётов слишком много, самые старые пропущены.`;
    st.lastOkAt = now.toISOString();
    st.lastError = null;
    await saveState(db, st);
    return { status: 'ok', processed: res.reports.length, banned };
  } catch (e) {
    st.lastError = e instanceof RemnaError ? e.message : `Ошибка обработки: ${(e as Error).message}`;
    await saveState(db, st);
    throw e;
  } finally {
    running = false;
  }
}

async function collectRemnaIps(client: RemnaClient): Promise<string[]> {
  const out = new Set<string>();
  for (const n of await client.nodes()) {
    for (const ip of n.ips) out.add(ip);
    if (isIP(n.address)) out.add(n.address);
    else if (n.address) {
      try {
        for (const a of await lookup(n.address, { all: true })) out.add(a.address);
      } catch {
        /* имя не разрешилось: остальных адресов хватает */
      }
    }
  }
  return [...out];
}

interface Env {
  now: Date;
  infra: Map<string, string>;
  remnaIps: Set<string>;
  manual: (ip: string) => boolean;
  nodeIds: string[];
}

async function makeEnv(ctx: Ctx, s: RemnaSettings, st: TorrentState, now: Date): Promise<Env> {
  const nodes = await ctx.db.select({ id: schema.nodes.id }).from(schema.nodes).where(isNull(schema.nodes.keyRevokedAt));
  return { now, infra: await infraIps(ctx.db), remnaIps: new Set(st.allowIps), manual: allowlistMatcher(s.allowlist), nodeIds: nodes.map((n) => n.id) };
}

export interface Decision {
  action: TorrentAction;
  reason: string | null;
  durationSec: number | null;
  nodesCount: number;
}

/** Решение по одному отчёту без побочных эффектов (кроме вызова ban): чистая часть удобна для тестов. */
export function decide(s: RemnaSettings, r: TorrentReport, env: Pick<Env, 'now' | 'infra' | 'remnaIps' | 'manual'>): { skip: string } | { ip: string; durationSec: number } {
  if (!r.blocked) return { skip: 'в списке исключений плагина Torrent Blocker' };
  const ip = normalizeIp(r.ip);
  if (!ip) return { skip: 'в отчёте нет корректного IP' };
  if (s.banMode === 'report' && r.blockDurationSec <= 0) return { skip: 'в отчёте нулевой срок блокировки' };
  const why = protectedReason(ip) ?? (isCgnat(ip) ? 'адрес CGNAT' : null);
  if (why) return { skip: `${why}: банить нельзя` };
  const infra = env.infra.get(ip);
  if (infra) return { skip: `это ${infra}` };
  if (env.remnaIps.has(ip)) return { skip: 'это адрес ноды Remnawave' };
  if (env.manual(ip)) return { skip: 'адрес в вашем списке исключений' };
  if (r.willUnblockAt && r.willUnblockAt.getTime() <= env.now.getTime()) return { skip: 'срок блокировки из отчёта уже истёк' };
  const wanted = s.banMode === 'fixed' ? s.fixedBanSec : r.blockDurationSec;
  return { ip, durationSec: Math.max(60, Math.min(Math.floor(wanted), s.maxBanSec)) };
}

async function handleReport(ctx: Ctx, s: RemnaSettings, r: TorrentReport, env: Env): Promise<Decision> {
  const { db } = ctx;
  const record = async (d: Decision, ip = r.ip) => {
    await db.insert(schema.torrentEvents).values({ reportId: r.id, username: r.username, remnaNode: r.nodeName, ip: ip || '—', action: d.action, reason: d.reason, durationSec: d.durationSec, nodesCount: d.nodesCount });
    return d;
  };
  const dec = decide(s, r, env);
  if ('skip' in dec) return record({ action: 'skip', reason: dec.skip, durationSec: null, nodesCount: 0 });

  // Действующий бан не продлеваем и не укорачиваем: баним только те ноды, где его ещё нет.
  const active = await db
    .select({ nodeId: schema.bans.nodeId })
    .from(schema.bans)
    .where(and(eq(schema.bans.ip, dec.ip), gt(schema.bans.expiresAt, env.now)));
  const have = new Set(active.map((a) => a.nodeId));
  const targets = env.nodeIds.filter((id) => !have.has(id));
  if (targets.length === 0) return record({ action: 'already_banned', reason: 'бан уже действует', durationSec: null, nodesCount: 0 }, dec.ip);
  if (s.observeOnly) return record({ action: 'observe', reason: 'режим наблюдения: бан не ставится', durationSec: dec.durationSec, nodesCount: targets.length }, dec.ip);

  try {
    const res = await createBans(ctx, { ip: dec.ip, nodeIds: targets, durationSec: dec.durationSec, reason: 'torrent', note: `торрент: ${r.username || '—'} → ${r.nodeName || '—'}, отчёт #${r.id}` }, { login: 'torrent-blocker' });
    const failed = res.outcomes.filter((o) => o.error);
    await audit(db, { id: null, login: 'torrent-blocker' }, 'torrent.ban', { type: 'ip', id: dec.ip }, { user: r.username, remnawaveNode: r.nodeName, report: r.id, durationSec: dec.durationSec, nodes: targets.length }, null);
    return record({ action: 'ban', reason: failed.length ? `не применилось на ${failed.length} нодах: ${failed.map((f) => f.error).join('; ')}` : null, durationSec: dec.durationSec, nodesCount: targets.length }, dec.ip);
  } catch (e) {
    if (e instanceof HttpError) return record({ action: 'error', reason: e.message, durationSec: dec.durationSec, nodesCount: 0 }, dec.ip);
    throw e;
  }
}

/** Фоновый опрос. Интервал берётся из настроек при каждом цикле; при ошибках пауза растёт до двух минут. */
export function startTorrentPoller(ctx: Ctx, log: { error: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void }): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let fails = 0;
  const tick = async () => {
    let delay = 15_000;
    try {
      const s = await loadRemna(ctx.db);
      delay = Math.max(5, s.pollIntervalSec) * 1000;
      const r = await pollOnce(ctx);
      if (r.status === 'initialized') log.info({}, 'торрент-блокер: курсор установлен, старые отчёты не обрабатываются');
      if (r.banned > 0) log.info({ banned: r.banned }, 'торрент-блокер: поставлены баны');
      fails = 0;
    } catch (e) {
      fails++;
      delay = Math.min(120_000, delay * 2 ** Math.min(fails, 5));
      if (fails === 1 || fails % 20 === 0) log.error({ err: (e as Error).message }, 'торрент-блокер: опрос Remnawave не удался');
    }
    if (!stopped) timer = setTimeout(() => void tick(), delay);
  };
  timer = setTimeout(() => void tick(), 5_000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export async function torrentStats(db: DB, since = new Date(Date.now() - 86400e3)) {
  const rows = await db
    .select({ action: schema.torrentEvents.action, n: sql<number>`count(*)::int` })
    .from(schema.torrentEvents)
    .where(gt(schema.torrentEvents.at, since))
    .groupBy(schema.torrentEvents.action);
  const by: Record<string, number> = {};
  for (const r of rows) by[r.action] = r.n;
  const [active] = await db
    .select({ n: sql<number>`count(distinct ${schema.bans.ip})::int` })
    .from(schema.bans)
    .where(and(eq(schema.bans.reason, 'torrent'), gt(schema.bans.expiresAt, new Date())));
  return { last24h: by, activeBans: active?.n ?? 0 };
}

/** События храним 90 дней. */
export async function purgeTorrentEvents(db: DB, nowMs = Date.now()): Promise<void> {
  await db.delete(schema.torrentEvents).where(lt(schema.torrentEvents.at, new Date(nowMs - 90 * 86400e3)));
}

export { desc, inArray };
