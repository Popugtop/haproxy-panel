import { UpdateResultSchema } from '@popug/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { PANEL_VERSION } from '../config.js';
import { schema } from '../db/index.js';
import { actorOf, audit } from '../lib/audit.js';
import { isNewer } from '../lib/agentRelease.js';
import { HttpError, notFound, parse, requireAuth } from '../lib/http.js';
import { DOMAIN_RE, loadPanelSettings, putSetting } from '../lib/settings.js';

export function systemRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, registry, config } = ctx;
  const auth = { preHandler: requireAuth };

  /** Сведения о самой панели и о том, какие агенты она может раздать. */
  app.get('/api/system', auth, async () => ({
    version: PANEL_VERSION,
    publicUrl: config.publicUrl,
    demo: config.DEMO,
    release: ctx.release(),
    agentsOnline: registry.onlineCount(),
    sniDomain: (await loadPanelSettings(db)).sniDomain,
  }));

  /** Домен для подсказки SNI: он подставляется в SNI нового маршрута (de → de.popug.cloud). */
  app.get('/api/settings/panel', auth, async () => loadPanelSettings(db));

  app.put('/api/settings/panel', { ...auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ sniDomain: z.string().trim().toLowerCase().max(253) }), req.body);
    if (!DOMAIN_RE.test(b.sniDomain)) throw new HttpError(400, 'validation', 'Домен выглядит как popug.cloud: латинские буквы, цифры, дефисы и точки, без https:// и пути');
    await putSetting(db, 'panel', { sniDomain: b.sniDomain });
    await audit(db, actorOf(req), 'settings.panel', undefined, { sniDomain: b.sniDomain }, req.ip);
    return { sniDomain: b.sniDomain };
  });

  /**
   * Обновление агента по кнопке. Панель лишь просит: агент сам скачает бинарник с панели и поставит его, только если подпись
   * сходится с ключом, закреплённым при установке. Поэтому взлом панели не даёт возможности подсунуть свой бинарник.
   */
  app.post('/api/nodes/:id/agent/update', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [n] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, id));
    if (!n) throw notFound('Нода не найдена');
    const rel = ctx.release();
    if (!registry.isOnline(id)) throw new HttpError(409, 'offline', 'Нода не на связи.');
    if (!rel.version) throw new HttpError(409, 'no_release', 'На панели нет версии агента для раздачи (нет файла VERSION в каталоге агентов).');
    if (n.agentVersion && !isNewer(rel.version, n.agentVersion)) throw new HttpError(409, 'up_to_date', `Агент уже на версии ${n.agentVersion}.`);
    if (!registry.supports(id, 'update_agent')) {
      throw new HttpError(409, 'agent_outdated', `Агент ${n.agentVersion ?? '?'} ещё не умеет обновляться сам. Один раз обновите его командой установки без токена: дальше — по кнопке.`);
    }
    if (!n.updateReady) throw new HttpError(409, 'no_key', 'На ноде не закреплён ключ подписи. Переустановите агента командой установки без токена: ключ закрепится, дальше обновления пойдут по кнопке.');
    const arch = n.arch === 'arm64' ? 'arm64' : 'amd64';
    const file = rel.files[arch];
    if (!file) throw new HttpError(409, 'no_release', `На панели нет бинарника агента под ${arch}.`);
    if (!file.signed) throw new HttpError(409, 'unsigned', 'Релиз не подписан: соберите агентов с ключом подписи (см. README), иначе агенты откажутся его ставить.');

    const r = await registry.send(id, 'update_agent', { args: { version: rel.version, sha256: file.sha256 }, timeoutMs: 120_000 });
    await audit(db, actorOf(req), 'agent.update', { type: 'node', id }, { from: n.agentVersion, to: rel.version, ok: r.ok, error: r.error }, req.ip);
    if (!r.ok) throw new HttpError(502, 'update_failed', r.error ?? 'Агент отказался обновляться');
    const d = UpdateResultSchema.safeParse(r.data);
    return { ok: true, from: d.success ? d.data.from : n.agentVersion, to: rel.version, restarting: d.success ? d.data.restarting : true };
  });
}
