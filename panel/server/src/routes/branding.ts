import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { actorOf, audit } from '../lib/audit.js';
import { DEFAULT_NAME, LogoError, loadBranding, logoPath, saveBranding, toStored, type Branding } from '../lib/branding.js';
import { HttpError, notFound, parse, requireAuth } from '../lib/http.js';

const Body = z.object({
  name: z.string().trim().min(1, 'Название не может быть пустым').max(40, 'Название не длиннее 40 символов').refine((s) => !/[\u0000-\u001f<>]/.test(s), 'Недопустимые символы в названии'),
  logoUrl: z.string().trim().max(1000).nullable(),
  /** Скачать картинку по ссылке заново, даже если ссылка та же. */
  refresh: z.boolean().default(false),
});

export function brandingRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /** Без входа: название и логотип нужны экрану входа и вкладке браузера. */
  app.get('/api/branding', async (_req, reply) => {
    const b = await loadBranding(db);
    reply.header('cache-control', 'no-cache');
    return { name: b.name, logo: logoPath(b) };
  });

  app.get('/api/settings/branding', { preHandler: requireAuth }, async () => {
    const b = await loadBranding(db);
    return { name: b.name, defaultName: DEFAULT_NAME, logoUrl: b.logoUrl, logo: logoPath(b), logoBytes: b.logo ? Buffer.from(b.logo.b64, 'base64').length : null, logoMime: b.logo?.mime ?? null };
  });

  app.put('/api/settings/branding', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(Body, req.body);
    const cur = await loadBranding(db);
    const next: Branding = { name: body.name, logoUrl: body.logoUrl || null, logo: cur.logo };
    if (!next.logoUrl) {
      next.logo = null;
    } else if (next.logoUrl !== cur.logoUrl || body.refresh || !cur.logo) {
      try {
        const got = await ctx.fetchLogo(next.logoUrl);
        next.logo = toStored(got.mime, got.data);
      } catch (e) {
        if (e instanceof LogoError) throw new HttpError(400, 'logo_fetch', e.message);
        throw new HttpError(400, 'logo_fetch', `Не удалось скачать логотип: ${(e as Error).message}`);
      }
    }
    await saveBranding(db, next);
    await audit(db, actorOf(req), 'settings.branding', undefined, { name: next.name, logoUrl: next.logoUrl, logoHash: next.logo?.hash ?? null }, req.ip);
    return { name: next.name, logoUrl: next.logoUrl, logo: logoPath(next) };
  });

  /** Логотип отдаётся с нашего домена: CSP остаётся строгой, посетители не светятся перед чужим сайтом. */
  app.get('/brand/logo', async (req, reply) => {
    const b = await loadBranding(db);
    if (!b.logo) throw notFound('Логотип не задан');
    const etag = `"${b.logo.hash}"`;
    reply.header('etag', etag).header('cache-control', 'no-cache');
    // SVG не должен исполнять скрипты, если его откроют отдельной страницей.
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type(b.logo.mime).send(Buffer.from(b.logo.b64, 'base64'));
  });
}
