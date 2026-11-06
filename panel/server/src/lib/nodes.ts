import { and, eq, gte, sql } from 'drizzle-orm';
import { isIP } from 'node:net';
import { z } from 'zod';
import { type DB, schema } from '../db/index.js';
import type { LiveData } from '../db/schema.js';
import { quotaUsage, traffic24h, type QuotaUsage } from './quota.js';
import type { Registry } from './registry.js';

export type NodeRow = typeof schema.nodes.$inferSelect;
export type NodeStatus = 'pending' | 'online' | 'offline' | 'revoked';

export function nodeStatus(n: NodeRow, registry: Registry): NodeStatus {
  if (n.keyRevokedAt) return 'revoked';
  if (!n.keyHash) return 'pending';
  return registry.isOnline(n.id) ? 'online' : 'offline';
}

/** Поля ноды, безопасные для фронта: никаких хэшей ключей и токенов. */
export function publicNode(n: NodeRow, registry: Registry) {
  return {
    id: n.id,
    name: n.name,
    ip: n.ip,
    domain: n.domain,
    hoster: n.hoster,
    notes: n.notes,
    quotaTb: n.quotaTb === null ? null : Number(n.quotaTb),
    billingDay: n.billingDay,
    quotaCounts: n.quotaCounts as 'tx' | 'txrx',
    defaultIpLimitMbit: n.defaultIpLimitMbit,
    extraConfig: n.extraConfig,
    defaultRouteId: n.defaultRouteId,
    importDone: n.importDone,
    createdAt: n.createdAt,
    status: nodeStatus(n, registry),
    agentVersion: n.agentVersion,
    protocol: n.protocol,
    haproxyVersion: n.haproxyVersion,
    haproxyInstalled: n.haproxyInstalled,
    hostname: n.hostname,
    os: n.os,
    arch: n.arch,
    updateReady: n.updateReady,
    ops: n.ops ?? [],
    addrs: n.addrs ?? [],
    lastRemoteIp: n.lastRemoteIp,
    lastSeenAt: n.lastSeenAt,
    lastConnectedAt: n.lastConnectedAt,
    lastDisconnectedAt: n.lastDisconnectedAt,
    enrollPending: !!n.enrollTokenHash && !!n.enrollExpiresAt && n.enrollExpiresAt > new Date(),
    /** HAProxy >= 2.7 нужен для bwlim. null — версия неизвестна. */
    bwlimSupported: haproxyAtLeast(n.haproxyVersion, 2, 7),
  };
}

export function haproxyAtLeast(version: string | null, major: number, minor: number): boolean | null {
  const m = version?.match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}

export interface NodeSummary extends ReturnType<typeof publicNode> {
  live: {
    ts: number;
    rxBps: number;
    txBps: number;
    cpuPct: number | null;
    memUsedPct: number | null;
    load1: number;
    sessions: number;
    activeClients: number | null;
    backendsTotal: number;
    backendsDown: number;
    haproxyOk: boolean;
    haproxyError: string | null;
  } | null;
  quota: QuotaUsage;
  traffic24h: { rx: number; tx: number };
}

export function liveSummary(l: LiveData): NonNullable<NodeSummary['live']> {
  return {
    ts: l.ts,
    rxBps: l.sys.rxBps,
    txBps: l.sys.txBps,
    cpuPct: l.sys.cpuPct,
    memUsedPct: l.sys.memTotal ? (1 - l.sys.memAvail / l.sys.memTotal) * 100 : null,
    load1: l.sys.load1,
    sessions: l.sessions,
    activeClients: l.clients?.active ?? null,
    backendsTotal: l.backends.length,
    backendsDown: l.backends.filter((b) => b.status !== 'UP' && b.status !== 'OPEN').length,
    haproxyOk: l.haproxy.ok,
    haproxyError: l.haproxy.error,
  };
}

