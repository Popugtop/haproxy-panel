import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, type Ctx } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { schema } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { metrics, testDb } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance;
let ctx: Ctx;
let base: string;
let closeDb: () => Promise<void>;

const fixture = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../../protocol/fixtures', n), 'utf8'));

beforeAll(async () => {
  // Реальный install.sh из agent/, остальные файлы — заглушки.
  const dist = mkdtempSync(join(tmpdir(), 'popug-dist-'));
  copyFileSync(join(import.meta.dirname, '../../../agent/install.sh'), join(dist, 'install.sh'));
  writeFileSync(join(dist, 'SHA256SUMS'), 'abc  popug-agent-linux-amd64\n');
  writeFileSync(join(dist, 'popug-agent-linux-amd64'), 'bin');
  const t = await testDb();
  closeDb = t.close;
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'x',
    APP_SECRET: 'a'.repeat(40),
    PUBLIC_URL: 'https://panel.example.com',
    LOG_LEVEL: 'silent',
    AGENT_DIST: dist,
    WEB_DIST: '/nonexistent',
  });
  ({ app, ctx } = await buildApp(t.db, config));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await ctx.db.insert(schema.users).values({ login: 'admin', passwordHash: await hashPassword(PASSWORD) });
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

// ───── вспомогательное ─────
class Session {
  cookie = '';
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'x-requested-with': 'popug',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0]!;
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  }
}

async function loginFully(): Promise<Session> {
  const s = new Session();
  let r = await s.req('POST', '/api/auth/login', { login: 'admin', password: PASSWORD });
  expect(r.status).toBe(200);
  if (r.json.status === 'totp_setup') {
    const setup = await s.req('GET', '/api/auth/totp/setup');
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret), digits: 6, period: 30 }).generate();
    r = await s.req('POST', '/api/auth/totp/enable', { code });
    expect(r.status).toBe(200);
  } else if (r.json.status === 'totp_required') {
    throw new Error('используйте loginWithTotp');
  }
  return s;
}

/** Код текущего окна. Сбрасывает «последний принятый шаг», чтобы тесты не мешали друг другу. */
async function freshCode(resetReplay = true): Promise<string> {
  if (resetReplay) await ctx.db.update(schema.users).set({ totpLastStep: null }).where(eq(schema.users.login, 'admin'));
  const [u] = await ctx.db.select().from(schema.users).where(eq(schema.users.login, 'admin'));
  const secret = decryptSecret(u!.totpSecretEnc!, ctx.config.APP_SECRET);
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
}

function openAgent(key: string): Promise<{ ws: WebSocket; messages: any[]; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent', { headers: { authorization: `Bearer ${key}` } });
    const messages: any[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', () => {});
  });
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('условие не выполнилось за ' + ms + ' мс');
};

// ───── тесты ─────
describe('безопасность входа', () => {
  it('API закрыт без сессии, мутации без CSRF-заголовка отклоняются', async () => {
    const s = new Session();
    expect((await s.req('GET', '/api/nodes')).status).toBe(401);
    const noHeader = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noHeader.status).toBe(403);
  });

  it('неверный пароль и неизвестный логин дают одинаковый ответ', async () => {
    const s = new Session();
    const a = await s.req('POST', '/api/auth/login', { login: 'admin', password: 'wrong-password-123' });
    const b = await s.req('POST', '/api/auth/login', { login: 'nobody', password: 'wrong-password-123' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json).toEqual(b.json);
  });

  it('вход по паролю требует настройки TOTP; сессия до этого не открывает API', async () => {
    const s = new Session();
    const r = await s.req('POST', '/api/auth/login', { login: 'admin', password: PASSWORD });
    expect(r.json.status).toBe('totp_setup');
    expect((await s.req('GET', '/api/nodes')).status).toBe(401); // mfa ещё не пройден
    const me = await s.req('GET', '/api/auth/me');
    expect(me.json.status).toBe('totp_setup');

    const setup = await s.req('GET', '/api/auth/totp/setup');
    expect(setup.json.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect((await s.req('POST', '/api/auth/totp/enable', { code: '000000' })).status).toBe(400);
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret), digits: 6, period: 30 }).generate();
    expect((await s.req('POST', '/api/auth/totp/enable', { code })).status).toBe(200);
    expect((await s.req('GET', '/api/nodes')).status).toBe(200);
  });

  it('с включённым TOTP: пароль без кода → totp_required, неверный код → 401, верный → вход', async () => {
    const s = new Session();
    expect((await s.req('POST', '/api/auth/login', { login: 'admin', password: PASSWORD })).json.status).toBe('totp_required');
    expect((await s.req('POST', '/api/auth/login', { login: 'admin', password: PASSWORD, code: '123456' })).status).toBe(401);
    const good = await s.req('POST', '/api/auth/login', { login: 'admin', password: PASSWORD, code: await freshCode() });
    expect(good.status).toBe(200);
    expect(good.json.status).toBe('ok');
    expect((await s.req('GET', '/api/nodes')).status).toBe(200);
  });

  it('cookie сессии: httpOnly, SameSite=Strict, Path=/', async () => {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'popug' },
      body: JSON.stringify({ login: 'admin', password: PASSWORD, code: await freshCode() }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^popug_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Secure/i); // PUBLIC_URL https
    expect(await res.text()).not.toMatch(/popug_sid|password/i);
  });

  it('код TOTP нельзя использовать дважды', async () => {
    const code = await freshCode(); // сброс шага один раз, дальше код тратится
    const a = await new Session().req('POST', '/api/auth/login', { login: 'admin', password: PASSWORD, code });
    const b = await new Session().req('POST', '/api/auth/login', { login: 'admin', password: PASSWORD, code });
    expect(a.status).toBe(200);
    expect(b.status).toBe(401);
  });
});

