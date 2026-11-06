import { clearAlert, raiseAlert } from './alerts.js';
import { ApplyResultSchema, ConfigDataSchema } from '@popug/protocol';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { type DB, schema } from '../db/index.js';
import type { Actor } from './audit.js';
import { pushChecks } from './checks.js';
import { HttpError } from './http.js';
import { parseHandConfig, type ImportPreview } from './importer.js';
import { stateHash } from './render.js';
import { cfgSha, desiredFor, loadRoutes, normalizeSnis, saveRoute, validateExit, validateRoute, type NodeRow, type VersionRow } from './routes.js';

const APPLY_TIMEOUT_MS = 90_000;

export interface ApplyOutcome {
  ok: boolean;
  version: VersionRow | null;
  error: string | null;
  output: string;
  rolledBack: boolean;
}

/** Применяет на ноду то, что панель сейчас хочет там видеть. expectedHash — хеш диффа, который видел пользователь. */
export async function applyToNode(ctx: Ctx, node: NodeRow, actor: Pick<Actor, 'login'>, expectedHash: string, validateOnly = false): Promise<ApplyOutcome> {
  const { db, registry } = ctx;
  const desired = await desiredFor(db, node);
  if (desired.sha256 !== expectedHash) throw new HttpError(409, 'changed', 'Маршруты изменились, пока открыт дифф. Обновите страницу и проверьте изменения заново.');
  if (!registry.isOnline(node.id)) throw new HttpError(409, 'offline', 'Нода не на связи: агент не подключён.');
  if (!registry.supports(node.id, 'apply_config')) throw new HttpError(409, 'agent_outdated', `Агент на «${node.name}» (версия ${node.agentVersion ?? '?'}) не умеет применять конфиг. Обновите его: запустите на мосту команду установки без токена.`);

  if (validateOnly) {
    const r = await registry.send(node.id, 'apply_config', { args: { version: 0, cfg: desired.cfg, sniMap: desired.sniMap, validateOnly: true }, timeoutMs: 60_000 });
    const data = ApplyResultSchema.safeParse(r.data);
    return { ok: r.ok, version: null, error: r.ok ? null : (r.error ?? 'проверка не удалась'), output: data.success ? data.data.output : '', rolledBack: false };
  }

  const busy = await db
    .select({ n: schema.configVersions.number })
    .from(schema.configVersions)
    .where(and(eq(schema.configVersions.nodeId, node.id), eq(schema.configVersions.status, 'applying'), sql`${schema.configVersions.createdAt} > now() - interval '3 minutes'`))
    .limit(1);
  if (busy.length) throw new HttpError(409, 'busy', `Применение версии ${busy[0]!.n} ещё идёт.`);

  const max = (await db.select({ max: sql<number>`coalesce(max(${schema.configVersions.number}), 0)` }).from(schema.configVersions).where(eq(schema.configVersions.nodeId, node.id)))[0]?.max ?? 0;
  const [ver] = await db
    .insert(schema.configVersions)
    .values({ nodeId: node.id, number: Number(max) + 1, cfg: desired.cfg, sniMap: desired.sniMap, sha256: desired.sha256, source: 'panel', status: 'applying', createdBy: actor.login })
    .returning();

  const r = await registry.send(node.id, 'apply_config', { args: { version: ver!.number, cfg: desired.cfg, sniMap: desired.sniMap, validateOnly: false }, timeoutMs: APPLY_TIMEOUT_MS });
  const data = ApplyResultSchema.safeParse(r.data);
  const d = data.success ? data.data : null;

  let status: string;
  let error: string | null = null;
  if (r.ok && d?.applied) status = 'applied';
  else if (d?.rollbackFailed) status = 'rollback_failed';
  else if (d?.rolledBack) status = 'rolled_back';
  else status = 'failed';
  if (status !== 'applied') error = r.error ?? 'применение не удалось';
  // Агент уже вложил причину в output; добавляем ошибку, только если её там нет.
  const output = [d?.output, r.ok || (d?.output && r.error && d.output.includes(r.error)) ? '' : r.error].filter(Boolean).join('\n\n');

  const [done] = await db
    .update(schema.configVersions)
    .set({ status, output: output || null, finishedAt: new Date(), durationMs: d?.durationMs ?? null })
    .where(eq(schema.configVersions.id, ver!.id))
    .returning();
  if (status === 'applied') await db.update(schema.nodes).set({ appliedVersionId: ver!.id, configSha256: cfgSha(desired.cfg) }).where(eq(schema.nodes.id, node.id));
  else if (d?.sha256) await db.update(schema.nodes).set({ configSha256: d.sha256 }).where(eq(schema.nodes.id, node.id));
  if (status === 'applied') await pushChecks(ctx, [node.id]);
  // Алерт «конфиг не применился» горит, пока на ноде не получится применить конфиг.
  if (status === 'applied') await clearAlert(ctx, 'config_failed', node.id).catch(() => undefined);
  else {
    const reason = status === 'rolled_back' ? 'Конфиг откачен на прежний' : status === 'rollback_failed' ? 'Откат не удался: проверьте ноду вручную' : 'Применение не удалось';
    await raiseAlert(ctx, { kind: 'config_failed', subject: node.id, label: node.name, severity: 'crit', message: `${reason} (версия ${ver!.number}): ${(error ?? '').split('\n')[0]}` }).catch(() => undefined);
  }
  return { ok: status === 'applied', version: done!, error, output, rolledBack: status === 'rolled_back' };
}