/** Данные live старше этого считаются устаревшими (агент молчит). */
export const LIVE_STALE_MS = 60_000;

export async function nodeSummaries(db: DB, registry: Registry, now = new Date()): Promise<NodeSummary[]> {
  const rows = await db.select().from(schema.nodes).orderBy(schema.nodes.name);
  const lives = await db.select().from(schema.nodeLive);
  const byId = new Map(lives.map((l) => [l.nodeId, l]));
  return Promise.all(
    rows.map(async (n) => {
      const l = byId.get(n.id);
      const status = nodeStatus(n, registry);
      const fresh = l && now.getTime() - l.ts.getTime() < LIVE_STALE_MS && status === 'online';
      return {
        ...publicNode(n, registry),
        live: l && fresh ? liveSummary(l.data) : null,
        quota: await quotaUsage(db, n, now),
        traffic24h: await traffic24h(db, n.id, now),
      };
    }),
  );
}

export interface BackendTraffic {
  backend: string;
  in24h: number;
  out24h: number;
  inPeriod: number;
  outPeriod: number;
}

export async function backendTraffic(db: DB, nodeId: string, periodStart: string, now = new Date()): Promise<BackendTraffic[]> {
  const since = new Date(now.getTime() - 24 * 3600e3);
  const bm = schema.backendMetrics;
  const bd = schema.backendDaily;
  const day = await db
    .select({ backend: bm.backend, i: sql<string>`sum(${bm.binBytes})`, o: sql<string>`sum(${bm.boutBytes})` })
    .from(bm)
    .where(and(eq(bm.nodeId, nodeId), eq(bm.res, 15), gte(bm.ts, since)))
    .groupBy(bm.backend);
  const period = await db
    .select({ backend: bd.backend, i: sql<string>`sum(${bd.binBytes})`, o: sql<string>`sum(${bd.boutBytes})` })
    .from(bd)
    .where(and(eq(bd.nodeId, nodeId), gte(bd.day, periodStart)))
    .groupBy(bd.backend);
  const map = new Map<string, BackendTraffic>();
  const get = (b: string) => map.get(b) ?? map.set(b, { backend: b, in24h: 0, out24h: 0, inPeriod: 0, outPeriod: 0 }).get(b)!;
  for (const r of day) Object.assign(get(r.backend), { in24h: Number(r.i), out24h: Number(r.o) });
  for (const r of period) Object.assign(get(r.backend), { inPeriod: Number(r.i), outPeriod: Number(r.o) });
  return [...map.values()].sort((a, b) => a.backend.localeCompare(b.backend));
}

const opt = <T extends z.ZodType>(t: T) => z.union([t, z.null()]).optional();
const text = (max: number) => z.string().trim().max(max).transform((s) => (s === '' ? null : s));

export const NodeInput = z.object({
  name: z.string().trim().min(1, 'Укажите имя').max(80),
  ip: opt(
    z
      .string()
      .trim()
      .max(45)
      .refine((s) => s === '' || isIP(s) !== 0, 'Некорректный IP-адрес')
      .transform((s) => (s === '' ? null : s)),
  ),
  domain: opt(text(255)),
  hoster: opt(text(80)),
  notes: opt(text(2000)),
  quotaTb: opt(z.number().positive().max(100000)),
  billingDay: z.number().int().min(1).max(31).optional(),
  quotaCounts: z.enum(['tx', 'txrx']).optional(),
  defaultIpLimitMbit: opt(z.number().int().positive().max(100000)),
  extraConfig: opt(z.string().max(20000)),
  defaultRouteId: opt(z.string().uuid()),
});
export type NodeInputT = z.infer<typeof NodeInput>;

export const toDbValues = (i: Partial<NodeInputT>) => {
  const { quotaTb, ...rest } = i;
  return { ...rest, ...(quotaTb !== undefined ? { quotaTb: quotaTb === null ? null : quotaTb.toFixed(2) } : {}) };
};
