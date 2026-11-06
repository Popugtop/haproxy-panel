import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { type DB, schema } from '../db/index.js';
import { HttpError } from './http.js';
import { haproxyAtLeast } from './nodes.js';
import { isValidHost, renderConfig, SLUG_RE, SNI_RE, sha256, type RenderRoute, type Rendered } from './render.js';

export type NodeRow = typeof schema.nodes.$inferSelect;
export type VersionRow = typeof schema.configVersions.$inferSelect;

export interface ExitDto {
  id: string;
  name: string;
  country: string | null;
  host: string;
  port: number;
}

export interface RouteFull {
  id: string;
  name: string;
  slug: string;
  snis: string[];
  proxyProtocol: boolean;
  healthCheck: boolean;
  enabled: boolean;
  limitMbit: number | null;
  ipLimitMbit: number | null;
  exits: ExitDto[];
  nodeIds: string[];
}

export async function loadRoutes(db: DB, only?: { nodeId?: string; routeId?: string }): Promise<RouteFull[]> {
  let routeIds: string[] | undefined;
  if (only?.nodeId) {
    routeIds = (await db.select({ id: schema.routeNodes.routeId }).from(schema.routeNodes).where(eq(schema.routeNodes.nodeId, only.nodeId))).map((r) => r.id);
    if (routeIds.length === 0) return [];
  }
  if (only?.routeId) routeIds = [only.routeId];
  const rows = await db.select().from(schema.routes).where(routeIds ? inArray(schema.routes.id, routeIds) : undefined).orderBy(schema.routes.slug);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const re = await db
    .select({ routeId: schema.routeExits.routeId, position: schema.routeExits.position, e: schema.exits })
    .from(schema.routeExits)
    .innerJoin(schema.exits, eq(schema.exits.id, schema.routeExits.exitId))
    .where(inArray(schema.routeExits.routeId, ids))
    .orderBy(schema.routeExits.position);
  const rn = await db.select().from(schema.routeNodes).where(inArray(schema.routeNodes.routeId, ids));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    snis: r.snis,
    proxyProtocol: r.proxyProtocol,
    healthCheck: r.healthCheck,
    enabled: r.enabled,
    limitMbit: r.limitMbit,
    ipLimitMbit: r.ipLimitMbit,
    exits: re.filter((x) => x.routeId === r.id).map((x) => ({ id: x.e.id, name: x.e.name, country: x.e.country, host: x.e.host, port: x.e.port })),
    nodeIds: rn.filter((x) => x.routeId === r.id).map((x) => x.nodeId),
  }));
}

const toRender = (r: RouteFull): RenderRoute => ({
  slug: r.slug,
  name: r.name,
  snis: r.snis,
  proxyProtocol: r.proxyProtocol,
  healthCheck: r.healthCheck,
  enabled: r.enabled,
  exits: r.exits.map((e) => ({ host: e.host, port: e.port })),
  limitMbit: r.limitMbit,
  ipLimitMbit: r.ipLimitMbit,
});

/** Конфиг, который панель хочет видеть на ноде прямо сейчас. */
export async function desiredFor(db: DB, node: NodeRow): Promise<Rendered> {
  const routes = await loadRoutes(db, { nodeId: node.id });
  const def = node.defaultRouteId ? routes.find((r) => r.id === node.defaultRouteId) : undefined;
  // Лимиты скорости (bwlim) — только на HAProxy ≥ 2.7; на остальных настройки молча гасятся, как и предусмотрено ТЗ.
  const limits = haproxyAtLeast(node.haproxyVersion, 2, 7) === true ? await db.select({ ip: schema.ipLimits.ip, mbit: schema.ipLimits.mbit }).from(schema.ipLimits).where(eq(schema.ipLimits.nodeId, node.id)) : [];
  const bwlim = haproxyAtLeast(node.haproxyVersion, 2, 7) === true ? { defaultMbit: node.defaultIpLimitMbit, limits } : null;
  return renderConfig({ routes: routes.map(toRender), defaultSlug: def?.slug ?? null, extraConfig: node.extraConfig, bwlim });
}

export const cfgSha = (cfg: string): string => sha256(cfg);

export async function latestVersions(db: DB, nodeId: string, limit = 30): Promise<VersionRow[]> {
  return db.select().from(schema.configVersions).where(eq(schema.configVersions.nodeId, nodeId)).orderBy(desc(schema.configVersions.number)).limit(limit);
}

