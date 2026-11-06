import { eq } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { FakeAgent, PASSWORD, Session, makeHarness, until, type Harness } from './harness.js';

let h: Harness;
let a: { id: string; key: string };
let b: { id: string; key: string };
let agA: FakeAgent;
let agB: FakeAgent;
const banCalls: Record<string, any[]> = { a: [], b: [] };

const post = (p: string, body?: unknown) => h.admin.req('POST', p, body ?? {});
const get = (p: string) => h.admin.req('GET', p);
const del = (p: string) => h.admin.req('DELETE', p);

const row = (ip: string, rateOut: number) => ({ ip, connCur: 3, connCnt: 40, bytesIn: 1_000, bytesOut: 9_000_000, rateIn: rateOut / 10, rateOut });

beforeAll(async () => {
  h = await makeHarness();
  a = await h.makeNode('Aeza', { haproxyVersion: '2.8.5', ip: '203.0.113.5' });
  b = await h.makeNode('Хорёк', { haproxyVersion: '2.6.12', ip: '203.0.113.6' });
  agA = await FakeAgent.connect(h.base, a.key);
  agB = await FakeAgent.connect(h.base, b.key, { haproxy: { installed: true, running: true, version: '2.6.12' } });
  agA.handlers.get_clients = () => ({ ok: true, data: { tracked: 50, active: 2, top: [row('198.51.100.7', 5_000_000), row('198.51.100.8', 100)] } });
  agB.handlers.get_clients = () => ({ ok: true, data: { tracked: 10, active: 1, top: [row('198.51.100.7', 1_000_000)] } });
  agA.handlers.apply_bans = (c) => (banCalls.a!.push(c.args), { ok: true, data: { active: 1, rejected: [] } });
  agB.handlers.apply_bans = (c) => (banCalls.b!.push(c.args), { ok: true, data: { active: 1, rejected: [] } });
});
afterAll(async () => {
  agA.close();
  agB.close();
  await h.close();
});

describe('живые клиенты', () => {
  it('собираются у агентов всех нод, со скоростью, баном и лимитом', async () => {
    const r = (await get('/api/clients')).json;
    expect(r.rows).toHaveLength(3);
    expect(r.nodes.map((n: any) => [n.name, n.live, n.active])).toEqual([['Aeza', true, 2], ['Хорёк', true, 1]]);
    const x = r.rows.find((c: any) => c.ip === '198.51.100.7' && c.nodeId === a.id);
    expect(x).toMatchObject({ nodeName: 'Aeza', rateOut: 5_000_000, ban: null, limit: null });
    expect((await get(`/api/clients?nodeId=${b.id}`)).json.rows).toHaveLength(1);
  });

  it('агент без get_clients: нода помечена ошибкой, остальные работают', async () => {
    const old = await h.makeNode('Старый');
    const ag = await FakeAgent.connect(h.base, old.key, { ops: ['ping'] });
    const r = (await get('/api/clients')).json;
    expect(r.nodes.find((n: any) => n.name === 'Старый').error).toMatch(/обновите/);
    expect(r.rows).toHaveLength(3);
    ag.close();
  });
});

