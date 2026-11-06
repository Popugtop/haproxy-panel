import { BansResultSchema } from '@popug/protocol';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { isIP } from 'node:net';
import type { Ctx } from '../app.js';
import { type DB, schema } from '../db/index.js';
import { HttpError } from './http.js';

export const MAX_BAN_SEC = 366 * 86400;

/** Нормализация IP: убираем ::ffff:, зону и регистр. null — не IP. */
export function normalizeIp(raw: string): string | null {
  let s = raw.trim().toLowerCase().replace(/%.*$/, '');
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) s = mapped[1]!;
  return isIP(s) === 0 ? null : s;
}

/** Адреса, которые банить нельзя ни при каких условиях. Причина или null. */
export function protectedReason(ip: string): string | null {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'частный адрес';
    if (a === 169 && b === 254) return 'link-local';
    if (a >= 224) return 'multicast или зарезервированный адрес';
    if (a === 0) return 'неопределённый адрес';
    return null;
  }
  const v = ip.toLowerCase();
  if (v === '::1') return 'loopback';
  if (v === '::') return 'неопределённый адрес';
  if (/^f[cd]/.test(v)) return 'частный адрес';
  if (/^fe[89ab]/.test(v)) return 'link-local';
  if (/^ff/.test(v)) return 'multicast';
  return null;
}

/** IP-адреса инфраструктуры: ноды и выходы. Забанить их значит отрезать свой же сервис. */
export async function infraIps(db: DB): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const n of await db.select({ name: schema.nodes.name, ip: schema.nodes.ip, addrs: schema.nodes.addrs }).from(schema.nodes)) {
    if (n.ip) out.set(n.ip, `нода «${n.name}»`);
    for (const a of n.addrs ?? []) out.set(a, `нода «${n.name}»`);
  }
  for (const e of await db.select({ name: schema.exits.name, host: schema.exits.host }).from(schema.exits)) out.set(e.host, `выход «${e.name}»`);
  return out;
}

export interface BanOutcome {
  nodeId: string;
  nodeName: string;
  /** Применено на ноде сейчас. false — нода офлайн: бан сохранён и уйдёт при подключении. */
  applied: boolean;
  error: string | null;
}

async function sendDelta(ctx: Ctx, nodeId: string, ban: { ip: string; ttlSec: number }[], unban: string[]): Promise<{ applied: boolean; error: string | null }> {
  if (!ctx.registry.isOnline(nodeId)) return { applied: false, error: null };
  if (!ctx.registry.supports(nodeId, 'apply_bans')) return { applied: false, error: 'агент не умеет баны: обновите его' };
  const r = await ctx.registry.send(nodeId, 'apply_bans', { args: { full: false, ban, unban }, timeoutMs: 20_000 });
  if (!r.ok) return { applied: false, error: r.error ?? 'агент отказал' };
  const d = BansResultSchema.safeParse(r.data);
  if (d.success && d.data.rejected.length) return { applied: false, error: d.data.rejected.map((x) => `${x.ip}: ${x.reason}`).join('; ') };
  return { applied: true, error: null };
}

