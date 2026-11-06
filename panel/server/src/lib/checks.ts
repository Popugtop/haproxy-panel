import { connect as tlsConnect } from 'node:tls';
import type { CheckResult } from '@popug/protocol';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { Ctx } from '../app.js';
import { type DB, schema } from '../db/index.js';
import { loadRoutes } from './routes.js';

export const AGENT_CHECK_INTERVAL_SEC = 30;
export const PANEL_CHECK_INTERVAL_MS = 90_000;
/** Рукопожатие медленнее — маршрут жёлтый. */
export const SLOW_MS = 1000;
const WINDOW_MS = 3 * 60_000;

export type Tone = 'ok' | 'warn' | 'bad' | 'unknown';

// ───────── что агент должен проверять ─────────

export async function checksConfigFor(db: DB, nodeId: string) {
  const routes = await loadRoutes(db, { nodeId });
  const targets = routes
    .filter((r) => r.enabled && r.healthCheck && r.snis.length > 0)
    .flatMap((r) => r.exits.map((e) => ({ routeId: r.id, exitId: e.id, host: e.host, port: e.port, sni: r.snis[0]!, proxy: r.proxyProtocol })));
  return { t: 'checks_config' as const, intervalSec: AGENT_CHECK_INTERVAL_SEC, targets };
}

/** Отправляет агентам актуальный список проверок. Для ноды без соединения ничего не делает: список уйдёт при подключении. */
export async function pushChecks(ctx: Ctx, nodeIds: string[]): Promise<void> {
  for (const id of new Set(nodeIds)) {
    if (!ctx.registry.isOnline(id)) continue;
    ctx.registry.sendRaw(id, await checksConfigFor(ctx.db, id));
  }
}

// ───────── приём результатов агента ─────────

export async function ingestAgentChecks(db: DB, nodeId: string, results: CheckResult[], at = new Date()): Promise<number> {
  if (results.length === 0) return 0;
  const routeIds = [...new Set(results.map((r) => r.routeId))].filter((x) => /^[0-9a-f-]{36}$/.test(x));
  if (routeIds.length === 0) return 0;
  // Принимаем только маршруты, которые реально привязаны к этой ноде: чужие id игнорируются.
  const own = new Set((await db.select({ id: schema.routeNodes.routeId }).from(schema.routeNodes).where(and(eq(schema.routeNodes.nodeId, nodeId), inArray(schema.routeNodes.routeId, routeIds)))).map((r) => r.id));
  const rows = results
    .filter((r) => own.has(r.routeId))
    .map((r) => ({ nodeId, routeId: r.routeId, exitId: /^[0-9a-f-]{36}$/.test(r.exitId) ? r.exitId : null, source: 'agent', ts: at, ok: r.ok, ms: r.ms, error: r.error }));
  if (rows.length) await db.insert(schema.checkResults).values(rows);
  return rows.length;
}

// ───────── сквозная проверка панели: панель → мост:443 с SNI маршрута ─────────

export function probeTls(host: string, port: number, sni: string, timeoutMs = 6000): Promise<{ ok: boolean; ms: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    const finish = (r: { ok: boolean; ms: number | null; error: string | null }) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    const socket = tlsConnect({ host, port, servername: sni, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    socket.setTimeout(timeoutMs, () => finish({ ok: false, ms: null, error: `таймаут ${timeoutMs / 1000} с` }));
    socket.once('secureConnect', () => finish({ ok: true, ms: Math.round((performance.now() - t0) * 10) / 10, error: null }));
    socket.once('error', (e) => finish({ ok: false, ms: null, error: e.message.slice(0, 300) }));
  });
}

/** Проверяет маршруты ноды снаружи и пишет результаты. onlyRouteIds — выборочно. */
export async function runPanelChecks(db: DB, nodeId: string, probe: typeof probeTls = probeTls): Promise<number> {
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
  if (!node?.ip) return 0;
  const routes = (await loadRoutes(db, { nodeId })).filter((r) => r.enabled && r.healthCheck && r.snis.length > 0);
  const out = await Promise.all(routes.map(async (r) => ({ r, res: await probe(node.ip!, 443, r.snis[0]!) })));
  if (out.length)
    await db.insert(schema.checkResults).values(out.map(({ r, res }) => ({ nodeId, routeId: r.id, exitId: null, source: 'panel', ts: new Date(), ok: res.ok, ms: res.ms, error: res.error })));
  return out.length;
}