// Сессия для последующих тестов: вход ограничен 10 попытками в минуту, поэтому второй раз не логинимся.
let sharedAdmin: Session;

describe('ноды: регистрация и подключение агента', () => {
  let admin: Session;
  let nodeId: string;
  let token: string;
  let key: string;

  beforeAll(async () => {
    admin = new Session();
    // Вход с TOTP следующего окна (предыдущие шаги уже использованы).
    const r = await admin.req('POST', '/api/auth/login', { login: 'admin', password: PASSWORD, code: await freshCode() });
    expect(r.status).toBe(200);
    sharedAdmin = admin;
  });

  it('создание ноды возвращает одноразовый токен и команду установки', async () => {
    const r = await admin.req('POST', '/api/nodes', { name: 'aeza-1', domain: 'branch.popug.cloud', hoster: 'Aeza', quotaTb: 10, billingDay: 5, quotaCounts: 'tx' });
    expect(r.status).toBe(201);
    nodeId = r.json.node.id;
    token = r.json.enrollment.token;
    expect(r.json.enrollment.command).toBe(`curl -fsSL https://panel.example.com/install.sh | bash -s -- ${token}`);
    expect(r.json.node.status).toBe('pending');
    expect(JSON.stringify(r.json.node)).not.toMatch(/hash/i);
  });

  it('токен хранится только в виде хэша', async () => {
    const [n] = await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
    expect(n!.enrollTokenHash).toHaveLength(64);
    expect(JSON.stringify(n)).not.toContain(token);
  });

  it('неверный токен — 403; верный — ключ; повтор того же токена — 403 (одноразовый)', async () => {
    const body = (t: string) => ({ token: t, protocol: 1, agentVersion: '0.1.0', hostname: 'ru-bridge-1' });
    const anon = new Session();
    expect((await anon.req('POST', '/api/agent/enroll', body('x'.repeat(30)))).status).toBe(403);
    const ok = await anon.req('POST', '/api/agent/enroll', body(token));
    expect(ok.status).toBe(200);
    expect(ok.json.nodeId).toBe(nodeId);
    expect(ok.json.key).toMatch(/^nk_/);
    key = ok.json.key;
    expect((await anon.req('POST', '/api/agent/enroll', body(token))).status).toBe(403);
  });

  it('просроченный токен не принимается', async () => {
    const r = await admin.req('POST', '/api/nodes/' + nodeId + '/enrollment');
    await ctx.db.update(schema.nodes).set({ enrollExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.nodes.id, nodeId));
    const res = await new Session().req('POST', '/api/agent/enroll', { token: r.json.enrollment.token, protocol: 1, agentVersion: '0.1.0', hostname: 'h' });
    expect(res.status).toBe(403);
  });

  it('WebSocket без ключа или с чужим ключом отвергается до апгрейда (401)', async () => {
    await expect(openAgent('nk_wrong')).rejects.toMatchObject({ status: 401 });
    const raw = new WebSocket(base.replace('http', 'ws') + '/ws/agent');
    const status = await new Promise((resolve) => {
      raw.on('unexpected-response', (_r, res) => resolve(res.statusCode));
      raw.on('error', () => {});
    });
    expect(status).toBe(401);
  });

  it('hello → welcome → metrics: нода онлайн, видны версии, скорость и бэкенды', async () => {
    const { ws, messages } = await openAgent(key);
    ws.send(JSON.stringify(fixture('hello.json')));
    await until(() => messages.some((m) => m.t === 'welcome'));
    expect(messages[0]).toMatchObject({ t: 'welcome', protocol: 1, nodeId, metricsIntervalSec: 15 });

    ws.send(JSON.stringify(metrics({ rx: 1_000, tx: 2_000, backends: [{ name: 'be_de', bin: 10, bout: 20, scur: 2 }] })));
    await until(async () => (await ctx.db.select().from(schema.nodeLive).where(eq(schema.nodeLive.nodeId, nodeId))).length > 0);
    // Для вычисления скорости нужен второй снимок; подменяем время предыдущего, чтобы не ждать 15 с.
    const [live] = await ctx.db.select().from(schema.nodeLive).where(eq(schema.nodeLive.nodeId, nodeId));
    const shifted = { ...live!.counters, ts: live!.counters.ts - 15_000 };
    await ctx.db.update(schema.nodeLive).set({ counters: shifted }).where(eq(schema.nodeLive.nodeId, nodeId));
    (ctx.ingestor as any).cache.set(nodeId, shifted);
    ws.send(JSON.stringify(metrics({ rx: 1_000 + 3_000_000, tx: 2_000 + 6_000_000, backends: [{ name: 'be_de', bin: 10 + 150, bout: 20 + 1500, scur: 4 }], active: 7 })));
    await until(async () => (await admin.req('GET', '/api/nodes')).json.nodes[0].live?.rxBps > 0);

    const list = await admin.req('GET', '/api/nodes');
    const n = list.json.nodes[0];
    expect(n).toMatchObject({ id: nodeId, status: 'online', agentVersion: '0.1.0', haproxyVersion: '2.8.5', bwlimSupported: true });
    expect(n.live.rxBps).toBeGreaterThan(150_000);
    expect(n.live).toMatchObject({ sessions: 4, activeClients: 7, backendsTotal: 1, backendsDown: 0 });
    expect(n.quota).toMatchObject({ limitBytes: 10e12, counts: 'tx' });
    expect(n.ip).toBeTruthy(); // подхвачен из addrs агента

    const detail = await admin.req('GET', `/api/nodes/${nodeId}`);
    expect(detail.json.live.backends[0]).toMatchObject({ name: 'be_de', scur: 4 });
    expect(detail.json.backendTraffic[0]).toMatchObject({ backend: 'be_de', in24h: 150, out24h: 1500 });

    const series = await admin.req('GET', `/api/nodes/${nodeId}/series?range=1h`);
    expect(series.status).toBe(200);
    expect(series.json.t.length).toBeGreaterThan(0);
    expect(Object.keys(series.json.backends)).toEqual(['be_de']);
    ws.close();
  });

  it('после закрытия соединения нода офлайн', async () => {
    await until(async () => (await admin.req('GET', '/api/nodes')).json.nodes[0].status === 'offline');
  });

  it('get_config: команда доходит до агента и ответ валидируется', async () => {
    const { ws, messages } = await openAgent(key);
    ws.send(JSON.stringify(fixture('hello.json')));
    await until(() => messages.some((m) => m.t === 'welcome'));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'cmd') ws.send(JSON.stringify({ ...fixture('result_get_config.json'), id: m.id }));
    });
    const r = await admin.req('POST', `/api/nodes/${nodeId}/fetch-config`);
    expect(r.status).toBe(200);
    expect(r.json.path).toBe('/etc/haproxy/haproxy.cfg');
    expect(r.json.content).toContain('global');
    ws.close();
    await until(async () => (await admin.req('GET', '/api/nodes')).json.nodes[0].status === 'offline');
  });

  it('несовместимая версия протокола: закрытие кодом 4000', async () => {
    const { ws, closed } = await openAgent(key);
    ws.send(JSON.stringify({ ...fixture('hello.json'), protocol: 99 }));
    expect((await closed).code).toBe(4000);
  });

  it('мусорный кадр: закрытие кодом 4005', async () => {
    const { ws, closed } = await openAgent(key);
    ws.send('{"t":"metrics","oops":true}');
    expect((await closed).code).toBe(4005);
  });

  it('второе соединение той же ноды вытесняет первое (4004)', async () => {
    const a = await openAgent(key);
    a.ws.send(JSON.stringify(fixture('hello.json')));
    await until(() => a.messages.some((m) => m.t === 'welcome'));
    const b = await openAgent(key);
    expect((await a.closed).code).toBe(4004);
    b.ws.close();
  });

  it('отзыв ключа рвёт соединение (4003) и закрывает путь для переподключения', async () => {
    const { ws, messages, closed } = await openAgent(key);
    ws.send(JSON.stringify(fixture('hello.json')));
    await until(() => messages.some((m) => m.t === 'welcome'));
    const r = await admin.req('POST', `/api/nodes/${nodeId}/revoke`);
    expect(r.json.node.status).toBe('revoked');
    expect((await closed).code).toBe(4003);
    await expect(openAgent(key)).rejects.toMatchObject({ status: 403 });
  });

  it('PATCH пишет в аудит только изменившиеся поля', async () => {
    const r = await admin.req('PATCH', `/api/nodes/${nodeId}`, { hoster: 'Aeza Group', quotaTb: 12 });
    expect(r.status).toBe(200);
    const rows = await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'node.update'));
    expect(rows.at(-1)!.diff).toEqual({ hoster: { from: 'Aeza', to: 'Aeza Group' }, quotaTb: { from: '10.00', to: '12.00' } });
  });

  it('валидация: плохой IP и пустое имя', async () => {
    expect((await admin.req('POST', '/api/nodes', { name: '', ip: '1.2.3.4' })).status).toBe(400);
    expect((await admin.req('POST', '/api/nodes', { name: 'x', ip: 'not-an-ip' })).status).toBe(400);
  });

  it('аудит не содержит токенов и ключей', async () => {
    const all = JSON.stringify(await ctx.db.select().from(schema.auditLog));
    expect(all).not.toContain(token);
    expect(all).not.toContain(key);
    expect(all).not.toContain(PASSWORD);
  });

  it('удаление ноды чистит всё', async () => {
    expect((await admin.req('DELETE', `/api/nodes/${nodeId}`)).status).toBe(200);
    expect((await admin.req('GET', `/api/nodes/${nodeId}`)).status).toBe(404);
    expect(await ctx.db.select().from(schema.nodeLive).where(eq(schema.nodeLive.nodeId, nodeId))).toHaveLength(0);
  });
});

