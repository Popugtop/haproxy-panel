import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import { type DB, schema } from '../db/index.js';

export const DEFAULT_NAME = 'Popug Bridges';
export const MAX_LOGO_BYTES = 512 * 1024;
const KEY = 'branding';

export interface StoredLogo {
  mime: string;
  b64: string;
  hash: string;
}

export interface Branding {
  name: string;
  /** Адрес, который ввёл администратор: хранится, чтобы можно было обновить логотип. */
  logoUrl: string | null;
  logo: StoredLogo | null;
}

export const DEFAULT_BRANDING: Branding = { name: DEFAULT_NAME, logoUrl: null, logo: null };

export async function loadBranding(db: DB): Promise<Branding> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  if (!row) return DEFAULT_BRANDING;
  const v = row.value as Partial<Branding>;
  return { name: v.name?.trim() || DEFAULT_NAME, logoUrl: v.logoUrl ?? null, logo: v.logo ?? null };
}

export async function saveBranding(db: DB, b: Branding): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key: KEY, value: b })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: b, updatedAt: new Date() } });
}

/** Публичный адрес логотипа с отпечатком содержимого: смена картинки сбрасывает кеш браузера. */
export const logoPath = (b: Branding): string | null => (b.logo ? `/brand/logo?v=${b.logo.hash}` : null);

// ───────── загрузка логотипа по ссылке ─────────

// Панель ходит по адресу, который ввёл администратор, поэтому наружу пускаем только на публичные адреса.
const blocked = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) blocked.addSubnet(net, prefix, 'ipv6');

export function isPublicAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (!fam) return false;
  return !blocked.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
}

/** DNS-разрешение, которое отвергает непубличные адреса прямо в момент соединения (защита и от DNS rebinding). */
const lookupFor = (allowPrivate: boolean) => (hostname: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void): void => {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || (!allowPrivate && addrs.some((a) => !isPublicAddress(a.address)))) return cb(new Error('Адрес указывает на закрытую сеть'));
    if (opts.all) return cb(null, addrs);
    return cb(null, addrs[0]!.address, addrs[0]!.family);
  });
};

export class LogoError extends Error {}

/** Тип определяем по содержимому, а не по заголовку сервера. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if ((head.startsWith('<?xml') || head.startsWith('<svg')) && buf.toString('utf8').toLowerCase().includes('<svg')) return 'image/svg+xml';
  return null;
}

export function parseLogoUrl(raw: string, allowPrivate = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new LogoError('Это не ссылка. Пример: https://example.com/logo.png');
  }
  if (u.protocol !== 'https:') throw new LogoError('Ссылка должна начинаться с https://');
  if (u.username || u.password) throw new LogoError('Ссылка не должна содержать логин и пароль');
  if (!allowPrivate && isIP(u.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(u.hostname.replace(/^\[|\]$/g, ''))) throw new LogoError('Адрес указывает на закрытую сеть');
  return u;
}

export type LogoFetcher = (url: string) => Promise<{ mime: string; data: Buffer }>;

/** allowPrivate — только для разработки за прокси с подменой DNS (LOGO_ALLOW_PRIVATE=1). */
export const createLogoFetcher = (allowPrivate = false): LogoFetcher => async (raw) => {
  let url = parseLogoUrl(raw, allowPrivate);
  for (let hop = 0; hop <= 3; hop++) {
    const res = await get(url, allowPrivate);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = parseLogoUrl(new URL(res.location, url).toString(), allowPrivate);
      continue;
    }
    if (res.status !== 200) throw new LogoError(`Сервер ответил ${res.status}`);
    const mime = sniffImage(res.body);
    if (!mime) throw new LogoError('Это не изображение. Подходят PNG, JPEG, WebP, GIF, SVG и ICO');
    return { mime, data: res.body };
  }
  throw new LogoError('Слишком много перенаправлений');
};

function get(url: URL, allowPrivate: boolean): Promise<{ status: number; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'GET', lookup: lookupFor(allowPrivate) as never, timeout: 8000, headers: { accept: 'image/*', 'user-agent': 'popug-bridges-panel' } },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, body: Buffer.alloc(0) });
        }
        const declared = Number(res.headers['content-length']);
        if (declared > MAX_LOGO_BYTES) {
          res.destroy();
          return reject(new LogoError('Файл больше 512 КБ'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_LOGO_BYTES) {
            res.destroy();
            return reject(new LogoError('Файл больше 512 КБ'));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
        res.on('error', (e) => reject(new LogoError(`Не удалось скачать: ${e.message}`)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('таймаут 8 с')));
    req.on('error', (e) => reject(e instanceof LogoError ? e : new LogoError(`Не удалось скачать: ${e.message}`)));
    req.end();
  });
}

export const toStored = (mime: string, data: Buffer): StoredLogo => ({ mime, b64: data.toString('base64'), hash: createHash('sha256').update(data).digest('hex').slice(0, 12) });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** index.html с названием и иконкой вкладки из настроек. */
export function renderIndex(template: string, b: Branding): string {
  let html = template.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(b.name)}</title>`);
  const path = logoPath(b);
  if (path) {
    html = html.replace(/\s*<link rel="(?:icon|apple-touch-icon)"[^>]*>/g, '').replace('</head>', `    <link rel="icon" href="${path}" />\n    <link rel="apple-touch-icon" href="${path}" />\n  </head>`);
  }
  return html;
}
