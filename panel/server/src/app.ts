import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { PANEL_VERSION, type Config } from './config.js';
import type { DB } from './db/index.js';
import { loadSession, SESSION_COOKIE } from './lib/auth.js';
import { HttpError } from './lib/http.js';
import { probeTls } from './lib/checks.js';
import { Ingestor } from './lib/ingest.js';
import { Registry } from './lib/registry.js';
import { requireAuth } from './lib/http.js';
import { agentRoutes } from './routes/agent.js';
import { authRoutes } from './routes/auth.js';
import { distRoutes } from './routes/dist.js';
import { readRelease, type AgentRelease } from './lib/agentRelease.js';
import { createLogoFetcher, loadBranding, renderIndex, type LogoFetcher } from './lib/branding.js';
import { accountRoutes } from './routes/account.js';
import { alertRoutes } from './routes/alerts.js';
import { auditRoutes } from './routes/audit.js';
import { brandingRoutes } from './routes/branding.js';
import { integrationRoutes } from './routes/integrations.js';
import { torrentRoutes } from './routes/torrent.js';
import { clientRoutes } from './routes/clients.js';
import { configRoutes } from './routes/config.js';
import { nodeRoutes } from './routes/nodes.js';
import { routeRoutes } from './routes/routes.js';
import { systemRoutes } from './routes/system.js';

export interface Ctx {
  db: DB;
  config: Config;
  registry: Registry;
  ingestor: Ingestor;
  /** Сквозная проверка панели → мост. Подменяется в тестах, чтобы они не ходили в сеть. */
  probe: typeof probeTls;
  /** Какие агенты лежат на панели (версия, подписи). Подменяется в демо и тестах. */
  release: () => AgentRelease;
  /** Скачивание логотипа по ссылке. Подменяется в тестах, чтобы они не ходили в сеть. */
  fetchLogo: LogoFetcher;
  /** HTTP-клиент для Remnawave и Telegram. Подменяется в тестах. */
  http: typeof fetch;
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export async function buildApp(db: DB, config: Config): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const ctx: Ctx = { db, config, registry: new Registry(), ingestor: new Ingestor(db), probe: probeTls, release: () => readRelease(resolve(config.AGENT_DIST)), fetchLogo: createLogoFetcher(config.LOGO_ALLOW_PRIVATE && config.NODE_ENV !== 'production'), http: (...a) => fetch(...a) };

  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      // Секреты не должны попадать в логи ни при каких условиях.
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '[скрыто]' },
    },
  });

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Слишком много запросов. Подождите минуту.' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error({ err }, 'необработанная ошибка');
    return reply.code(500).send({ error: 'internal', message: 'Внутренняя ошибка панели' });
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', CSP);
    if (config.secureCookies) reply.header('strict-transport-security', 'max-age=31536000');
    return payload;
  });

  // Сессия — для всех /api. Агентские эндпоинты cookie не используют.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/agent/')) return;
    const s = await loadSession(db, req.cookies[SESSION_COOKIE]);
    if (s) {
      req.session = s;
      req.user = s.user;
    }
    // CSRF: SameSite=Strict + обязательный нестандартный заголовок (кросс-сайтовая форма его не поставит).
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'popug') {
      throw new HttpError(403, 'csrf', 'Запрос отклонён: нет заголовка X-Requested-With');
    }
  });

  app.get('/api/health', async () => ({ ok: true, agentsOnline: ctx.registry.onlineCount() }));
  app.get('/api/status', { preHandler: requireAuth }, async () => ({ version: PANEL_VERSION, demo: config.DEMO }));
  authRoutes(app, ctx);
  nodeRoutes(app, ctx);
  routeRoutes(app, ctx);
  configRoutes(app, ctx);
  clientRoutes(app, ctx);
  accountRoutes(app, ctx);
  brandingRoutes(app, ctx);
  integrationRoutes(app, ctx);
  torrentRoutes(app, ctx);
  alertRoutes(app, ctx);
  auditRoutes(app, ctx);
  systemRoutes(app, ctx);
  agentRoutes(app, ctx);
  distRoutes(app, ctx);

  const webDist = resolve(config.WEB_DIST);
  if (existsSync(webDist)) {
    // Название и иконка вкладки подставляются в index.html на сервере: без мигания «Popug Bridges» до загрузки скриптов.
    const template = readFileSync(resolve(webDist, 'index.html'), 'utf8');
    const sendIndex = async (reply: FastifyReply) => {
      const b = await loadBranding(db);
      return reply.type('text/html').header('cache-control', 'no-cache').send(renderIndex(template, b));
    };
    app.get('/', async (_req, reply) => sendIndex(reply));
    await app.register(fastifyStatic, { root: webDist, index: false, allowedPath: (p) => p !== '/index.html', wildcard: false, cacheControl: false, setHeaders: (res, path) => {
      res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    } });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !/^\/(api|ws|dl|brand)\//.test(req.url)) return sendIndex(reply);
      return reply.code(404).send({ error: 'not_found', message: 'Не найдено' });
    });
  }
  return { app, ctx };
}
