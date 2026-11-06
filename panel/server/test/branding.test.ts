import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING, isPublicAddress, parseLogoUrl, renderIndex, sniffImage, LogoError } from '../src/lib/branding.js';
import { makeHarness, Session, type Harness } from './harness.js';

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>');

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
  h.ctx.fetchLogo = async (url) => {
    if (url.includes('svg')) return { mime: 'image/svg+xml', data: SVG };
    if (url.includes('bad')) throw new LogoError('Это не изображение');
    return { mime: 'image/png', data: PNG };
  };
}, 60_000);
afterAll(() => h.close());

describe('защита загрузки логотипа', () => {
  it('пускает только https и публичные адреса', () => {
    expect(() => parseLogoUrl('http://example.com/a.png')).toThrow(/https/);
    expect(() => parseLogoUrl('ftp://example.com/a.png')).toThrow();
    expect(() => parseLogoUrl('не ссылка')).toThrow(LogoError);
    expect(() => parseLogoUrl('https://user:pw@example.com/a.png')).toThrow(/логин/);
    expect(() => parseLogoUrl('https://127.0.0.1/a.png')).toThrow(/закрыт/);
    expect(() => parseLogoUrl('https://[::1]/a.png')).toThrow(/закрыт/);
    expect(() => parseLogoUrl('https://169.254.169.254/latest/meta-data')).toThrow(/закрыт/);
    expect(parseLogoUrl('https://example.com/a.png').hostname).toBe('example.com');
  });

  it('отличает публичные адреса от закрытых', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('определяет тип по содержимому, а не по заголовку', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(SVG)).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from('<html><body>not an image</body></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00'))).toBeNull();
  });
});

describe('index.html', () => {
  const tpl = '<head><title>Popug Bridges</title>\n    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />\n    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />\n  </head>';
  it('подставляет название с экранированием', () => {
    expect(renderIndex(tpl, { ...DEFAULT_BRANDING, name: 'A <b>&"x' })).toContain('<title>A &lt;b&gt;&amp;&quot;x</title>');
  });
  it('без логотипа оставляет стандартные иконки, с логотипом заменяет', () => {
    expect(renderIndex(tpl, DEFAULT_BRANDING)).toContain('/favicon-32.png');
    const out = renderIndex(tpl, { name: 'X', logoUrl: 'https://e.x/a.png', logo: { mime: 'image/png', b64: '', hash: 'abc123' } });
    expect(out).not.toContain('favicon-32');
    expect(out).toContain('<link rel="icon" href="/brand/logo?v=abc123" />');
  });
});

describe('настройки оформления', () => {
  it('до настройки отдаёт стандартное название без входа', async () => {
    const anon = new Session(h.base);
    const r = await anon.req('GET', '/api/branding');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ name: 'Popug Bridges', logo: null });
    expect((await anon.req('GET', '/brand/logo')).status).toBe(404);
  });

  it('изменение требует входа и заголовка CSRF', async () => {
    const anon = new Session(h.base);
    expect((await anon.req('PUT', '/api/settings/branding', { name: 'X', logoUrl: null })).status).toBe(401);
    expect((await anon.req('GET', '/api/settings/branding')).status).toBe(401);
  });

  it('проверяет название', async () => {
    for (const name of ['', '   ', 'x'.repeat(41), 'a<b']) {
      expect((await h.admin.req('PUT', '/api/settings/branding', { name, logoUrl: null })).status, JSON.stringify(name)).toBe(400);
    }
  });

  it('сохраняет название и логотип, публично отдаёт копию с нашего домена', async () => {
    const put = await h.admin.req('PUT', '/api/settings/branding', { name: 'Мосты Хорька', logoUrl: 'https://cdn.example.com/logo.png' });
    expect(put.status).toBe(200);
    expect(put.json.name).toBe('Мосты Хорька');
    expect(put.json.logo).toMatch(/^\/brand\/logo\?v=[0-9a-f]{12}$/);

    const pub = await new Session(h.base).req('GET', '/api/branding');
    expect(pub.json).toEqual({ name: 'Мосты Хорька', logo: put.json.logo });

    const img = await fetch(h.base + '/brand/logo');
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
    const again = await fetch(h.base + '/brand/logo', { headers: { 'if-none-match': img.headers.get('etag')! } });
    expect(again.status).toBe(304);

    const full = await h.admin.req('GET', '/api/settings/branding');
    expect(full.json).toMatchObject({ name: 'Мосты Хорька', logoUrl: 'https://cdn.example.com/logo.png', logoMime: 'image/png', defaultName: 'Popug Bridges' });
  });

  it('SVG отдаётся в песочнице и под защитной CSP', async () => {
    await h.admin.req('PUT', '/api/settings/branding', { name: 'S', logoUrl: 'https://cdn.example.com/svg-logo' });
    const r = await fetch(h.base + '/brand/logo');
    expect(r.headers.get('content-type')).toContain('image/svg+xml');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('неудачная загрузка не меняет сохранённое', async () => {
    const before = await h.admin.req('GET', '/api/settings/branding');
    const r = await h.admin.req('PUT', '/api/settings/branding', { name: 'Новое', logoUrl: 'https://cdn.example.com/bad' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('logo_fetch');
    expect((await h.admin.req('GET', '/api/settings/branding')).json).toEqual(before.json);
  });

  it('сброс ссылки убирает логотип, остальные страницы не затронуты', async () => {
    const r = await h.admin.req('PUT', '/api/settings/branding', { name: 'Popug Bridges', logoUrl: null });
    expect(r.json.logo).toBeNull();
    expect((await fetch(h.base + '/brand/logo')).status).toBe(404);
  });

  it('пишет в журнал аудита', async () => {
    const rows = await h.ctx.db.query.auditLog.findMany();
    expect(rows.filter((x) => x.action === 'settings.branding').length).toBeGreaterThanOrEqual(3);
  });
});
