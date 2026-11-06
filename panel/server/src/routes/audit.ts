import { and, desc, eq, gte, ilike, lt, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { parse, requireAuth } from '../lib/http.js';

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Курсор: id последней строки предыдущей страницы. */
  before: z.coerce.number().int().optional(),
  actor: z.string().max(64).optional(),
  /** Начало названия действия: «route», «settings.», «torrent.ban». */
  action: z.string().max(64).optional(),
  entityType: z.string().max(32).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().max(100).optional(),
});

const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function auditRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const auth = { preHandler: requireAuth };

  app.get('/api/audit', auth, async (req) => {
    const q = parse(Query, req.query);
    const t = schema.auditLog;
    const where = and(
      q.before ? lt(t.id, q.before) : undefined,
      q.actor ? eq(t.actor, q.actor) : undefined,
      q.action ? ilike(t.action, `${esc(q.action)}%`) : undefined,
      q.entityType ? eq(t.entityType, q.entityType) : undefined,
      q.from ? gte(t.at, new Date(q.from)) : undefined,
      q.to ? lte(t.at, new Date(q.to)) : undefined,
      q.q ? or(ilike(t.action, `%${esc(q.q)}%`), ilike(t.entityId, `%${esc(q.q)}%`), ilike(t.actor, `%${esc(q.q)}%`), sql`${t.diff}::text ilike ${`%${esc(q.q)}%`}`) : undefined,
    );
    const rows = await db.select().from(t).where(where).orderBy(desc(t.id)).limit(q.limit + 1);
    const more = rows.length > q.limit;
    return { entries: rows.slice(0, q.limit), next: more ? rows[q.limit - 1]!.id : null };
  });

  /** Значения для фильтров. */
  app.get('/api/audit/facets', auth, async () => {
    const t = schema.auditLog;
    const actors = await db.selectDistinct({ v: t.actor }).from(t).orderBy(t.actor).limit(100);
    const actions = await db.selectDistinct({ v: t.action }).from(t).orderBy(t.action).limit(300);
    return { actors: actors.map((x) => x.v), actions: actions.map((x) => x.v) };
  });
}