// ───────── импорт существующего конфига ─────────

export interface ImportPreviewDto {
  cfgSha256: string;
  path: string;
  preview: ImportPreview;
  /** По backend: что уже есть в панели. */
  matches: Record<string, { exitIds: (string | null)[]; routeId: string | null; routeName: string | null; sameSnis: boolean }>;
}

async function fetchNodeConfig(ctx: Ctx, nodeId: string) {
  const r = await ctx.registry.send(nodeId, 'get_config');
  if (!r.ok) throw new HttpError(502, 'agent_error', r.error ?? 'Агент не смог прочитать конфиг');
  const d = ConfigDataSchema.safeParse(r.data);
  if (!d.success) throw new HttpError(502, 'bad_agent_reply', 'Агент прислал конфиг в неожиданном формате');
  return d.data;
}

export async function previewImport(ctx: Ctx, node: NodeRow): Promise<ImportPreviewDto> {
  const cfg = await fetchNodeConfig(ctx, node.id);
  const preview = parseHandConfig(cfg.content);
  const all = await loadRoutes(ctx.db);
  const exits = await ctx.db.select().from(schema.exits);
  const matches: ImportPreviewDto['matches'] = {};
  for (const r of preview.routes) {
    const ex = all.find((x) => x.slug === r.slug) ?? null;
    matches[r.backend] = {
      exitIds: r.exits.map((e) => exits.find((x) => x.host === e.host && x.port === e.port)?.id ?? null),
      routeId: ex?.id ?? null,
      routeName: ex?.name ?? null,
      sameSnis: !!ex && JSON.stringify([...ex.snis].sort()) === JSON.stringify(r.snis),
    };
  }
  return { cfgSha256: cfgSha(cfg.content), path: cfg.path, preview, matches };
}

export const ImportConfirmSchema = z.object({
  cfgSha256: z.string().length(64),
  defaultBackend: z.string().nullable().default(null),
  routes: z
    .array(
      z.object({
        backend: z.string().max(128),
        slug: z.string().max(24),
        name: z.string().trim().min(1).max(120),
        snis: z.array(z.string().max(253)).max(50),
        proxyProtocol: z.boolean(),
        healthCheck: z.boolean(),
        /** Привязать эту ноду к уже существующему маршруту вместо создания нового. */
        attachToRouteId: z.string().uuid().nullable().default(null),
        exits: z.array(z.object({ host: z.string().max(255), port: z.number().int().min(1).max(65535), name: z.string().trim().min(1).max(80), country: z.string().regex(/^[A-Z]{2}$/).nullable().default(null) })).min(1).max(20),
      }),
    )
    .max(200),
});