describe('install.sh и загрузки', () => {
  it('install.sh подставляет PUBLIC_URL, а не заголовок Host', async () => {
    const res = await fetch(base + '/install.sh', { headers: { host: 'evil.example.net' } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('PANEL_URL="https://panel.example.com"');
    expect(body).not.toContain('evil.example.net');
    expect(body).not.toContain('__PANEL_URL__');
  });

  it('/dl отдаёт только белый список файлов', async () => {
    expect((await fetch(base + '/dl/SHA256SUMS')).status).toBe(200);
    expect((await fetch(base + '/dl/popug-agent-linux-amd64')).status).toBe(200);
    expect((await fetch(base + '/dl/install.sh')).status).toBe(404);
    expect((await fetch(base + '/dl/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await fetch(base + '/dl/__proto__')).status).toBe(404);
  });
});

describe('настройки панели: домен для новых маршрутов', () => {
  const admin = () => sharedAdmin;

  it('по умолчанию popug.cloud и отдаётся в /api/system', async () => {
    const r = await admin().req('GET', '/api/settings/panel');
    expect(r.json).toEqual({ sniDomain: 'popug.cloud' });
    expect((await admin().req('GET', '/api/system')).json.sniDomain).toBe('popug.cloud');
  });

  it('сохраняет домен в нижнем регистре и без схемы', async () => {
    expect((await admin().req('PUT', '/api/settings/panel', { sniDomain: 'Popug.Cloud' })).json).toEqual({ sniDomain: 'popug.cloud' });
    expect((await admin().req('PUT', '/api/settings/panel', { sniDomain: 'vpn.example.org' })).status).toBe(200);
    expect((await admin().req('GET', '/api/system')).json.sniDomain).toBe('vpn.example.org');
    await admin().req('PUT', '/api/settings/panel', { sniDomain: 'popug.cloud' });
  });

  it('мусор и устаревшие значения отклоняются', async () => {
    for (const bad of ['', 'https://popug.cloud', 'popug', 'popug.cloud/path', 'pop ug.cloud', 'de.']) {
      expect((await admin().req('PUT', '/api/settings/panel', { sniDomain: bad })).status, bad).toBe(400);
    }
    // слитое через сохранённую настройку старое значение не затирает умолчание
    expect((await admin().req('GET', '/api/settings/panel')).json.sniDomain).toBe('popug.cloud');
  });

  it('без входа недоступно', async () => {
    expect((await new Session().req('GET', '/api/settings/panel')).status).toBe(401);
    expect((await new Session().req('PUT', '/api/settings/panel', { sniDomain: 'x.example.com' })).status).toBe(401);
  });

  it('смена домена попадает в аудит', async () => {
    await admin().req('PUT', '/api/settings/panel', { sniDomain: 'popug.cloud' });
    const a = await admin().req('GET', '/api/audit?limit=20');
    expect(a.json.entries.some((e: { action: string }) => e.action === 'settings.panel')).toBe(true);
  });
});
