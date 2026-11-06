import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp, type Ctx } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { schema } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { sha256Hex } from '../src/lib/crypto.js';
import { testDb } from './helpers.js';

export const PASSWORD = 'correct horse battery staple';
export const fixture = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../../protocol/fixtures', n), 'utf8'));

export const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('условие не выполнилось за ' + ms + ' мс');
};

export class Session {
  cookie = '';
  constructor(private base: string) {}
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'x-requested-with': 'popug', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0]!;
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
}

type Handler = (cmd: any) => { ok: boolean; error?: string | null; data?: unknown } | Promise<{ ok: boolean; error?: string | null; data?: unknown }>;

/** Агент-заглушка по настоящему WebSocket: подключается ключом ноды, отвечает на команды по заданным обработчикам. */
export class FakeAgent {
  messages: any[] = [];
  handlers: Record<string, Handler> = { ping: () => ({ ok: true, data: { pong: true } }) };
  closed: Promise<{ code: number; reason: string }>;
  private constructor(public ws: WebSocket) {
    this.closed = new Promise((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
    ws.on('message', async (d) => {
      const m = JSON.parse(d.toString());
      this.messages.push(m);
      if (m.t === 'cmd') {
        const h = this.handlers[m.op];
        const r = h ? await h(m) : { ok: false, error: 'unsupported_op: ' + m.op };
        ws.send(JSON.stringify({ t: 'result', id: m.id, ok: r.ok, error: r.error ?? null, data: r.data }));
      }
    });
  }
  static connect(base: string, key: string, helloOver: Record<string, unknown> = {}): Promise<FakeAgent> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws/agent', { headers: { authorization: `Bearer ${key}` } });
      ws.on('unexpected-response', (_q, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
      ws.on('error', () => {});
      ws.on('open', async () => {
        const a = new FakeAgent(ws);
        ws.send(JSON.stringify({ ...fixture('hello.json'), ...helloOver }));
        await until(() => a.messages.some((m) => m.t === 'welcome'));
        resolve(a);
      });
    });
  }
  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }
  of(t: string) {
    return this.messages.filter((m) => m.t === t);
  }
  close() {
    this.ws.close();
  }
}

export interface Harness {
  app: FastifyInstance;
  ctx: Ctx;
  base: string;
  admin: Session;
  /** Нода с готовым ключом (без регистрации по токену). */
  makeNode(name: string, over?: Partial<typeof schema.nodes.$inferInsert>): Promise<{ id: string; key: string }>;
  close(): Promise<void>;
}

export async function makeHarness(): Promise<Harness> {
  const dist = mkdtempSync(join(tmpdir(), 'popug-dist-'));
  copyFileSync(join(import.meta.dirname, '../../../agent/install.sh'), join(dist, 'install.sh'));
  writeFileSync(join(dist, 'SHA256SUMS'), 'abc  popug-agent-linux-amd64\n');
  const t = await testDb();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'x', APP_SECRET: 'a'.repeat(40), PUBLIC_URL: 'https://panel.example.com', LOG_LEVEL: 'silent', AGENT_DIST: dist, WEB_DIST: '/nonexistent' });
  const { app, ctx } = await buildApp(t.db, config);
  ctx.probe = async () => ({ ok: false, ms: null, error: 'проверка панели в тестах отключена' }); // без сетевых запросов
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await ctx.db.insert(schema.users).values({ login: 'admin', passwordHash: await hashPassword(PASSWORD) });

  const admin = new Session(base);
  const r = await admin.req('POST', '/api/auth/login', { login: 'admin', password: PASSWORD });
  if (r.json.status === 'totp_setup') {
    const setup = await admin.req('GET', '/api/auth/totp/setup');
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret), digits: 6, period: 30 }).generate();
    const en = await admin.req('POST', '/api/auth/totp/enable', { code });
    if (en.status !== 200) throw new Error('не удалось включить TOTP в тесте');
  }
  let n = 0;
  return {
    app, ctx, base, admin,
    async makeNode(name, over = {}) {
      const key = `nk_test_${++n}_${Math.random().toString(36).slice(2)}`;
      const [row] = await ctx.db.insert(schema.nodes).values({ name, ip: `203.0.113.${n}`, keyHash: sha256Hex(key), keyCreatedAt: new Date(), ...over }).returning();
      return { id: row!.id, key };
    },
    async close() {
      await app.close();
      await t.close();
    },
  };
}
