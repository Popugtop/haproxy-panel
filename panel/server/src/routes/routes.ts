import { RunChecksDataSchema } from '@popug/protocol';
import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { actorOf, audit, diffOf } from '../lib/audit.js';
import { checkHistory, ingestAgentChecks, pairStatuses, pushChecks, runPanelChecks, worst } from '../lib/checks.js';
import { HttpError, notFound, parse, requireAuth } from '../lib/http.js';
import { configState, countRoutesOfExit, loadRoutes, nodesOfExit, normalizeSnis, saveRoute, validateExit, validateRoute, type RouteFull } from '../lib/routes.js';

const Id = z.object({ id: z.string().uuid() });
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Код страны из двух букв, например DE').nullable().optional();

const exitFields = {
  name: z.string().trim().min(1, 'Укажите имя').max(80),
  country,
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
};
const ExitCreate = z.object({ ...exitFields, port: exitFields.port.default(443) });
/** Для PATCH — без default: иначе непереданное поле молча сбросилось бы к значению по умолчанию. */
const ExitPatch = z.object(exitFields).partial();

const routeFields = {
  name: z.string().trim().min(1, 'Укажите название').max(120),
  slug: z.string().trim().toLowerCase().max(24),
  snis: z.array(z.string().max(253)).max(50),
  exitIds: z.array(z.string().uuid()).max(20),
  nodeIds: z.array(z.string().uuid()).max(50),
  proxyProtocol: z.boolean(),
  healthCheck: z.boolean(),
  enabled: z.boolean(),
  limitMbit: z.number().int().min(1).max(100_000).nullable(),
  ipLimitMbit: z.number().int().min(1).max(100_000).nullable(),
};
const RouteCreate = z.object({
  ...routeFields,
  snis: routeFields.snis.default([]),
  exitIds: routeFields.exitIds.default([]),
  nodeIds: routeFields.nodeIds.default([]),
  proxyProtocol: routeFields.proxyProtocol.default(true),
  healthCheck: routeFields.healthCheck.default(true),
  enabled: routeFields.enabled.default(true),
  limitMbit: routeFields.limitMbit.default(null),
  ipLimitMbit: routeFields.ipLimitMbit.default(null),
});
const RoutePatch = z.object(routeFields).partial();