export interface NodeConfigState {
  applied: Pick<VersionRow, 'id' | 'number' | 'cfg' | 'sniMap' | 'sha256' | 'source' | 'status' | 'createdAt' | 'createdBy' | 'finishedAt'> | null;
  desired: Rendered;
  /** На ноде именно то, что хочет панель. */
  inSync: boolean;
  /** Идёт применение (версия в статусе applying). */
  applyingNumber: number | null;
  /** Последняя попытка применения не удалась (после неё ничего не применялось). */
  lastFailed: VersionRow | null;
  /** Конфиг на ноде изменён вне панели: хеш от агента не совпадает с применённой версией. */
  drift: boolean;
  /** Ручной конфиг на ноде ещё не разобран. */
  importPending: boolean;
}

export async function configState(db: DB, node: NodeRow): Promise<NodeConfigState> {
  const desired = await desiredFor(db, node);
  const versions = await latestVersions(db, node.id, 10);
  const applied = node.appliedVersionId ? await db.select().from(schema.configVersions).where(eq(schema.configVersions.id, node.appliedVersionId)).then((r) => r[0] ?? null) : null;
  const applying = versions.find((v) => v.status === 'applying' && Date.now() - v.createdAt.getTime() < 3 * 60_000);
  const lastAttempt = versions[0];
  const lastFailed = lastAttempt && ['failed', 'rolled_back', 'rollback_failed'].includes(lastAttempt.status) && lastAttempt.id !== applied?.id ? lastAttempt : null;
  return {
    applied: applied && { id: applied.id, number: applied.number, cfg: applied.cfg, sniMap: applied.sniMap, sha256: applied.sha256, source: applied.source, status: applied.status, createdAt: applied.createdAt, createdBy: applied.createdBy, finishedAt: applied.finishedAt },
    desired,
    inSync: !!applied && applied.source === 'panel' && applied.sha256 === desired.sha256,
    applyingNumber: applying?.number ?? null,
    lastFailed,
    drift: !!applied && !!node.configSha256 && node.configSha256 !== cfgSha(applied.cfg),
    importPending: !node.importDone && !applied,
  };
}

/** Агент сообщил хеш конфига на ноде: если это конфиг недоприменённой версии, считаем её применённой. */
export async function reconcile(db: DB, nodeId: string, reportedCfgSha: string | null): Promise<void> {
  if (!reportedCfgSha) return;
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
  if (!node) return;
  const pending = await db
    .select()
    .from(schema.configVersions)
    .where(and(eq(schema.configVersions.nodeId, node.id), inArray(schema.configVersions.status, ['applying', 'failed']), eq(schema.configVersions.source, 'panel')))
    .orderBy(desc(schema.configVersions.number))
    .limit(3);
  const hit = pending.find((v) => cfgSha(v.cfg) === reportedCfgSha);
  if (hit && hit.id !== node.appliedVersionId) {
    await db.update(schema.configVersions).set({ status: 'applied', finishedAt: new Date(), output: (hit.output ? hit.output + '\n' : '') + 'Подтверждено по хешу конфига, присланному агентом.' }).where(eq(schema.configVersions.id, hit.id));
    await db.update(schema.nodes).set({ appliedVersionId: hit.id }).where(eq(schema.nodes.id, node.id));
  }
}

// ───────── валидация и CRUD ─────────

export interface RouteInput {
  name: string;
  slug: string;
  snis: string[];
  exitIds: string[];
  nodeIds: string[];
  proxyProtocol: boolean;
  healthCheck: boolean;
  enabled: boolean;
  limitMbit: number | null;
  ipLimitMbit: number | null;
}

export const normalizeSnis = (list: string[]): string[] => [...new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean))];

