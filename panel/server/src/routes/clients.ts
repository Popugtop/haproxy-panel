import { ClientsDataSchema } from '@popug/protocol';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { actorOf, audit } from '../lib/audit.js';
import { activeBans, createBans, removeBans } from '../lib/bans.js';
import { HttpError, notFound, parse, requireAuth } from '../lib/http.js';
import { setLimits } from '../lib/limits.js';

const Id = z.object({ id: z.string().uuid() });
const NodeIds = z.array(z.string().uuid()).min(1).max(50);

export function clientRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, registry } = ctx;
  const auth = { preHandler: requireAuth };

  /**
   * Живая таблица клиентов по всем нодам (или одной). Берётся напрямую у агентов (get_clients), а не из снимка раз в 15 секунд;
   * если агент не ответил, показываем последний снимок с пометкой stale.
   */
  app.get('/api/clients', auth, async (req) => {
    const { nodeId } = parse(z.object({ nodeId: z.string().uuid().optional() }), req.query);
    const nodes = await db.select().from(schema.nodes).where(nodeId ? eq(schema.nodes.id, nodeId) : undefined).orderBy(schema.nodes.name);
    const bans = await db.select().from(schema.bans).where(gt(schema.bans.expiresAt, new Date()));
    const limits = await db.select().from(schema.ipLimits);
    const lives = new Map((await db.select().from(schema.nodeLive)).map((l) => [l.nodeId, l]));

    const perNode = await Promise.all(
      nodes.map(async (n) => {
        const meta = { id: n.id, name: n.name, online: registry.isOnline(n.id), live: false, stale: false, error: null as string | null, tracked: 0, active: 0 };
        let data: ReturnType<typeof ClientsDataSchema.parse> | null = null;
        if (meta.online && registry.supports(n.id, 'get_clients')) {
          const r = await registry.send(n.id, 'get_clients', { timeoutMs: 4000 });
          const d = ClientsDataSchema.safeParse(r.data);
          if (r.ok && d.success) {
            data = d.data;
            meta.live = true;
          } else meta.error = r.error ?? 'агент прислал неожиданный ответ';
        } else if (meta.online) meta.error = 'агент не умеет отдавать клиентов: обновите его';
        if (!data) {
          const l = lives.get(n.id)?.data.clients;
          if (l) {
            data = { tracked: l.tracked, active: l.active, top: l.top };
            meta.stale = true;
          }
        }
        meta.tracked = data?.tracked ?? 0;
        meta.active = data?.active ?? 0;
        const rows = (data?.top ?? []).map((c) => {
          const ban = bans.find((b) => b.ip === c.ip && b.nodeId === n.id);
          const lim = limits.find((l) => l.ip === c.ip && l.nodeId === n.id);
          return {
            ...c,
            nodeId: n.id,
            nodeName: n.name,
            ban: ban ? { id: ban.id, expiresAt: ban.expiresAt, reason: ban.reason } : null,
            limit: lim ? { id: lim.id, mbit: lim.mbit } : null,
          };
        });
        return { meta, rows };
      }),
    );
    return { nodes: perNode.map((p) => p.meta), rows: perNode.flatMap((p) => p.rows), at: Date.now() };
  });

  // ───── баны ─────
  app.get('/api/bans', auth, async () => ({ bans: await activeBans(db) }));

  app.post('/api/bans', auth, async (req, reply) => {
    const b = parse(z.object({ ip: z.string().max(64), nodeIds: NodeIds, durationSec: z.number().int(), note: z.string().trim().max(200).nullable().optional() }), req.body);
    const r = await createBans(ctx, { ip: b.ip, nodeIds: b.nodeIds, durationSec: b.durationSec, note: b.note ?? null }, actorOf(req));
    await audit(db, actorOf(req), 'ban.create', { type: 'ip', id: r.ip }, { nodes: r.outcomes.map((o) => o.nodeName), durationSec: b.durationSec, reason: 'manual' }, req.ip);
    reply.code(201);
    return r;
  });

  app.delete('/api/bans/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const r = await removeBans(ctx, { ids: [id] });
    if (r.removed === 0) throw notFound('Бан не найден');
    await audit(db, actorOf(req), 'ban.remove', { type: 'ban', id }, { nodes: r.outcomes.map((o) => o.nodeName) }, req.ip);
    return r;
  });

  /** Разбан IP сразу на нескольких нодах (или на всех, где он забанен). */
  app.post('/api/bans/unban', auth, async (req) => {
    const b = parse(z.object({ ip: z.string().max(64), nodeIds: NodeIds.optional() }), req.body);
    const r = await removeBans(ctx, { ip: b.ip.trim().toLowerCase(), nodeIds: b.nodeIds });
    if (r.removed === 0) throw notFound('Такого бана нет');
    await audit(db, actorOf(req), 'ban.remove', { type: 'ip', id: b.ip }, { nodes: r.outcomes.map((o) => o.nodeName) }, req.ip);
    return r;
  });

  // ───── персональные лимиты скорости ─────
  app.get('/api/limits', auth, async () => {
    const rows = await db
      .select({ id: schema.ipLimits.id, ip: schema.ipLimits.ip, nodeId: schema.ipLimits.nodeId, nodeName: schema.nodes.name, mbit: schema.ipLimits.mbit, note: schema.ipLimits.note, createdBy: schema.ipLimits.createdBy, createdAt: schema.ipLimits.createdAt })
      .from(schema.ipLimits)
      .innerJoin(schema.nodes, eq(schema.nodes.id, schema.ipLimits.nodeId))
      .orderBy(schema.ipLimits.ip);
    return { limits: rows };
  });

  app.post('/api/limits', auth, async (req, reply) => {
    const b = parse(z.object({ ip: z.string().max(64), nodeIds: NodeIds, mbit: z.number().int(), note: z.string().trim().max(200).nullable().optional() }), req.body);
    const r = await setLimits(ctx, { ip: b.ip, nodeIds: b.nodeIds, mbit: b.mbit, note: b.note ?? null }, actorOf(req));
    await audit(db, actorOf(req), 'limit.set', { type: 'ip', id: r.ip }, { mbit: b.mbit, nodes: r.nodes.map((n) => n.nodeName) }, req.ip);
    reply.code(201);
    // Лимит попадает на ноду вместе с конфигом: UI предложит применить.
    return { ...r, needsApply: true };
  });

  app.delete('/api/limits/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const [row] = await db.select().from(schema.ipLimits).where(eq(schema.ipLimits.id, id));
    if (!row) throw notFound('Лимит не найден');
    await db.delete(schema.ipLimits).where(eq(schema.ipLimits.id, id));
    await audit(db, actorOf(req), 'limit.remove', { type: 'ip', id: row.ip }, { mbit: row.mbit, nodeId: row.nodeId }, req.ip);
    return { ok: true, needsApply: true, nodeId: row.nodeId };
  });

  void and;
  void inArray;
  void HttpError;
}
