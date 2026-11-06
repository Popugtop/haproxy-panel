import { CloseCode, ConfigDataSchema } from '@popug/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { actorOf, audit, diffOf } from '../lib/audit.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { HttpError, notFound, parse, requireAuth } from '../lib/http.js';
import {
  backendTraffic, liveSummary, LIVE_STALE_MS, NodeInput, nodeStatus, nodeSummaries, publicNode, toDbValues, type NodeRow,
} from '../lib/nodes.js';
import { quotaUsage, traffic24h } from '../lib/quota.js';
import { forbiddenDirectives } from '../lib/render.js';
import { RANGES, fleetSeries, nodeSeries, type RangeKey } from '../lib/series.js';

export const ENROLL_TTL_MS = 24 * 3600e3;

const Id = z.object({ id: z.string().uuid() });
const SeriesQuery = z.object({ range: z.enum(Object.keys(RANGES) as [RangeKey, ...RangeKey[]]).default('6h') });

export function nodeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config, registry } = ctx;
  const auth = { preHandler: requireAuth };

  const load = async (id: string): Promise<NodeRow> => {
    const [n] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, id)).limit(1);
    if (!n) throw notFound('Нода не найдена');
    return n;
  };

  /** Новый одноразовый токен (прежний перестаёт действовать). Показывается один раз. */
  const issueEnrollment = async (nodeId: string) => {
    const token = randomToken('enr', 24);
    const expiresAt = new Date(Date.now() + ENROLL_TTL_MS);
    await db.update(schema.nodes).set({ enrollTokenHash: sha256Hex(token), enrollExpiresAt: expiresAt }).where(eq(schema.nodes.id, nodeId));
    return { token, expiresAt, command: `curl -fsSL ${config.publicUrl}/install.sh | bash -s -- ${token}` };
  };

  app.get('/api/nodes', auth, async () => ({ nodes: await nodeSummaries(db, registry) }));

  app.get('/api/overview/traffic', auth, async () => fleetSeries(db));

  app.post('/api/nodes', auth, async (req, reply) => {
    const input = parse(NodeInput, req.body);
    const [n] = await db.insert(schema.nodes).values({ ...toDbValues(input), name: input.name }).returning();
    await audit(db, actorOf(req), 'node.create', { type: 'node', id: n!.id }, { name: n!.name }, req.ip);
    const enrollment = await issueEnrollment(n!.id);
    await audit(db, actorOf(req), 'node.enrollment_token', { type: 'node', id: n!.id }, undefined, req.ip);
    reply.code(201);
    return { node: publicNode((await load(n!.id)), registry), enrollment };
  });

  app.get('/api/nodes/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const n = await load(id);
    const now = new Date();
    const [live] = await db.select().from(schema.nodeLive).where(eq(schema.nodeLive.nodeId, id));
    const status = nodeStatus(n, registry);
    const fresh = !!live && status === 'online' && now.getTime() - live.ts.getTime() < LIVE_STALE_MS;
    const quota = await quotaUsage(db, n, now);
    return {
      node: publicNode(n, registry),
      summary: live && fresh ? liveSummary(live.data) : null,
      /** Последний известный снимок. Для офлайн-ноды показываем его с пометкой, а не прячем. */
      live: live ? { ...live.data, stale: !fresh } : null,
      quota,
      traffic24h: await traffic24h(db, id, now),
      backendTraffic: await backendTraffic(db, id, quota.periodStart, now),
    };
  });

  app.get('/api/nodes/:id/series', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const { range } = parse(SeriesQuery, req.query);
    await load(id);
    return nodeSeries(db, id, range);
  });

  app.patch('/api/nodes/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const patch = parse(NodeInput.partial(), req.body);
    const before = await load(id);
    if (patch.extraConfig) {
      const bad = forbiddenDirectives(patch.extraConfig);
      if (bad.length) throw new HttpError(400, 'forbidden_directive', `В своих директивах запрещено: ${bad.join('; ')}`);
    }
    if (patch.defaultRouteId) {
      const [link] = await db.select().from(schema.routeNodes).where(and(eq(schema.routeNodes.nodeId, id), eq(schema.routeNodes.routeId, patch.defaultRouteId)));
      if (!link) throw new HttpError(400, 'validation', 'Маршрут по умолчанию должен быть привязан к этой ноде');
    }
    const values = toDbValues(patch);
    if (Object.keys(values).length > 0) await db.update(schema.nodes).set(values).where(eq(schema.nodes.id, id));
    const after = await load(id);
    const pick = (n: NodeRow) => Object.fromEntries(Object.keys(values).map((k) => [k, (n as Record<string, unknown>)[k]]));
    await audit(db, actorOf(req), 'node.update', { type: 'node', id }, diffOf(pick(before), pick(after)), req.ip);
    return { node: publicNode(after, registry) };
  });

  app.post('/api/nodes/:id/enrollment', auth, async (req) => {
    const { id } = parse(Id, req.params);
    await load(id);
    const enrollment = await issueEnrollment(id);
    await audit(db, actorOf(req), 'node.enrollment_token', { type: 'node', id }, undefined, req.ip);
    return { enrollment };
  });

  app.post('/api/nodes/:id/revoke', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const n = await load(id);
    if (!n.keyHash) throw new HttpError(409, 'no_key', 'У ноды нет активного ключа');
    await db.update(schema.nodes).set({ keyRevokedAt: new Date(), enrollTokenHash: null, enrollExpiresAt: null }).where(eq(schema.nodes.id, id));
    registry.close(id, CloseCode.KeyRevoked, 'ключ отозван');
    await audit(db, actorOf(req), 'node.revoke_key', { type: 'node', id }, { name: n.name }, req.ip);
    return { node: publicNode(await load(id), registry) };
  });

  app.delete('/api/nodes/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const n = await load(id);
    registry.close(id, CloseCode.KeyRevoked, 'нода удалена');
    await db.delete(schema.nodes).where(eq(schema.nodes.id, id));
    ctx.ingestor.forget(id);
    await audit(db, actorOf(req), 'node.delete', { type: 'node', id }, { name: n.name }, req.ip);
    return { ok: true };
  });

  /** Текущий haproxy.cfg ноды (операция get_config). Только чтение. */
  app.post('/api/nodes/:id/fetch-config', auth, async (req) => {
    const { id } = parse(Id, req.params);
    await load(id);
    const r = await registry.send(id, 'get_config');
    if (!r.ok) throw new HttpError(502, 'agent_error', r.error ?? 'Агент не смог прочитать конфиг');
    const data = ConfigDataSchema.safeParse(r.data);
    if (!data.success) throw new HttpError(502, 'bad_agent_reply', 'Агент прислал конфиг в неожиданном формате');
    return data.data;
  });
}