export function routeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, registry } = ctx;
  const auth = { preHandler: requireAuth };

  // ───── выходы ─────
  app.get('/api/exits', auth, async () => {
    const list = await db.select().from(schema.exits).orderBy(schema.exits.name);
    const used = await db.select({ exitId: schema.routeExits.exitId, routeId: schema.routeExits.routeId }).from(schema.routeExits);
    return { exits: list.map((e) => ({ ...e, routes: used.filter((u) => u.exitId === e.id).length })) };
  });

  app.post('/api/exits', auth, async (req, reply) => {
    const b = parse(ExitCreate, req.body);
    const value = { name: b.name, country: b.country ?? null, host: b.host.toLowerCase(), port: b.port };
    await validateExit(db, value);
    const [e] = await db.insert(schema.exits).values(value).returning();
    await audit(db, actorOf(req), 'exit.create', { type: 'exit', id: e!.id }, { ...value }, req.ip);
    reply.code(201);
    return { exit: e };
  });

  app.patch('/api/exits/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const b = parse(ExitPatch, req.body);
    const [before] = await db.select().from(schema.exits).where(eq(schema.exits.id, id));
    if (!before) throw notFound('Выход не найден');
    const value = { name: b.name ?? before.name, country: b.country === undefined ? before.country : b.country, host: (b.host ?? before.host).toLowerCase(), port: b.port ?? before.port };
    await validateExit(db, value, id);
    const [e] = await db.update(schema.exits).set(value).where(eq(schema.exits.id, id)).returning();
    await audit(db, actorOf(req), 'exit.update', { type: 'exit', id }, diffOf(before, value), req.ip);
    await pushChecks(ctx, await nodesOfExit(db, id));
    return { exit: e, affectedNodes: (await nodesOfExit(db, id)).length };
  });

  app.delete('/api/exits/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const [e] = await db.select().from(schema.exits).where(eq(schema.exits.id, id));
    if (!e) throw notFound('Выход не найден');
    const used = await countRoutesOfExit(db, id);
    if (used.length) throw new HttpError(409, 'in_use', `Выход используется в маршрутах: ${used.map((u) => u.name).join(', ')}. Сначала уберите его оттуда.`);
    await db.delete(schema.exits).where(eq(schema.exits.id, id));
    await audit(db, actorOf(req), 'exit.delete', { type: 'exit', id }, { name: e.name, host: e.host, port: e.port }, req.ip);
    return { ok: true };
  });

  // ───── маршруты ─────
  const withStatus = async (routes: RouteFull[]) => {
    const pairs = await pairStatuses(db, { routeIds: routes.map((r) => r.id) });
    const nodes = await db.select().from(schema.nodes);
    const states = new Map<string, Awaited<ReturnType<typeof configState>>>();
    for (const n of nodes) if (routes.some((r) => r.nodeIds.includes(n.id))) states.set(n.id, await configState(db, n));
    return routes.map((r) => {
      const perNode = r.nodeIds.map((nodeId) => {
        const p = pairs.find((x) => x.routeId === r.id && x.nodeId === nodeId);
        const n = nodes.find((x) => x.id === nodeId);
        const st = states.get(nodeId);
        return {
          nodeId,
          nodeName: n?.name ?? '—',
          tone: p?.tone ?? 'unknown',
          reason: p?.reason ?? 'нет результатов проверок',
          lastAt: p?.lastAt ?? null,
          avgMs: p?.avgMs ?? null,
          /** Изменения этого маршрута ещё не применены на ноде. */
          pendingApply: st ? !st.inSync : false,
          online: n ? registry.isOnline(n.id) : false,
        };
      });
      return { ...r, status: r.enabled ? worst(perNode.map((p) => p.tone)) : 'unknown', nodes: perNode };
    });
  };

  app.get('/api/routes', auth, async () => ({ routes: await withStatus(await loadRoutes(db)) }));

  app.get('/api/nodes/:id/routes', auth, async (req) => {
    const { id } = parse(Id, req.params);
    return { routes: await withStatus(await loadRoutes(db, { nodeId: id })) };
  });

  app.get('/api/routes/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const [r] = await loadRoutes(db, { routeId: id });
    if (!r) throw notFound('Маршрут не найден');
    const [route] = await withStatus([r]);
    return { route, history: await checkHistory(db, id, { limit: 100 }) };
  });

  const touchedNodes = (a: string[], b: string[]) => [...new Set([...a, ...b])];

  app.post('/api/routes', auth, async (req, reply) => {
    const b = parse(RouteCreate, req.body);
    const input = { ...b, snis: normalizeSnis(b.snis) };
    await validateRoute(db, input);
    const id = await saveRoute(db, input);
    await audit(db, actorOf(req), 'route.create', { type: 'route', id }, { slug: input.slug, name: input.name, snis: input.snis, exits: input.exitIds, nodes: input.nodeIds }, req.ip);
    await pushChecks(ctx, input.nodeIds);
    reply.code(201);
    const [r] = await withStatus((await loadRoutes(db, { routeId: id })));
    return { route: r };
  });

  app.patch('/api/routes/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const [before] = await loadRoutes(db, { routeId: id });
    if (!before) throw notFound('Маршрут не найден');
    const b = parse(RoutePatch, req.body);
    const input = {
      name: b.name ?? before.name,
      slug: b.slug ?? before.slug,
      snis: normalizeSnis(b.snis ?? before.snis),
      exitIds: b.exitIds ?? before.exits.map((e) => e.id),
      nodeIds: b.nodeIds ?? before.nodeIds,
      proxyProtocol: b.proxyProtocol ?? before.proxyProtocol,
      healthCheck: b.healthCheck ?? before.healthCheck,
      enabled: b.enabled ?? before.enabled,
      limitMbit: b.limitMbit === undefined ? before.limitMbit : b.limitMbit,
      ipLimitMbit: b.ipLimitMbit === undefined ? before.ipLimitMbit : b.ipLimitMbit,
    };
    await validateRoute(db, input, id);
    await saveRoute(db, input, id);
    // Если маршрут сняли с ноды, он не может оставаться на ней маршрутом по умолчанию.
    const removed = before.nodeIds.filter((n) => !input.nodeIds.includes(n));
    if (removed.length) await db.update(schema.nodes).set({ defaultRouteId: null }).where(inArray(schema.nodes.id, removed));
    const beforeView = { name: before.name, slug: before.slug, snis: before.snis, exits: before.exits.map((e) => e.id), nodes: before.nodeIds, proxyProtocol: before.proxyProtocol, healthCheck: before.healthCheck, enabled: before.enabled, limitMbit: before.limitMbit, ipLimitMbit: before.ipLimitMbit };
    const afterView = { name: input.name, slug: input.slug, snis: input.snis, exits: input.exitIds, nodes: input.nodeIds, proxyProtocol: input.proxyProtocol, healthCheck: input.healthCheck, enabled: input.enabled, limitMbit: input.limitMbit, ipLimitMbit: input.ipLimitMbit };
    await audit(db, actorOf(req), 'route.update', { type: 'route', id }, diffOf(beforeView, afterView), req.ip);
    await pushChecks(ctx, touchedNodes(before.nodeIds, input.nodeIds));
    const [r] = await withStatus(await loadRoutes(db, { routeId: id }));
    return { route: r };
  });

  app.delete('/api/routes/:id', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const [r] = await loadRoutes(db, { routeId: id });
    if (!r) throw notFound('Маршрут не найден');
    await db.update(schema.nodes).set({ defaultRouteId: null }).where(eq(schema.nodes.defaultRouteId, id));
    await db.delete(schema.routes).where(eq(schema.routes.id, id));
    await audit(db, actorOf(req), 'route.delete', { type: 'route', id }, { slug: r.slug, name: r.name, nodes: r.nodeIds }, req.ip);
    await pushChecks(ctx, r.nodeIds);
    return { ok: true, affectedNodes: r.nodeIds };
  });

  // ───── проверки ─────
  /** Ручной запуск: агент проверяет выходы, панель — мост снаружи. */
  const runForNode = async (nodeId: string) => {
    let agent = 0;
    if (registry.isOnline(nodeId)) {
      const r = await registry.send(nodeId, 'run_checks', { timeoutMs: 40_000 });
      const d = RunChecksDataSchema.safeParse(r.data);
      if (r.ok && d.success) agent = await ingestAgentChecks(db, nodeId, d.data.results);
    }
    const panel = await runPanelChecks(db, nodeId, ctx.probe);
    return { agent, panel };
  };

  /** Последние результаты проверок по маршрутам ноды. */
  app.get('/api/nodes/:id/checks', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const rows = await db
      .select({ ts: schema.checkResults.ts, routeId: schema.checkResults.routeId, routeName: schema.routes.name, exitId: schema.checkResults.exitId, source: schema.checkResults.source, ok: schema.checkResults.ok, ms: schema.checkResults.ms, error: schema.checkResults.error })
      .from(schema.checkResults)
      .innerJoin(schema.routes, eq(schema.routes.id, schema.checkResults.routeId))
      .where(eq(schema.checkResults.nodeId, id))
      .orderBy(desc(schema.checkResults.ts))
      .limit(120);
    return { results: rows };
  });

  app.post('/api/nodes/:id/checks/run', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const [n] = await db.select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.id, id));
    if (!n) throw notFound('Нода не найдена');
    return runForNode(id);
  });

  app.post('/api/routes/:id/checks/run', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const [r] = await loadRoutes(db, { routeId: id });
    if (!r) throw notFound('Маршрут не найден');
    const results = await Promise.all(r.nodeIds.map(runForNode));
    return { nodes: r.nodeIds.length, results: results.reduce((a, x) => a + x.agent + x.panel, 0) };
  });
}