describe('баны', () => {
  it('бан доходит до агента как дельта со сроком; запись видна в списке и в таблице клиентов', async () => {
    const r = await post('/api/bans', { ip: '198.51.100.7', nodeIds: [a.id], durationSec: 3600, note: 'торрент' });
    expect(r.status).toBe(201);
    expect(r.json.outcomes).toEqual([{ nodeId: a.id, nodeName: 'Aeza', applied: true, error: null }]);
    expect(banCalls.a!.at(-1)).toEqual({ full: false, ban: [{ ip: '198.51.100.7', ttlSec: 3600 }], unban: [] });
    expect(banCalls.b).toHaveLength(0); // чужая нода не затронута

    const list = (await get('/api/bans')).json.bans;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ip: '198.51.100.7', nodeName: 'Aeza', reason: 'manual', createdBy: 'admin', note: 'торрент' });
    const clients = (await get('/api/clients')).json.rows;
    expect(clients.find((c: any) => c.ip === '198.51.100.7' && c.nodeId === a.id).ban).toMatchObject({ reason: 'manual' });
    expect(clients.find((c: any) => c.ip === '198.51.100.7' && c.nodeId === b.id).ban).toBeNull();
  });

  it('повторный бан продлевает, а не дублирует', async () => {
    await post('/api/bans', { ip: '198.51.100.7', nodeIds: [a.id], durationSec: 86400 });
    const list = (await get('/api/bans')).json.bans;
    expect(list).toHaveLength(1);
    expect(new Date(list[0].expiresAt).getTime() - Date.now()).toBeGreaterThan(80_000_000);
  });

  it('нельзя банить частные адреса, адреса нод и выходов; мусор и странные сроки отклоняются', async () => {
    for (const ip of ['10.0.0.5', '192.168.1.1', '127.0.0.1', '169.254.1.1', '::1', 'fd00::1', '224.0.0.1', '203.0.113.5', '203.0.113.6']) {
      const r = await post('/api/bans', { ip, nodeIds: [a.id], durationSec: 3600 });
      expect(r.status, ip).toBe(400);
      expect(r.json.error).toBe(ip === '203.0.113.5' || ip === '203.0.113.6' ? 'protected_ip' : 'protected_ip');
    }
    await post('/api/exits', { name: 'Выход', host: '203.0.113.77', port: 443 });
    expect((await post('/api/bans', { ip: '203.0.113.77', nodeIds: [a.id], durationSec: 3600 })).json.message).toMatch(/выход/);
    expect((await post('/api/bans', { ip: 'не-ip', nodeIds: [a.id], durationSec: 3600 })).status).toBe(400);
    expect((await post('/api/bans', { ip: '198.51.100.20', nodeIds: [a.id], durationSec: 5 })).status).toBe(400);
    expect((await post('/api/bans', { ip: '198.51.100.20', nodeIds: [a.id], durationSec: 400 * 86400 })).status).toBe(400);
    expect((await post('/api/bans', { ip: '198.51.100.20', nodeIds: [], durationSec: 3600 })).status).toBe(400);
    expect((await get('/api/bans')).json.bans).toHaveLength(1); // ничего лишнего не сохранилось
  });

  it('IPv4-mapped IPv6 нормализуется к IPv4', async () => {
    await post('/api/bans', { ip: '::FFFF:198.51.100.30', nodeIds: [b.id], durationSec: 600 });
    expect(banCalls.b!.at(-1).ban[0].ip).toBe('198.51.100.30');
  });

  it('отказ агента (rejected) виден в ответе', async () => {
    agA.handlers.apply_bans = () => ({ ok: true, data: { active: 0, rejected: [{ ip: '198.51.100.40', reason: 'адрес самого моста' }] } });
    const r = await post('/api/bans', { ip: '198.51.100.40', nodeIds: [a.id], durationSec: 600 });
    expect(r.json.outcomes[0]).toMatchObject({ applied: false });
    expect(r.json.outcomes[0].error).toMatch(/адрес самого моста/);
    agA.handlers.apply_bans = (c) => (banCalls.a!.push(c.args), { ok: true, data: { active: 1, rejected: [] } });
  });

  it('разбан по id и по IP на нескольких нодах', async () => {
    const id = (await get('/api/bans')).json.bans.find((x: any) => x.ip === '198.51.100.7').id;
    const r = await del(`/api/bans/${id}`);
    expect(r.json.removed).toBe(1);
    expect(banCalls.a!.at(-1)).toEqual({ full: false, ban: [], unban: ['198.51.100.7'] });
    expect((await del(`/api/bans/${id}`)).status).toBe(404);

    await post('/api/bans', { ip: '198.51.100.50', nodeIds: [a.id, b.id], durationSec: 3600 });
    const u = await post('/api/bans/unban', { ip: '198.51.100.50' });
    expect(u.json.removed).toBe(2);
    expect((await get('/api/bans')).json.bans.map((x: any) => x.ip)).not.toContain('198.51.100.50');
    expect((await post('/api/bans/unban', { ip: '198.51.100.50' })).status).toBe(404);
  });

  it('нода офлайн: бан сохраняется, а при подключении уходит полной синхронизацией с оставшимся сроком', async () => {
    const c = await h.makeNode('Позже');
    const r = await post('/api/bans', { ip: '198.51.100.60', nodeIds: [c.id], durationSec: 7200 });
    expect(r.json.outcomes[0]).toMatchObject({ applied: false, error: null });
    let full: any;
    const ag = await FakeAgent.connect(h.base, c.key);
    ag.handlers.apply_bans = (cmd) => ((full = cmd.args), { ok: true, data: { active: 1, rejected: [] } });
    // обработчик ставится после подключения, поэтому переподключаемся: синхронизация идёт сразу после hello
    ag.close();
    await ag.closed;
    const ag2 = await new Promise<FakeAgent>((resolve) => {
      const p = FakeAgent.connect(h.base, c.key);
      void p.then(resolve);
    });
    await until(() => ag2.messages.some((m) => m.t === 'cmd' && m.op === 'apply_bans'));
    const cmd = ag2.messages.find((m) => m.t === 'cmd' && m.op === 'apply_bans');
    expect(cmd.args.full).toBe(true);
    expect(cmd.args.ban).toHaveLength(1);
    expect(cmd.args.ban[0].ip).toBe('198.51.100.60');
    expect(cmd.args.ban[0].ttlSec).toBeGreaterThan(7100);
    expect(cmd.args.ban[0].ttlSec).toBeLessThanOrEqual(7200);
    void full;
    ag2.close();
  });

  it('истёкшие баны не показываются', async () => {
    await h.ctx.db.insert(schema.bans).values({ ip: '198.51.100.99', nodeId: a.id, createdBy: 'x', expiresAt: new Date(Date.now() - 1000) });
    expect((await get('/api/bans')).json.bans.map((x: any) => x.ip)).not.toContain('198.51.100.99');
  });
});

