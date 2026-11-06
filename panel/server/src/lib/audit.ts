import type { FastifyRequest } from 'fastify';
import { type DB, schema } from '../db/index.js';

export interface Actor {
  id: string | null;
  login: string;
}

export const SYSTEM: Actor = { id: null, login: 'system' };

export async function audit(
  db: DB,
  actor: Actor,
  action: string,
  entity?: { type: string; id: string },
  diff?: Record<string, unknown>,
  ip?: string | null,
): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorId: actor.id,
    actor: actor.login,
    action,
    entityType: entity?.type ?? null,
    entityId: entity?.id ?? null,
    diff: diff ?? null,
    ip: ip ?? null,
  });
}

/** Различия «было → стало» только по изменившимся полям. */
export function diffOf<T extends Record<string, unknown>>(before: T, after: Partial<T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}

export const actorOf = (req: FastifyRequest): Actor =>
  req.user ? { id: req.user.id, login: req.user.login } : { id: null, login: 'anonymous' };
