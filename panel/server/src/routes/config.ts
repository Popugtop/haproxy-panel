import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { schema } from '../db/index.js';
import { actorOf, audit } from '../lib/audit.js';
import { applyToNode, confirmImport, ImportConfirmSchema, previewImport } from '../lib/applyconfig.js';
import { HttpError, notFound, parse, requireAuth } from '../lib/http.js';
import { configState, latestVersions, type NodeRow } from '../lib/routes.js';

const Id = z.object({ id: z.string().uuid() });
const ApplyBody = z.object({ expectedHash: z.string().length(64) });

export function configRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const auth = { preHandler: requireAuth };

  const load = async (id: string): Promise<NodeRow> => {
    const [n] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, id)).limit(1);
    if (!n) throw notFound('Нода не найдена');
    return n;
  };

  const brief = (v: { id: string; number: number; status: string; source: string; createdAt: Date; createdBy: string; finishedAt: Date | null; durationMs: number | null; output: string | null; sha256: string }) => ({
    id: v.id, number: v.number, status: v.status, source: v.source, createdAt: v.createdAt, createdBy: v.createdBy, finishedAt: v.finishedAt, durationMs: v.durationMs, output: v.output, sha256: v.sha256,
  });

  /** Состояние конфига ноды: что применено, что хочет панель, совпадает ли, история версий. */
  app.get('/api/nodes/:id/config', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const n = await load(id);
    const st = await configState(db, n);
    const versions = await latestVersions(db, id, 30);
    return {
      applied: st.applied && { ...st.applied, cfg: st.applied.cfg, sniMap: st.applied.sniMap },
      desired: { cfg: st.desired.cfg, sniMap: st.desired.sniMap, sha256: st.desired.sha256 },
      inSync: st.inSync,
      applyingNumber: st.applyingNumber,
      lastFailed: st.lastFailed && brief(st.lastFailed),
      drift: st.drift,
      importPending: st.importPending,
      versions: versions.map(brief),
      expected: st.applyingNumber ?? (versions[0] ? versions[0].number + (st.inSync ? 0 : 1) : 1),
    };
  });

  app.get('/api/nodes/:id/config/versions/:number', auth, async (req) => {
    const { id, number } = parse(z.object({ id: z.string().uuid(), number: z.coerce.number().int().min(1) }), req.params);
    await load(id);
    const v = (await latestVersions(db, id, 500)).find((x) => x.number === number);
    if (!v) throw notFound('Версия не найдена');
    return { version: { ...brief(v), cfg: v.cfg, sniMap: v.sniMap } };
  });

  /** Применение на ОДНУ ноду: у каждой ноды свой дифф, своя попытка и свой откат. */
  app.post('/api/nodes/:id/config/apply', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const { expectedHash } = parse(ApplyBody, req.body);
    const n = await load(id);
    const out = await applyToNode(ctx, n, actorOf(req), expectedHash, false);
    await audit(db, actorOf(req), 'config.apply', { type: 'node', id }, { version: out.version?.number ?? null, status: out.version?.status ?? 'failed', ok: out.ok }, req.ip);
    return { ok: out.ok, error: out.error, rolledBack: out.rolledBack, output: out.output, version: out.version && brief(out.version) };
  });

  app.post('/api/nodes/:id/config/validate', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const { expectedHash } = parse(ApplyBody, req.body);
    const n = await load(id);
    const out = await applyToNode(ctx, n, actorOf(req), expectedHash, true);
    return { ok: out.ok, error: out.error, output: out.output };
  });

  // ───── импорт существующего конфига ─────
  app.post('/api/nodes/:id/import/preview', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const n = await load(id);
    if (!ctx.registry.isOnline(id)) throw new HttpError(409, 'offline', 'Нода не на связи: агент не подключён.');
    return previewImport(ctx, n);
  });

  app.post('/api/nodes/:id/import/confirm', auth, async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(ImportConfirmSchema, req.body);
    const n = await load(id);
    const stats = await confirmImport(ctx, n, body, actorOf(req));
    await audit(db, actorOf(req), 'config.import', { type: 'node', id }, { ...stats, routes_total: body.routes.length }, req.ip);
    return stats;
  });

  app.post('/api/nodes/:id/import/skip', auth, async (req) => {
    const { id } = parse(Id, req.params);
    await load(id);
    await db.update(schema.nodes).set({ importDone: true }).where(eq(schema.nodes.id, id));
    await audit(db, actorOf(req), 'config.import_skipped', { type: 'node', id }, undefined, req.ip);
    return { ok: true };
  });
}