export async function validateRoute(db: DB, input: RouteInput, selfId?: string): Promise<void> {
  if (!SLUG_RE.test(input.slug)) throw new HttpError(400, 'validation', 'Идентификатор: латиница, цифры и «_», до 24 символов');
  const [dupe] = await db.select({ id: schema.routes.id }).from(schema.routes).where(selfId ? and(eq(schema.routes.slug, input.slug), ne(schema.routes.id, selfId)) : eq(schema.routes.slug, input.slug));
  if (dupe) throw new HttpError(409, 'slug_taken', `Идентификатор «${input.slug}» уже занят другим маршрутом`);
  for (const s of input.snis) if (!SNI_RE.test(s)) throw new HttpError(400, 'validation', `SNI «${s}» некорректен: только латиница, цифры, «-» и точки`);
  if (input.enabled && input.exitIds.length === 0) throw new HttpError(400, 'validation', 'Включённому маршруту нужен хотя бы один выход');
  for (const [v, what] of [[input.limitMbit, 'потолок маршрута'], [input.ipLimitMbit, 'лимит на IP']] as const) {
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > 100_000)) throw new HttpError(400, 'validation', `${what}: целое число Мбит/с от 1 до 100000`);
  }
  if (input.enabled && input.snis.length === 0) throw new HttpError(400, 'validation', 'Укажите хотя бы один SNI');
  if (input.exitIds.length) {
    const found = await db.select({ id: schema.exits.id }).from(schema.exits).where(inArray(schema.exits.id, input.exitIds));
    if (found.length !== new Set(input.exitIds).size) throw new HttpError(400, 'validation', 'Один из выходов не найден');
  }
  if (input.nodeIds.length) {
    const found = await db.select({ id: schema.nodes.id }).from(schema.nodes).where(inArray(schema.nodes.id, input.nodeIds));
    if (found.length !== new Set(input.nodeIds).size) throw new HttpError(400, 'validation', 'Одна из нод не найдена');
  }
  if (!input.enabled || input.snis.length === 0 || input.nodeIds.length === 0) return;
  // Один SNI не может вести в два маршрута на одной ноде.
  const others = await db
    .select({ routeId: schema.routes.id, name: schema.routes.name, snis: schema.routes.snis, nodeId: schema.routeNodes.nodeId, nodeName: schema.nodes.name })
    .from(schema.routeNodes)
    .innerJoin(schema.routes, eq(schema.routes.id, schema.routeNodes.routeId))
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.routeNodes.nodeId))
    .where(and(inArray(schema.routeNodes.nodeId, input.nodeIds), eq(schema.routes.enabled, true), selfId ? ne(schema.routes.id, selfId) : undefined));
  for (const o of others) {
    const clash = o.snis.find((s) => input.snis.includes(s));
    if (clash) throw new HttpError(409, 'sni_conflict', `SNI ${clash} на ноде «${o.nodeName}» уже ведёт в маршрут «${o.name}»`);
  }
}

export async function saveRoute(db: DB, input: RouteInput, selfId?: string): Promise<string> {
  return db.transaction(async (tx) => {
    let id = selfId;
    const values = { name: input.name, slug: input.slug, snis: input.snis, proxyProtocol: input.proxyProtocol, healthCheck: input.healthCheck, enabled: input.enabled, limitMbit: input.limitMbit, ipLimitMbit: input.ipLimitMbit, updatedAt: new Date() };
    if (id) await tx.update(schema.routes).set(values).where(eq(schema.routes.id, id));
    else id = (await tx.insert(schema.routes).values(values).returning({ id: schema.routes.id }))[0]!.id;
    await tx.delete(schema.routeExits).where(eq(schema.routeExits.routeId, id));
    if (input.exitIds.length) await tx.insert(schema.routeExits).values([...new Set(input.exitIds)].map((exitId, position) => ({ routeId: id!, exitId, position })));
    await tx.delete(schema.routeNodes).where(eq(schema.routeNodes.routeId, id));
    if (input.nodeIds.length) await tx.insert(schema.routeNodes).values([...new Set(input.nodeIds)].map((nodeId) => ({ routeId: id!, nodeId })));
    return id;
  });
}

export async function validateExit(db: DB, e: { name: string; country: string | null; host: string; port: number }, selfId?: string): Promise<void> {
  if (!isValidHost(e.host)) throw new HttpError(400, 'validation', 'Адрес выхода: IP или имя хоста без пробелов');
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new HttpError(400, 'validation', 'Порт от 1 до 65535');
  const [dupe] = await db.select({ id: schema.exits.id, name: schema.exits.name }).from(schema.exits).where(selfId ? and(eq(schema.exits.host, e.host), eq(schema.exits.port, e.port), ne(schema.exits.id, selfId)) : and(eq(schema.exits.host, e.host), eq(schema.exits.port, e.port)));
  if (dupe) throw new HttpError(409, 'exit_exists', `Выход ${e.host}:${e.port} уже есть: «${dupe.name}»`);
}

/** Ноды, на которые влияет изменение маршрута или выхода. */
export async function nodesOfExit(db: DB, exitId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ nodeId: schema.routeNodes.nodeId })
    .from(schema.routeExits)
    .innerJoin(schema.routeNodes, eq(schema.routeNodes.routeId, schema.routeExits.routeId))
    .where(eq(schema.routeExits.exitId, exitId));
  return rows.map((r) => r.nodeId);
}

export const countRoutesOfExit = async (db: DB, exitId: string): Promise<{ id: string; name: string }[]> =>
  db.select({ id: schema.routes.id, name: schema.routes.name }).from(schema.routeExits).innerJoin(schema.routes, eq(schema.routes.id, schema.routeExits.routeId)).where(eq(schema.routeExits.exitId, exitId));

export { sql };