export function startPanelChecker(ctx: Ctx, log: { error: (o: unknown, m: string) => void }): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const nodes = await ctx.db.select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.isDemo, false));
      for (let i = 0; i < nodes.length; i += 4) await Promise.all(nodes.slice(i, i + 4).map((n) => runPanelChecks(ctx.db, n.id, ctx.probe)));
    } catch (err) {
      log.error({ err }, 'сквозные проверки панели упали');
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), PANEL_CHECK_INTERVAL_MS);
  t.unref();
  setTimeout(() => void tick(), 20_000).unref();
  return () => clearInterval(t);
}

// ───────── статус маршрута ─────────

export interface PairStatus {
  routeId: string;
  nodeId: string;
  tone: Tone;
  lastAt: Date | null;
  avgMs: number | null;
  /** Почему именно такой статус — для подсказки в таблице. */
  reason: string;
}

/**
 * Статус пары «маршрут × нода» по результатам за последние 3 минуты.
 * Красный: все проверки одного из источников (агент или панель) провалены — мост не доходит до выхода или недоступен снаружи.
 * Жёлтый: часть проверок провалена или рукопожатие медленнее SLOW_MS. Зелёный: проверки идут и всё хорошо. Нет данных — unknown.
 */
export function judge(rows: { source: string; ok: boolean; ms: number | null; ts: Date }[]): { tone: Tone; avgMs: number | null; reason: string } {
  if (rows.length === 0) return { tone: 'unknown', avgMs: null, reason: 'нет результатов проверок за последние 3 минуты' };
  const okMs = rows.filter((r) => r.ok && r.ms !== null).map((r) => r.ms as number);
  const avgMs = okMs.length ? okMs.reduce((a, b) => a + b, 0) / okMs.length : null;
  for (const src of ['agent', 'panel']) {
    const s = rows.filter((r) => r.source === src);
    if (s.length > 0 && s.every((r) => !r.ok)) {
      return { tone: 'bad', avgMs, reason: src === 'agent' ? 'мост не доходит до выхода (проверка агента)' : 'мост недоступен снаружи или не пропускает SNI маршрута (проверка панели)' };
    }
  }
  const failed = rows.filter((r) => !r.ok).length;
  if (failed > 0) return { tone: 'warn', avgMs, reason: `часть проверок не прошла: ${failed} из ${rows.length}` };
  if (avgMs !== null && avgMs > SLOW_MS) return { tone: 'warn', avgMs, reason: `рукопожатие медленное: ${Math.round(avgMs)} мс` };
  return { tone: 'ok', avgMs, reason: 'проверки проходят' };
}

export async function pairStatuses(db: DB, filter: { routeIds?: string[]; nodeId?: string } = {}, now = new Date()): Promise<PairStatus[]> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const where = and(
    gte(schema.checkResults.ts, since),
    filter.routeIds ? inArray(schema.checkResults.routeId, filter.routeIds) : undefined,
    filter.nodeId ? eq(schema.checkResults.nodeId, filter.nodeId) : undefined,
  );
  const rows = await db.select().from(schema.checkResults).where(where);
  const links = await db.select().from(schema.routeNodes).where(filter.routeIds ? inArray(schema.routeNodes.routeId, filter.routeIds) : filter.nodeId ? eq(schema.routeNodes.nodeId, filter.nodeId) : undefined);
  return links.map((l) => {
    const mine = rows.filter((r) => r.routeId === l.routeId && r.nodeId === l.nodeId);
    const j = judge(mine);
    const last = mine.reduce<Date | null>((a, r) => (!a || r.ts > a ? r.ts : a), null);
    return { routeId: l.routeId, nodeId: l.nodeId, tone: j.tone, lastAt: last, avgMs: j.avgMs, reason: j.reason };
  });
}

const RANK: Record<Tone, number> = { bad: 3, warn: 2, ok: 1, unknown: 0 };
/** Статус маршрута = худший по его нодам; unknown только если неизвестно везде. */
export const worst = (tones: Tone[]): Tone => tones.reduce<Tone>((a, t) => (RANK[t] > RANK[a] ? t : a), 'unknown');

export async function checkHistory(db: DB, routeId: string, opts: { nodeId?: string; limit?: number } = {}) {
  return db
    .select({ ts: schema.checkResults.ts, nodeId: schema.checkResults.nodeId, exitId: schema.checkResults.exitId, source: schema.checkResults.source, ok: schema.checkResults.ok, ms: schema.checkResults.ms, error: schema.checkResults.error })
    .from(schema.checkResults)
    .where(opts.nodeId ? and(eq(schema.checkResults.routeId, routeId), eq(schema.checkResults.nodeId, opts.nodeId)) : eq(schema.checkResults.routeId, routeId))
    .orderBy(desc(schema.checkResults.ts))
    .limit(opts.limit ?? 100);
}
