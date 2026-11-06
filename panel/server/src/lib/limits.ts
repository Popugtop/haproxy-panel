import { eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { normalizeIp, infraIps } from './bans.js';
import { HttpError } from './http.js';
import { haproxyAtLeast } from './nodes.js';

export interface LimitOutcome {
  nodeId: string;
  nodeName: string;
}

/**
 * Персональный лимит скорости клиента. В отличие от банов, он живёт в конфиге HAProxy (bwlim, нужен HAProxy ≥ 2.7),
 * поэтому попадает на ноду обычным применением конфига: после сохранения у ноды появляется неприменённое изменение.
 */
export async function setLimits(ctx: Ctx, input: { ip: string; nodeIds: string[]; mbit: number; note?: string | null }, actor: { login: string }): Promise<{ ip: string; nodes: LimitOutcome[] }> {
  const { db } = ctx;
  const ip = normalizeIp(input.ip);
  if (!ip) throw new HttpError(400, 'validation', 'Это не IP-адрес');
  if ((await infraIps(db)).has(ip)) throw new HttpError(400, 'protected_ip', `${ip} — адрес собственной инфраструктуры`);
  if (!Number.isInteger(input.mbit) || input.mbit < 1 || input.mbit > 100_000) throw new HttpError(400, 'validation', 'Лимит: от 1 до 100 000 Мбит/с');
  const nodes = await db.select().from(schema.nodes).where(inArray(schema.nodes.id, input.nodeIds));
  if (nodes.length === 0 || nodes.length !== new Set(input.nodeIds).size) throw new HttpError(400, 'validation', 'Выберите существующие ноды');
  for (const n of nodes) {
    if (haproxyAtLeast(n.haproxyVersion, 2, 7) !== true) {
      throw new HttpError(409, 'bwlim_unsupported', `На ноде «${n.name}» HAProxy ${n.haproxyVersion ?? 'неизвестной версии'}: лимиты скорости работают с версии 2.7. Обновите HAProxy.`);
    }
    const others = (await db.select({ ip: schema.ipLimits.ip }).from(schema.ipLimits).where(eq(schema.ipLimits.nodeId, n.id))).filter((l) => l.ip !== ip);
    if (others.length >= 300) throw new HttpError(409, 'too_many', 'Не больше 300 персональных лимитов на ноду');
  }
  for (const n of nodes) {
    await db
      .insert(schema.ipLimits)
      .values({ ip, nodeId: n.id, mbit: input.mbit, note: input.note ?? null, createdBy: actor.login })
      .onConflictDoUpdate({ target: [schema.ipLimits.ip, schema.ipLimits.nodeId], set: { mbit: input.mbit, note: input.note ?? null, createdBy: actor.login, createdAt: new Date() } });
  }
  return { ip, nodes: nodes.map((n) => ({ nodeId: n.id, nodeName: n.name })) };
}