describe('персональные лимиты скорости', () => {
  it('на HAProxy < 2.7 лимит не ставится', async () => {
    const r = await post('/api/limits', { ip: '198.51.100.7', nodeIds: [b.id], mbit: 10 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('bwlim_unsupported');
  });

  it('лимит попадает в конфиг ноды и требует применения; удаление убирает его', async () => {
    const before = (await get(`/api/nodes/${a.id}/config`)).json.desired.cfg;
    expect(before).not.toContain('bwlim');
    const r = await post('/api/limits', { ip: '198.51.100.7', nodeIds: [a.id], mbit: 10, note: 'качает за троих' });
    expect(r.status).toBe(201);
    expect(r.json.needsApply).toBe(true);
    const st = (await get(`/api/nodes/${a.id}/config`)).json;
    expect(st.desired.cfg).toContain('filter bwlim-out dl_10m limit 1250000 key src table st_bwlim');
    expect(st.desired.cfg).toContain('set-bandwidth-limit dl_10m if { src 198.51.100.7 }');
    expect(st.inSync).toBe(false);

    const clients = (await get('/api/clients')).json.rows;
    expect(clients.find((c: any) => c.ip === '198.51.100.7' && c.nodeId === a.id).limit).toMatchObject({ mbit: 10 });
    const list = (await get('/api/limits')).json.limits;
    expect(list).toHaveLength(1);

    // изменение лимита — обновление, а не дубль
    await post('/api/limits', { ip: '198.51.100.7', nodeIds: [a.id], mbit: 20 });
    expect((await get('/api/limits')).json.limits).toHaveLength(1);
    expect((await get(`/api/nodes/${a.id}/config`)).json.desired.cfg).toContain('dl_20m');

    await del(`/api/limits/${list[0].id}`);
    expect((await get(`/api/nodes/${a.id}/config`)).json.desired.cfg).not.toContain('bwlim');
  });

  it('валидация: адрес инфраструктуры, диапазон лимита', async () => {
    expect((await post('/api/limits', { ip: '203.0.113.5', nodeIds: [a.id], mbit: 10 })).status).toBe(400);
    expect((await post('/api/limits', { ip: '198.51.100.7', nodeIds: [a.id], mbit: 0 })).status).toBe(400);
    expect((await post('/api/limits', { ip: 'zzz', nodeIds: [a.id], mbit: 5 })).status).toBe(400);
  });

  it('общий лимит ноды тоже превращается в bwlim, а на старом HAProxy молча гасится', async () => {
    await h.admin.req('PATCH', `/api/nodes/${a.id}`, { defaultIpLimitMbit: 100 });
    await h.admin.req('PATCH', `/api/nodes/${b.id}`, { defaultIpLimitMbit: 100 });
    expect((await get(`/api/nodes/${a.id}/config`)).json.desired.cfg).toContain('dl_default limit 12500000');
    expect((await get(`/api/nodes/${b.id}/config`)).json.desired.cfg).not.toContain('bwlim'); // 2.6: не поддерживается
  });
});

describe('аккаунт и сессии', () => {
  it('смена логина требует пароль, занятый логин отклоняется', async () => {
    expect((await h.admin.req('PATCH', '/api/account', { login: 'boss', password: 'wrong-password-123' })).status).toBe(400);
    await h.ctx.db.insert(schema.users).values({ login: 'other', passwordHash: 'x' });
    expect((await h.admin.req('PATCH', '/api/account', { login: 'other', password: PASSWORD })).status).toBe(409);
    expect((await h.admin.req('PATCH', '/api/account', { login: 'A B', password: PASSWORD })).status).toBe(400);
    const ok = await h.admin.req('PATCH', '/api/account', { login: 'boss', password: PASSWORD });
    expect(ok.json.login).toBe('boss');
    expect((await get('/api/account')).json.login).toBe('boss');
    const aud = await h.ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'account.login_changed'));
    expect(aud.at(-1)!.diff).toEqual({ from: 'admin', to: 'boss' });
    await h.admin.req('PATCH', '/api/account', { login: 'admin', password: PASSWORD });
  });

  it('список сессий: текущая помечена; чужую можно завершить, текущую — нет; массовое завершение', async () => {
    // вторая сессия того же пользователя
    const [u] = await h.ctx.db.select().from(schema.users).where(eq(schema.users.login, 'admin'));
    const { createSession } = await import('../src/lib/auth.js');
    const other = await createSession(h.ctx.db, u!.id, true, { ip: '198.51.100.1', userAgent: 'Firefox' });
    const s2 = new Session(h.base);
    s2.cookie = `popug_sid=${other.token}`;
    expect((await s2.req('GET', '/api/auth/me')).status).toBe(200);

    const list = (await get('/api/account/sessions')).json.sessions;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.filter((s: any) => s.current)).toHaveLength(1);
    const cur = list.find((s: any) => s.current);
    expect((await del(`/api/account/sessions/${cur.id}`)).status).toBe(400);
    const foreign = list.find((s: any) => !s.current && s.userAgent === 'Firefox');
    expect((await del(`/api/account/sessions/${foreign.id}`)).status).toBe(200);
    expect((await s2.req('GET', '/api/auth/me')).status).toBe(401); // сессия умерла
    expect((await get('/api/auth/me')).status).toBe(200); // наша жива

    const o2 = await createSession(h.ctx.db, u!.id, true, {});
    const r = await post('/api/account/sessions/revoke-others');
    expect(r.json.revoked).toBeGreaterThanOrEqual(1);
    const s3 = new Session(h.base);
    s3.cookie = `popug_sid=${o2.token}`;
    expect((await s3.req('GET', '/api/auth/me')).status).toBe(401);
  });

  it('перенастройка TOTP: пароль и код обязательны; после неё нужно настроить заново', async () => {
    const [u] = await h.ctx.db.select().from(schema.users).where(eq(schema.users.login, 'admin'));
    const secret = decryptSecret(u!.totpSecretEnc!, h.ctx.config.APP_SECRET);
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 });
    expect((await post('/api/account/totp/restart', { password: 'wrong-password-123', code: totp.generate() })).status).toBe(400);
    expect((await post('/api/account/totp/restart', { password: PASSWORD, code: '000000' })).status).toBe(400);
    await h.ctx.db.update(schema.users).set({ totpLastStep: null }).where(eq(schema.users.id, u!.id));
    const r = await post('/api/account/totp/restart', { password: PASSWORD, code: totp.generate() });
    expect(r.json.status).toBe('totp_setup');
    expect((await get('/api/auth/me')).json.status).toBe('totp_setup');
    expect((await get('/api/nodes')).status).toBe(401); // до новой настройки API закрыт
    const setup = await get('/api/auth/totp/setup');
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json.secret), digits: 6, period: 30 }).generate();
    expect((await post('/api/auth/totp/enable', { code })).status).toBe(200);
    expect((await get('/api/nodes')).status).toBe(200);
  });
});

