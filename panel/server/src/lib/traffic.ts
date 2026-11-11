import { and, gte, lte, sql } from 'drizzle-orm';
import { type DB, schema } from '../db/index.js';

/**
 * Потребление трафика. Сутки считаются по UTC, как и квота хостера.
 * Для нод это исходящий трафик интерфейса (tx): байт пользователя уходит с моста либо клиенту, либо на выход, то есть
 * tx ≈ весь пользовательский трафик (rx+tx посчитал бы каждый байт дважды). Для маршрутов — вход+выход HAProxy со стороны клиента.
 */

export interface Bytes {
  tx: number;
  rx: number;
}

export interface TrafficSummary {
  /** Сегодняшняя дата (UTC), YYYY-MM-DD. */
  day: string;
  today: Bytes;
  month: Bytes;
  total: Bytes;
  /** Дата первых данных; null — данных ещё нет. */
  since: string | null;
}

export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

export async function trafficSummary(db: DB, nowMs = Date.now()): Promise<TrafficSummary> {
  const day = utcDate(nowMs);
  const monthStart = `${day.slice(0, 7)}-01`;
  const d = schema.nodeDaily;
  const [r] = await db
    .select({
      todayTx: sql<string>`coalesce(sum(${d.txBytes}) filter (where ${d.day} = ${day}), 0)`,
      todayRx: sql<string>`coalesce(sum(${d.rxBytes}) filter (where ${d.day} = ${day}), 0)`,
      monthTx: sql<string>`coalesce(sum(${d.txBytes}) filter (where ${d.day} >= ${monthStart}), 0)`,
      monthRx: sql<string>`coalesce(sum(${d.rxBytes}) filter (where ${d.day} >= ${monthStart}), 0)`,
      totalTx: sql<string>`coalesce(sum(${d.txBytes}), 0)`,
      totalRx: sql<string>`coalesce(sum(${d.rxBytes}), 0)`,
      since: sql<string | null>`min(${d.day})::text`,
    })
    .from(d);
  return {
    day,
    today: { tx: Number(r!.todayTx), rx: Number(r!.todayRx) },
    month: { tx: Number(r!.monthTx), rx: Number(r!.monthRx) },
    total: { tx: Number(r!.totalTx), rx: Number(r!.totalRx) },
    since: r!.since ?? null,
  };
}

export type GroupBy = 'node' | 'route';

export interface StatsSeries {
  key: string;
  name: string;
  total: number;
  /** Байты по дням, в порядке `days`. */
  daily: number[];
}

export interface TrafficStats {
  by: GroupBy;
  from: string;
  to: string;
  days: string[];
  total: number;
  /** В среднем за сутки периода. */
  avgPerDay: number;
  peak: { day: string; bytes: number } | null;
  /** Суммарно по дням. */
  dailyTotal: number[];
  /** Крупнейшие группы по убыванию; остальные свёрнуты в «Прочие» (key `_other`). */
  series: StatsSeries[];
  others: number;
}

export const OTHER_KEY = '_other';
export const MAX_RANGE_DAYS = 1100;

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += DAY_MS) out.push(utcDate(t));
  return out;
}

export async function trafficStats(db: DB, o: { from: string; to: string; by: GroupBy; top: number }): Promise<TrafficStats> {
  const days = daysBetween(o.from, o.to);
  const idx = new Map(days.map((d, i) => [d, i]));
  const groups = new Map<string, StatsSeries>();
  const add = (key: string, name: string, day: string, bytes: number) => {
    const i = idx.get(day);
    if (i === undefined || bytes <= 0) return;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, name, total: 0, daily: days.map(() => 0) }));
    g.daily[i]! += bytes;
    g.total += bytes;
  };

  if (o.by === 'node') {
    const d = schema.nodeDaily;
    const rows = await db
      .select({ id: d.nodeId, name: schema.nodes.name, day: sql<string>`${d.day}::text`, tx: d.txBytes })
      .from(d)
      .innerJoin(schema.nodes, sql`${schema.nodes.id} = ${d.nodeId}`)
      .where(and(gte(d.day, o.from), lte(d.day, o.to)));
    for (const r of rows) add(r.id, r.name, r.day, Number(r.tx));
  } else {
    const d = schema.backendDaily;
    const rows = await db
      .select({ backend: d.backend, day: sql<string>`${d.day}::text`, bytes: sql<string>`sum(${d.binBytes} + ${d.boutBytes})` })
      .from(d)
      .where(and(gte(d.day, o.from), lte(d.day, o.to)))
      .groupBy(d.backend, d.day);
    const names = new Map((await db.select({ slug: schema.routes.slug, name: schema.routes.name }).from(schema.routes)).map((r) => [r.slug, r.name]));
    for (const r of rows) add(r.backend, names.get(r.backend.replace(/^be_/, '')) ?? r.backend, r.day, Number(r.bytes));
  }

  const sorted = [...groups.values()].sort((a, b) => b.total - a.total);
  const series = sorted.slice(0, o.top);
  const rest = sorted.slice(o.top);
  if (rest.length) {
    series.push({ key: OTHER_KEY, name: 'Прочие', total: rest.reduce((a, g) => a + g.total, 0), daily: days.map((_, i) => rest.reduce((a, g) => a + g.daily[i]!, 0)) });
  }
  const dailyTotal = days.map((_, i) => sorted.reduce((a, g) => a + g.daily[i]!, 0));
  const total = dailyTotal.reduce((a, b) => a + b, 0);
  let peak: TrafficStats['peak'] = null;
  dailyTotal.forEach((b, i) => {
    if (b > 0 && (!peak || b > peak.bytes)) peak = { day: days[i]!, bytes: b };
  });
  return { by: o.by, from: o.from, to: o.to, days, total, avgPerDay: days.length ? total / days.length : 0, peak, dailyTotal, series, others: rest.length };
}
