import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { type DB, schema } from '../db/index.js';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Биллинговый период [start, end) в датах UTC. День 31 в коротком месяце сдвигается на последний день. */
export function billingPeriod(billingDay: number, now: Date): { start: string; end: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = iso(y, m, now.getUTCDate());
  // Date.UTC нормализует выход месяца за 0..11, поэтому m-1 и m+1 безопасны.
  const startOf = (month: number) => {
    const d = new Date(Date.UTC(y, month, 1));
    return iso(d.getUTCFullYear(), d.getUTCMonth(), Math.min(billingDay, daysIn(d.getUTCFullYear(), d.getUTCMonth())));
  };
  const month = startOf(m) <= today ? m : m - 1;
  return { start: startOf(month), end: startOf(month + 1) };
}

export interface QuotaUsage {
  periodStart: string;
  periodEnd: string;
  rxBytes: number;
  txBytes: number;
  usedBytes: number;
  limitBytes: number | null;
  pct: number | null;
  counts: 'tx' | 'txrx';
}

export async function quotaUsage(
  db: DB,
  node: { id: string; billingDay: number; quotaTb: string | null; quotaCounts: string },
  now = new Date(),
): Promise<QuotaUsage> {
  const p = billingPeriod(node.billingDay, now);
  const [row] = await db
    .select({
      rx: sql<string>`coalesce(sum(${schema.nodeDaily.rxBytes}), 0)`,
      tx: sql<string>`coalesce(sum(${schema.nodeDaily.txBytes}), 0)`,
    })
    .from(schema.nodeDaily)
    .where(and(eq(schema.nodeDaily.nodeId, node.id), gte(schema.nodeDaily.day, p.start), lt(schema.nodeDaily.day, p.end)));
  const rx = Number(row?.rx ?? 0);
  const tx = Number(row?.tx ?? 0);
  const counts = node.quotaCounts === 'txrx' ? 'txrx' : 'tx';
  const used = counts === 'txrx' ? rx + tx : tx;
  const limit = node.quotaTb === null ? null : Math.round(Number(node.quotaTb) * 1e12);
  return {
    periodStart: p.start,
    periodEnd: p.end,
    rxBytes: rx,
    txBytes: tx,
    usedBytes: used,
    limitBytes: limit,
    pct: limit ? (used / limit) * 100 : null,
    counts,
  };
}

/** Трафик за последние 24 часа — по сырым 15-секундным рядам. */
export async function traffic24h(db: DB, nodeId: string, now = new Date()): Promise<{ rx: number; tx: number }> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const [row] = await db
    .select({
      rx: sql<string>`coalesce(sum(${schema.nodeMetrics.rxBytes}), 0)`,
      tx: sql<string>`coalesce(sum(${schema.nodeMetrics.txBytes}), 0)`,
    })
    .from(schema.nodeMetrics)
    .where(and(eq(schema.nodeMetrics.nodeId, nodeId), eq(schema.nodeMetrics.res, 15), gte(schema.nodeMetrics.ts, since)));
  return { rx: Number(row?.rx ?? 0), tx: Number(row?.tx ?? 0) };
}