export async function confirmImport(ctx: Ctx, node: NodeRow, body: z.infer<typeof ImportConfirmSchema>, actor: Pick<Actor, 'login'>): Promise<{ routes: number; attached: number; exits: number }> {
  const cfg = await fetchNodeConfig(ctx, node.id);
  if (cfgSha(cfg.content) !== body.cfgSha256) throw new HttpError(409, 'changed', 'Конфиг на ноде изменился после предпросмотра. Запустите импорт заново.');

  const stats = { routes: 0, attached: 0, exits: 0 };
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const routeIdByBackend = new Map<string, string>();
    for (const r of body.routes) {
      const snis = normalizeSnis(r.snis);
      if (r.attachToRouteId) {
        const [ex] = await loadRoutes(tx, { routeId: r.attachToRouteId });
        if (!ex) throw new HttpError(400, 'validation', `Маршрут для привязки (${r.slug}) не найден`);
        const nodeIds = [...new Set([...ex.nodeIds, node.id])];
        await validateRoute(tx, { name: ex.name, slug: ex.slug, snis: ex.snis, exitIds: ex.exits.map((e) => e.id), nodeIds, proxyProtocol: ex.proxyProtocol, healthCheck: ex.healthCheck, enabled: ex.enabled, limitMbit: ex.limitMbit, ipLimitMbit: ex.ipLimitMbit }, ex.id);
        await saveRoute(tx, { name: ex.name, slug: ex.slug, snis: ex.snis, exitIds: ex.exits.map((e) => e.id), nodeIds, proxyProtocol: ex.proxyProtocol, healthCheck: ex.healthCheck, enabled: ex.enabled, limitMbit: ex.limitMbit, ipLimitMbit: ex.ipLimitMbit }, ex.id);
        routeIdByBackend.set(r.backend, ex.id);
        stats.attached++;
        continue;
      }
      const exitIds: string[] = [];
      for (const e of r.exits) {
        const [found] = await tx.select().from(schema.exits).where(and(eq(schema.exits.host, e.host), eq(schema.exits.port, e.port)));
        if (found) {
          exitIds.push(found.id);
          continue;
        }
        await validateExit(tx, { name: e.name, country: e.country, host: e.host, port: e.port });
        const [created] = await tx.insert(schema.exits).values({ name: e.name, country: e.country, host: e.host, port: e.port }).returning();
        exitIds.push(created!.id);
        stats.exits++;
      }
      const input = { name: r.name, slug: r.slug, snis, exitIds, nodeIds: [node.id], proxyProtocol: r.proxyProtocol, healthCheck: r.healthCheck, enabled: true, limitMbit: null, ipLimitMbit: null };
      await validateRoute(tx, input);
      routeIdByBackend.set(r.backend, await saveRoute(tx, input));
      stats.routes++;
    }
    const max = (await tx.select({ max: sql<number>`coalesce(max(${schema.configVersions.number}), 0)` }).from(schema.configVersions).where(eq(schema.configVersions.nodeId, node.id)))[0]?.max ?? 0;
    const [ver] = await tx
      .insert(schema.configVersions)
      .values({ nodeId: node.id, number: Number(max) + 1, cfg: cfg.content, sniMap: '', sha256: stateHash(cfg.content, ''), source: 'import', status: 'imported', createdBy: actor.login, finishedAt: new Date(), output: 'Снимок ручного конфига, найденного на ноде при импорте.' })
      .returning();
    await tx
      .update(schema.nodes)
      .set({ appliedVersionId: ver!.id, configSha256: cfgSha(cfg.content), importDone: true, defaultRouteId: body.defaultBackend ? (routeIdByBackend.get(body.defaultBackend) ?? null) : null })
      .where(eq(schema.nodes.id, node.id));
  });
  await pushChecks(ctx, [node.id]);
  return stats;
}

export { desc, inArray };