export async function createBans(
  ctx: Ctx,
  input: { ip: string; nodeIds: string[]; durationSec: number; reason?: string; note?: string | null },
  actor: { login: string },
): Promise<{ ip: string; expiresAt: Date; outcomes: BanOutcome[] }> {
  const { db } = ctx;
  const ip = normalizeIp(input.ip);
  if (!ip) throw new HttpError(400, 'validation', 'Это не IP-адрес');
  const why = protectedReason(ip);
  if (why) throw new HttpError(400, 'protected_ip', `${ip}: ${why} — банить нельзя`);
  const infra = (await infraIps(db)).get(ip);
  if (infra) throw new HttpError(400, 'protected_ip', `${ip} — это ${infra}: бан отрезал бы собственную инфраструктуру`);
  if (!Number.isInteger(input.durationSec) || input.durationSec < 60 || input.durationSec > MAX_BAN_SEC) throw new HttpError(400, 'validation', 'Срок бана: от минуты до года');
  const nodes = await db.select().from(schema.nodes).where(inArray(schema.nodes.id, input.nodeIds));
  if (nodes.length === 0 || nodes.length !== new Set(input.nodeIds).size) throw new HttpError(400, 'validation', 'Выберите существующие ноды');

  const expiresAt = new Date(Date.now() + input.durationSec * 1000);
  const outcomes: BanOutcome[] = [];
  for (const n of nodes) {
    await db
      .insert(schema.bans)
      .values({ ip, nodeId: n.id, reason: input.reason ?? 'manual', note: input.note ?? null, createdBy: actor.login, expiresAt })
      .onConflictDoUpdate({ target: [schema.bans.ip, schema.bans.nodeId], set: { reason: input.reason ?? 'manual', note: input.note ?? null, createdBy: actor.login, createdAt: new Date(), expiresAt } });
    const r = await sendDelta(ctx, n.id, [{ ip, ttlSec: input.durationSec }], []);
    outcomes.push({ nodeId: n.id, nodeName: n.name, ...r });
  }
  return { ip, expiresAt, outcomes };
}

export async function removeBans(ctx: Ctx, where: { ids?: string[]; ip?: string; nodeIds?: string[] }): Promise<{ removed: number; outcomes: BanOutcome[] }> {
  const { db } = ctx;
  let rows = await db.select().from(schema.bans).where(where.ids ? inArray(schema.bans.id, where.ids) : eq(schema.bans.ip, where.ip ?? ''));
  if (where.nodeIds) rows = rows.filter((r) => where.nodeIds!.includes(r.nodeId));
  const outcomes: BanOutcome[] = [];
  const nodes = new Map((await db.select({ id: schema.nodes.id, name: schema.nodes.name }).from(schema.nodes)).map((n) => [n.id, n.name]));
  for (const r of rows) {
    await db.delete(schema.bans).where(eq(schema.bans.id, r.id));
    const res = await sendDelta(ctx, r.nodeId, [], [r.ip]);
    outcomes.push({ nodeId: r.nodeId, nodeName: nodes.get(r.nodeId) ?? '—', ...res });
  }
  return { removed: rows.length, outcomes };
}

export async function activeBans(db: DB, nodeId?: string) {
  return db
    .select({ id: schema.bans.id, ip: schema.bans.ip, nodeId: schema.bans.nodeId, nodeName: schema.nodes.name, reason: schema.bans.reason, note: schema.bans.note, createdBy: schema.bans.createdBy, createdAt: schema.bans.createdAt, expiresAt: schema.bans.expiresAt })
    .from(schema.bans)
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.bans.nodeId))
    .where(and(gt(schema.bans.expiresAt, new Date()), nodeId ? eq(schema.bans.nodeId, nodeId) : undefined))
    .orderBy(schema.bans.expiresAt);
}

/** Полная синхронизация набора банов ноды: при подключении агента (после перезагрузки сервера nft-таблицы нет). */
export async function fullSyncBans(ctx: Ctx, nodeId: string): Promise<void> {
  if (!ctx.registry.supports(nodeId, 'apply_bans')) return;
  const now = Date.now();
  const rows = (await activeBans(ctx.db, nodeId)).map((b) => ({ ip: b.ip, ttlSec: Math.max(1, Math.floor((b.expiresAt.getTime() - now) / 1000)) }));
  await ctx.registry.send(nodeId, 'apply_bans', { args: { full: true, ban: rows, unban: [] }, timeoutMs: 30_000 }).catch(() => undefined);
}

/** Истёкшие баны храним сутки (для истории), затем удаляем. */
export async function purgeExpiredBans(db: DB, nowMs = Date.now()): Promise<void> {
  await db.delete(schema.bans).where(lt(schema.bans.expiresAt, new Date(nowMs - 86400e3)));
}

export { sql };
