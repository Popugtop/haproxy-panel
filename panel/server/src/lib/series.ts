import { and, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { type DB, schema } from '../db/index.js';
import { RES } from './rollup.js';

export const RANGES = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 86400,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
  '90d': 90 * 86400,
  '1y': 365 * 86400,
} as const;
export type RangeKey = keyof typeof RANGES;

const TARGET_POINTS = 720;

/** Какой ряд читать и в какие корзины его склеивать, чтобы на графике было ~720 точек. */
export function plan(rangeSec: number): { src: number; bin: number } {
  const src = rangeSec <= 6 * 3600 ? RES.raw : rangeSec <= 14 * 86400 ? RES.min : RES.hour;
  const bin = Math.max(src, Math.ceil(rangeSec / TARGET_POINTS / src) * src);
  return { src, bin };
}

export interface NodeSeries {
  bin: number;
  from: number;
  to: number;
  /** Секунды unix. */
  t: number[];
  rxBps: (number | null)[];
  txBps: (number | null)[];
  cpu: (number | null)[];
  memUsedPct: (number | null)[];
  load1: (number | null)[];
  sessions: (number | null)[];
  clients: (number | null)[];
  backends: Record<string, { inBps: (number | null)[]; outBps: (number | null)[]; sessions: (number | null)[] }>;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function nodeSeries(db: DB, nodeId: string, range: RangeKey, nowMs = Date.now()): Promise<NodeSeries> {
  const rangeSec = RANGES[range];
  const { src, bin } = plan(rangeSec);
  const from = new Date(nowMs - rangeSec * 1000);
  const nm = schema.nodeMetrics;
  const bm = schema.backendMetrics;

  const nb = sql`date_bin('${sql.raw(String(bin))} seconds'::interval, ${nm.ts}, TIMESTAMPTZ '2000-01-01 00:00:00+00')`;
  const nodeRows = await db
    .select({
      t: sql<string>`extract(epoch from ${nb})`,
      rx: sql<string>`sum(${nm.rxBytes}) / nullif(sum(${nm.dt}), 0)`,
      tx: sql<string>`sum(${nm.txBytes}) / nullif(sum(${nm.dt}), 0)`,
      cpu: sql<string>`sum(${nm.cpuAvg} * ${nm.n}) / nullif(sum(${nm.n}) filter (where ${nm.cpuAvg} is not null), 0)`,
      memAvail: sql<string>`sum(${nm.memAvailAvg} * ${nm.n}) / nullif(sum(${nm.n}) filter (where ${nm.memAvailAvg} is not null), 0)`,
      memTotal: sql<string>`max(${nm.memTotal})`,
      load1: sql<string>`sum(${nm.load1Avg} * ${nm.n}) / nullif(sum(${nm.n}) filter (where ${nm.load1Avg} is not null), 0)`,
      sessions: sql<string>`sum(${nm.sessionsAvg} * ${nm.n}) / nullif(sum(${nm.n}), 0)`,
      clients: sql<string>`sum(${nm.clientsAvg} * ${nm.n}) / nullif(sum(${nm.n}) filter (where ${nm.clientsAvg} is not null), 0)`,
    })
    .from(nm)
    .where(and(eq(nm.nodeId, nodeId), eq(nm.res, src), gte(nm.ts, from), lt(nm.ts, new Date(nowMs + 60_000))))
    .groupBy(nb)
    .orderBy(nb);

  const bb = sql`date_bin('${sql.raw(String(bin))} seconds'::interval, ${bm.ts}, TIMESTAMPTZ '2000-01-01 00:00:00+00')`;
  const backendRows = await db
    .select({
      backend: bm.backend,
      t: sql<string>`extract(epoch from ${bb})`,
      inBps: sql<string>`sum(${bm.binBytes}) / nullif(sum(${bm.dt}), 0)`,
      outBps: sql<string>`sum(${bm.boutBytes}) / nullif(sum(${bm.dt}), 0)`,
      sessions: sql<string>`sum(${bm.scurAvg} * ${bm.n}) / nullif(sum(${bm.n}), 0)`,
    })
    .from(bm)
    .where(and(eq(bm.nodeId, nodeId), eq(bm.res, src), gte(bm.ts, from), lt(bm.ts, new Date(nowMs + 60_000))))
    .groupBy(bm.backend, bb)
    .orderBy(bb);

  const ts = new Set<number>(nodeRows.map((r) => Number(r.t)));
  for (const r of backendRows) ts.add(Number(r.t));
  const t = [...ts].sort((a, b) => a - b);
  const idx = new Map(t.map((v, i) => [v, i]));
  const col = () => new Array<number | null>(t.length).fill(null);

  const out: NodeSeries = {
    bin,
    from: Math.floor(from.getTime() / 1000),
    to: Math.floor(nowMs / 1000),
    t,
    rxBps: col(),
    txBps: col(),
    cpu: col(),
    memUsedPct: col(),
    load1: col(),
    sessions: col(),
    clients: col(),
    backends: {},
  };
  for (const r of nodeRows) {
    const i = idx.get(Number(r.t))!;
    out.rxBps[i] = num(r.rx);
    out.txBps[i] = num(r.tx);
    out.cpu[i] = num(r.cpu);
    const avail = num(r.memAvail);
    const total = num(r.memTotal);
    out.memUsedPct[i] = avail !== null && total ? (1 - avail / total) * 100 : null;
    out.load1[i] = num(r.load1);
    out.sessions[i] = num(r.sessions);
    out.clients[i] = num(r.clients);
  }
  for (const r of backendRows) {
    const b = (out.backends[r.backend] ??= { inBps: col(), outBps: col(), sessions: col() });
    const i = idx.get(Number(r.t))!;
    b.inBps[i] = num(r.inBps);
    b.outBps[i] = num(r.outBps);
    b.sessions[i] = num(r.sessions);
  }
  return out;
}

export interface FleetSeries {
  bin: number;
  from: number;
  to: number;
  t: number[];
  /** Суммарные скорости всех нод, байт/с. */
  txBps: number[];
  rxBps: number[];
}

/**
 * Суммарный трафик всех нод за последний час — для спарклайна на обзоре.
 * Скорость каждой ноды в корзине = байты / сумма dt (а не / длина корзины): метки агентов дрожат,
 * и в корзину попадает то 1, то 3 строки. Затем скорости нод складываются.
 */
export async function fleetSeries(db: DB, nowMs = Date.now()): Promise<FleetSeries> {
  const bin = 30;
  const from = new Date(nowMs - 3600e3);
  const nm = schema.nodeMetrics;
  const b = sql`date_bin('${sql.raw(String(bin))} seconds'::interval, ${nm.ts}, TIMESTAMPTZ '2000-01-01 00:00:00+00')`;
  const per = db
    .select({
      b: sql<Date>`${b}`.as('b'),
      tx: sql<string>`sum(${nm.txBytes}) / nullif(sum(${nm.dt}), 0)`.as('tx'),
      rx: sql<string>`sum(${nm.rxBytes}) / nullif(sum(${nm.dt}), 0)`.as('rx'),
    })
    .from(nm)
    // Строки с большим dt покрывают провал в связи (агент молчал) — в график скорости они не годятся.
    .where(and(eq(nm.res, RES.raw), lte(nm.dt, 45), gte(nm.ts, from), lt(nm.ts, new Date(nowMs + 60_000))))
    .groupBy(b, nm.nodeId)
    .as('per');
  const rows = await db
    .select({
      t: sql<string>`extract(epoch from ${per.b})`,
      tx: sql<string>`sum(${per.tx})`,
      rx: sql<string>`sum(${per.rx})`,
    })
    .from(per)
    .groupBy(per.b)
    .orderBy(per.b);
  // Крайние корзины неполные: отбрасываем.
  const fromSec = Math.floor(from.getTime() / 1000);
  const toSec = Math.floor(nowMs / 1000);
  const full = rows.filter((r) => Number(r.t) >= fromSec + bin && Number(r.t) + bin <= toSec);
  return {
    bin,
    from: fromSec,
    to: toSec,
    t: full.map((r) => Number(r.t)),
    txBps: full.map((r) => Number(r.tx)),
    rxBps: full.map((r) => Number(r.rx)),
  };
}