describe('обновление агента по кнопке', () => {
  const release = (over: Record<string, unknown> = {}) => () => ({ version: '0.3.0', files: { amd64: { sha256: 'd'.repeat(64), signed: true } }, hasPublicKey: true, ...over });

  it('успех: агент получает версию и хеш бинарника, путей и URL в команде нет', async () => {
    h.ctx.release = release();
    await h.ctx.db.update(schema.nodes).set({ agentVersion: '0.2.0', arch: 'amd64', updateReady: true }).where(eq(schema.nodes.id, a.id));
    let got: any;
    agA.handlers.update_agent = (c) => ((got = c.args), { ok: true, data: { from: '0.2.0', to: '0.3.0', restarting: true } });
    const r = await post(`/api/nodes/${a.id}/agent/update`);
    expect(r.json).toMatchObject({ ok: true, from: '0.2.0', to: '0.3.0', restarting: true });
    expect(got).toEqual({ version: '0.3.0', sha256: 'd'.repeat(64) });
    const aud = await h.ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'agent.update'));
    expect(aud.at(-1)!.diff).toMatchObject({ from: '0.2.0', to: '0.3.0', ok: true });
  });

  it('отказы с понятными причинами: актуален, старый агент, нет ключа, не подписан, нет релиза', async () => {
    const set = (v: Record<string, unknown>) => h.ctx.db.update(schema.nodes).set(v).where(eq(schema.nodes.id, a.id));
    await set({ agentVersion: '0.3.0' });
    expect((await post(`/api/nodes/${a.id}/agent/update`)).json.error).toBe('up_to_date');
    await set({ agentVersion: '0.2.0', updateReady: false });
    expect((await post(`/api/nodes/${a.id}/agent/update`)).json.error).toBe('no_key');
    await set({ updateReady: true });
    h.ctx.release = release({ files: { amd64: { sha256: 'd'.repeat(64), signed: false } } });
    expect((await post(`/api/nodes/${a.id}/agent/update`)).json.error).toBe('unsigned');
    h.ctx.release = release({ version: null });
    expect((await post(`/api/nodes/${a.id}/agent/update`)).json.error).toBe('no_release');
    h.ctx.release = release();
    const old = await h.makeNode('Древний', { agentVersion: '0.1.0' });
    const ag = await FakeAgent.connect(h.base, old.key, { ops: ['ping', 'get_config'] });
    const r = await post(`/api/nodes/${old.id}/agent/update`);
    expect(r.json.error).toBe('agent_outdated');
    expect(r.json.message).toMatch(/команд/);
    ag.close();
  });

  it('ошибка агента (подпись не сошлась) доходит до пользователя', async () => {
    agA.handlers.update_agent = () => ({ ok: false, error: 'подпись бинарника не сходится с закреплённым ключом: обновление отклонено' });
    const r = await post(`/api/nodes/${a.id}/agent/update`);
    expect(r.status).toBe(502);
    expect(r.json.message).toMatch(/подпись/);
  });
});
