import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { createServer } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judge, probeTls, runPanelChecks, worst } from '../src/lib/checks.js';
import { FakeAgent, makeHarness, until, type Harness } from './harness.js';

let h: Harness;
let a: { id: string; key: string };
let b: { id: string; key: string };
let exitDe: string;
let exitNl: string;
beforeAll(async () => {
  h = await makeHarness();
  a = await h.makeNode('Aeza');
  b = await h.makeNode('Хорёк');
});
afterAll(() => h.close());

const post = (p: string, body?: unknown) => h.admin.req('POST', p, body ?? {});
const get = (p: string) => h.admin.req('GET', p);

const okApply = (version = 0) => ({ ok: true, data: { version, applied: true, rolledBack: false, rollbackFailed: false, sha256: 'a'.repeat(64), output: 'Configuration file is valid', durationMs: 120 } });

describe('выходы', () => {
  it('создание, валидация, дубликат по адресу', async () => {
    const r = await post('/api/exits', { name: 'Германия 1', country: 'de', host: '203.0.113.21', port: 443 });
    expect(r.status).toBe(201);
    expect(r.json.exit.country).toBe('DE'); // регистр нормализуется
    exitDe = r.json.exit.id;
    const n = await post('/api/exits', { name: 'Нидерланды 1', country: 'NL', host: '203.0.113.31', port: 443 });
    exitNl = n.json.exit.id;
    expect((await post('/api/exits', { name: 'Дубль', host: '203.0.113.21', port: 443 })).status).toBe(409);
    expect((await post('/api/exits', { name: 'x', host: '1.2.3.4 evil', port: 443 })).status).toBe(400);
    expect((await post('/api/exits', { name: 'x', host: '1.2.3.4', port: 70000 })).status).toBe(400);
    expect((await post('/api/exits', { name: 'x', country: 'GERMANY', host: '1.2.3.5' })).status).toBe(400);
  });
});

describe('маршруты на нескольких нодах', () => {
  let routeId: string;
  it('создаётся один маршрут сразу для двух нод', async () => {
    const r = await post('/api/routes', { name: 'Германия (🇷🇺 → 🇩🇪)', slug: 'de', snis: ['DE.popug.cloud', 'de.popug.cloud'], exitIds: [exitDe], nodeIds: [a.id, b.id], proxyProtocol: true });
    expect(r.status).toBe(201);
    routeId = r.json.route.id;
    expect(r.json.route.snis).toEqual(['de.popug.cloud']); // регистр и дубли схлопнулись
    expect(r.json.route.nodes.map((n: any) => n.nodeName).sort()).toEqual(['Aeza', 'Хорёк']);
  });

  it('конфликты: идентификатор, SNI на общей ноде, пустые SNI/выходы у включённого', async () => {
    expect((await post('/api/routes', { name: 'x', slug: 'de', snis: ['x.example.com'], exitIds: [exitNl], nodeIds: [a.id] })).status).toBe(409);
    const c = await post('/api/routes', { name: 'x', slug: 'x1', snis: ['de.popug.cloud'], exitIds: [exitNl], nodeIds: [b.id] });
    expect(c.status).toBe(409);
    expect(c.json.error).toBe('sni_conflict');
    expect(c.json.message).toMatch(/Хорёк/);
    expect((await post('/api/routes', { name: 'x', slug: 'x2', snis: [], exitIds: [exitNl], nodeIds: [a.id] })).status).toBe(400);
    expect((await post('/api/routes', { name: 'x', slug: 'x3', snis: ['q.example.com'], exitIds: [], nodeIds: [a.id] })).status).toBe(400);
    expect((await post('/api/routes', { name: 'x', slug: 'Bad Slug', snis: ['q.example.com'], exitIds: [exitNl], nodeIds: [a.id] })).status).toBe(400);
    // тот же SNI на ДРУГОЙ ноде — не конфликт
    const c2 = await get('/api/nodes');
    expect(c2.status).toBe(200);
  });

  it('одинаковый маршрут даёт одинаковый конфиг на обеих нодах', async () => {
    const ca = (await get(`/api/nodes/${a.id}/config`)).json;
    const cb = (await get(`/api/nodes/${b.id}/config`)).json;
    expect(ca.desired.cfg).toBe(cb.desired.cfg);
    expect(ca.desired.sniMap).toBe('de.popug.cloud be_de\n');
    expect(ca.desired.cfg).toContain('server de1 203.0.113.21:443 check inter 10s fall 3 rise 2 send-proxy-v2');
    expect(ca.inSync).toBe(false);
    expect(ca.applied).toBeNull();
  });

  it('выход нельзя удалить, пока он в маршруте', async () => {
    const r = await h.admin.req('DELETE', `/api/exits/${exitDe}`);
    expect(r.status).toBe(409);
    expect(r.json.message).toMatch(/Германия/);
  });

  it('PATCH меняет только переданное: отключение не стирает SNI, выходы и ноды; правка имени выхода не сбрасывает порт', async () => {
    const before = (await get(`/api/routes/${routeId}`)).json.route;
    await h.admin.req('PATCH', `/api/routes/${routeId}`, { enabled: false });
    const off = (await get(`/api/routes/${routeId}`)).json.route;
    expect(off).toMatchObject({ enabled: false, snis: before.snis, nodeIds: before.nodeIds, proxyProtocol: true });
    expect(off.exits.map((e: any) => e.id)).toEqual(before.exits.map((e: any) => e.id));
    await h.admin.req('PATCH', `/api/routes/${routeId}`, { enabled: true });
    const e = await h.admin.req('POST', '/api/exits', { name: 'Порт 8443', host: '203.0.113.99', port: 8443 });
    const up = await h.admin.req('PATCH', `/api/exits/${e.json.exit.id}`, { name: 'Переименован' });
    expect(up.json.exit).toMatchObject({ name: 'Переименован', port: 8443, host: '203.0.113.99' });
    await h.admin.req('DELETE', `/api/exits/${e.json.exit.id}`);
  });

  it('маршрут отключается и исчезает из конфига', async () => {
    await h.admin.req('PATCH', `/api/routes/${routeId}`, { enabled: false });
    expect((await get(`/api/nodes/${a.id}/config`)).json.desired.sniMap).toBe('');
    await h.admin.req('PATCH', `/api/routes/${routeId}`, { enabled: true });
    expect((await get(`/api/nodes/${a.id}/config`)).json.desired.sniMap).toContain('be_de');
  });
});

describe('применение конфига: у каждой ноды свой дифф, своя попытка и свой откат', () => {
  let agA: FakeAgent;
  let agB: FakeAgent;
  beforeAll(async () => {
    agA = await FakeAgent.connect(h.base, a.key);
    agB = await FakeAgent.connect(h.base, b.key);
  });
  afterAll(() => {
    agA.close();
    agB.close();
  });

  it('агент получает список проверок: выход × первый SNI, с признаком PROXY', async () => {
    await until(() => agA.of('checks_config').length > 0);
    const cc = agA.of('checks_config').at(-1);
    expect(cc.intervalSec).toBe(30);
    expect(cc.targets).toHaveLength(1);
    expect(cc.targets[0]).toMatchObject({ host: '203.0.113.21', port: 443, sni: 'de.popug.cloud', proxy: true });
  });

  it('успешное применение на A; хеш-страховка и офлайн-нода отклоняются', async () => {
    let received: any;
    agA.handlers.apply_config = (cmd) => ((received = cmd.args), okApply(cmd.args.version));
    const st = (await get(`/api/nodes/${a.id}/config`)).json;

    expect((await post(`/api/nodes/${a.id}/config/apply`, { expectedHash: 'f'.repeat(64) })).json.error).toBe('changed');

    const r = await post(`/api/nodes/${a.id}/config/apply`, { expectedHash: st.desired.sha256 });
    expect(r.json.ok).toBe(true);
    expect(r.json.version).toMatchObject({ number: 1, status: 'applied', createdBy: 'admin' });
    expect(received.cfg).toBe(st.desired.cfg);
    expect(received.sniMap).toBe(st.desired.sniMap);
    expect(received).not.toHaveProperty('path'); // в команде нет путей: агент пишет только в свои файлы

    const after = (await get(`/api/nodes/${a.id}/config`)).json;
    expect(after.inSync).toBe(true);
    expect(after.applied.number).toBe(1);
    const audits = await h.ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'config.apply'));
    expect(audits.at(-1)!.diff).toMatchObject({ version: 1, status: 'applied', ok: true });
  });

  it('нода без агента: применение отклоняется с понятной причиной', async () => {
    const off = await h.makeNode('Офлайн');
    await post(`/api/routes`, { name: 'Нидерланды', slug: 'nl', snis: ['nl.popug.cloud'], exitIds: [exitNl], nodeIds: [off.id] });
    const st = (await get(`/api/nodes/${off.id}/config`)).json;
    const r = await post(`/api/nodes/${off.id}/config/apply`, { expectedHash: st.desired.sha256 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('offline');
  });

  it('изменили маршрут: обе ноды расходятся с панелью; A применилась, B откатилась — A не затронута', async () => {
    const route = (await get('/api/routes')).json.routes.find((r: any) => r.slug === 'de');
    await h.admin.req('PATCH', `/api/routes/${route.id}`, { snis: ['de.popug.cloud', 'www.de.popug.cloud'] });
    const sa = (await get(`/api/nodes/${a.id}/config`)).json;
    const sb = (await get(`/api/nodes/${b.id}/config`)).json;
    expect(sa.inSync).toBe(false);
    expect(sb.inSync).toBe(false);
    expect(sa.desired.sha256).toBe(sb.desired.sha256);

    agA.handlers.apply_config = (cmd) => okApply(cmd.args.version);
    agB.handlers.apply_config = (cmd) => ({
      ok: false,
      error: 'конфиг не применился, возвращён прежний: HAProxy не поднялся',
      data: { version: cmd.args.version, applied: false, rolledBack: true, rollbackFailed: false, sha256: 'b'.repeat(64), output: "[ALERT] cannot bind socket [0.0.0.0:443]", durationMs: 4100 },
    });

    const ra = await post(`/api/nodes/${a.id}/config/apply`, { expectedHash: sa.desired.sha256 });
    const rb = await post(`/api/nodes/${b.id}/config/apply`, { expectedHash: sb.desired.sha256 });
    expect(ra.json.ok).toBe(true);
    expect(rb.json.ok).toBe(false);
    expect(rb.json.rolledBack).toBe(true);
    expect(rb.json.output).toContain('cannot bind socket');
    expect(rb.json.version.status).toBe('rolled_back');

    const afterA = (await get(`/api/nodes/${a.id}/config`)).json;
    const afterB = (await get(`/api/nodes/${b.id}/config`)).json;
    expect(afterA.inSync).toBe(true);
    expect(afterA.applied.number).toBe(2);
    expect(afterB.inSync).toBe(false); // всё ещё ждёт применения
    expect(afterB.lastFailed).toMatchObject({ number: 1, status: 'rolled_back' });
    expect(afterB.applied).toBeNull(); // прежнее состояние B не тронуто
    // у каждой ноды своя нумерация версий
    expect(afterB.versions).toHaveLength(1);
  });

  it('повторная попытка на B после исправления проходит', async () => {
    agB.handlers.apply_config = (cmd) => okApply(cmd.args.version);
    const sb = (await get(`/api/nodes/${b.id}/config`)).json;
    const r = await post(`/api/nodes/${b.id}/config/apply`, { expectedHash: sb.desired.sha256 });
    expect(r.json.ok).toBe(true);
    expect(r.json.version.number).toBe(2);
    expect((await get(`/api/nodes/${b.id}/config`)).json.lastFailed).toBeNull();
  });

  it('validate: проверка без применения, версия не создаётся', async () => {
    let args: any;
    agA.handlers.apply_config = (cmd) => ((args = cmd.args), { ok: true, data: { version: 0, applied: false, rolledBack: false, rollbackFailed: false, sha256: null, output: 'Configuration file is valid', durationMs: 5 } });
    const sa = (await get(`/api/nodes/${a.id}/config`)).json;
    const before = sa.versions.length;
    const r = await post(`/api/nodes/${a.id}/config/validate`, { expectedHash: sa.desired.sha256 });
    expect(r.json).toMatchObject({ ok: true });
    expect(r.json.output).toContain('valid');
    expect(args.validateOnly).toBe(true);
    expect((await get(`/api/nodes/${a.id}/config`)).json.versions).toHaveLength(before);
  });

  it('агент не ответил на применение: версия помечена failed; по хешу из hello она подтверждается', async () => {
    const c = await h.makeNode('Тихая');
    await post('/api/routes', { name: 'Эстония', slug: 'ee', snis: ['ee.popug.cloud'], exitIds: [exitNl], nodeIds: [c.id] });
    const ag = await FakeAgent.connect(h.base, c.key);
    ag.handlers.apply_config = () => ({ ok: false, error: 'агент не ответил вовремя' });
    const st = (await get(`/api/nodes/${c.id}/config`)).json;
    const r = await post(`/api/nodes/${c.id}/config/apply`, { expectedHash: st.desired.sha256 });
    expect(r.json.version.status).toBe('failed');
    ag.close();
    await ag.closed;
    // агент переподключается и сообщает хеш конфига, который реально лежит на ноде
    const { createHash } = await import('node:crypto');
    const ag2 = await FakeAgent.connect(h.base, c.key, { configSha256: createHash('sha256').update(st.desired.cfg).digest('hex') });
    await until(async () => (await get(`/api/nodes/${c.id}/config`)).json.inSync === true);
    expect((await get(`/api/nodes/${c.id}/config`)).json.applied.number).toBe(1);
    ag2.close();
  });

  it('дрейф: конфиг на ноде изменён вне панели', async () => {
    await h.ctx.db.update(schema.nodes).set({ configSha256: 'c'.repeat(64) }).where(eq(schema.nodes.id, a.id));
    expect((await get(`/api/nodes/${a.id}/config`)).json.drift).toBe(true);
  });
});

describe('старый агент без apply_config', () => {
  it('применение отклоняется заранее: версия не создаётся, причина понятна', async () => {
    const old = await h.makeNode('Старый');
    const r0 = await post('/api/routes', { name: 'Польша', slug: 'pl', snis: ['pl.popug.cloud'], exitIds: [exitNl], nodeIds: [old.id] });
    expect(r0.status).toBe(201);
    const ag = await FakeAgent.connect(h.base, old.key, { ops: ['ping', 'get_config'] }); // агент этапа 1
    const st = (await get(`/api/nodes/${old.id}/config`)).json;
    const r = await post(`/api/nodes/${old.id}/config/apply`, { expectedHash: st.desired.sha256 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('agent_outdated');
    expect(r.json.message).toMatch(/Обновите/);
    expect((await get(`/api/nodes/${old.id}/config`)).json.versions).toHaveLength(0);
    ag.close();
  });
});

describe('настройки ноды', () => {
  it('свои директивы: запрещённые отклоняются, разрешённые попадают в конфиг', async () => {
    const bad = await h.admin.req('PATCH', `/api/nodes/${a.id}`, { extraConfig: 'program x\n    command /bin/sh\n' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('forbidden_directive');
    const ok = await h.admin.req('PATCH', `/api/nodes/${a.id}`, { extraConfig: 'listen stats\n    bind 127.0.0.1:8404\n    mode http\n    stats enable' });
    expect(ok.status).toBe(200);
    expect((await get(`/api/nodes/${a.id}/config`)).json.desired.cfg).toContain('listen stats');
  });

  it('маршрут по умолчанию — только из привязанных к ноде', async () => {
    const routes = (await get('/api/routes')).json.routes;
    const nl = routes.find((r: any) => r.slug === 'nl');
    const de = routes.find((r: any) => r.slug === 'de');
    expect((await h.admin.req('PATCH', `/api/nodes/${a.id}`, { defaultRouteId: nl.id })).status).toBe(400);
    expect((await h.admin.req('PATCH', `/api/nodes/${a.id}`, { defaultRouteId: de.id })).status).toBe(200);
    expect((await get(`/api/nodes/${a.id}/config`)).json.desired.cfg).toContain('default_backend be_de');
  });
});

describe('проверки и статусы', () => {
  it('judge: красный, жёлтый, зелёный, нет данных', () => {
    const now = new Date();
    const r = (source: string, ok: boolean, ms: number | null = 40) => ({ source, ok, ms: ok ? ms : null, ts: now });
    expect(judge([]).tone).toBe('unknown');
    expect(judge([r('agent', true), r('panel', true)]).tone).toBe('ok');
    expect(judge([r('agent', false), r('agent', false), r('panel', true)]).tone).toBe('bad'); // мост не доходит до выхода
    expect(judge([r('agent', true), r('panel', false)]).tone).toBe('bad'); // снаружи недоступен
    expect(judge([r('agent', true), r('agent', false), r('panel', true)]).tone).toBe('warn'); // частичные ошибки
    expect(judge([r('agent', true, 2500), r('panel', true, 1800)]).tone).toBe('warn'); // медленно
    expect(worst(['ok', 'warn', 'unknown'])).toBe('warn');
    expect(worst(['unknown', 'unknown'])).toBe('unknown');
    expect(worst(['ok', 'bad', 'warn'])).toBe('bad');
  });

  it('результаты агента сохраняются, чужие маршруты игнорируются, статус считается', async () => {
    const route = (await get('/api/routes')).json.routes.find((r: any) => r.slug === 'de');
    const ag = await FakeAgent.connect(h.base, a.key);
    const nlRoute = (await get('/api/routes')).json.routes.find((r: any) => r.slug === 'nl'); // не привязан к A
    ag.send({ t: 'checks', ts: Date.now(), results: [
      { routeId: route.id, exitId: exitDe, ok: true, ms: 41, error: null },
      { routeId: nlRoute.id, exitId: exitNl, ok: true, ms: 10, error: null },
      { routeId: '../../etc/passwd', exitId: 'x', ok: true, ms: 1, error: null },
    ] });
    await until(async () => (await h.ctx.db.select().from(schema.checkResults)).length > 0);
    const rows = await h.ctx.db.select().from(schema.checkResults);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routeId: route.id, nodeId: a.id, source: 'agent', ok: true });

    const st = (await get(`/api/routes/${route.id}`)).json;
    const na = st.route.nodes.find((n: any) => n.nodeId === a.id);
    const nb = st.route.nodes.find((n: any) => n.nodeId === b.id);
    expect(na.tone).toBe('ok');
    expect(nb.tone).toBe('unknown'); // для B данных нет
    expect(st.route.status).toBe('ok');

    ag.send({ t: 'checks', ts: Date.now(), results: [{ routeId: route.id, exitId: exitDe, ok: false, ms: null, error: 'dial tcp: i/o timeout' }] });
    await until(async () => (await get(`/api/routes/${route.id}`)).json.route.status === 'warn');
    ag.send({ t: 'checks', ts: Date.now(), results: Array(6).fill({ routeId: route.id, exitId: exitDe, ok: false, ms: null, error: 'timeout' }) });
    // успешная проверка выше всё ещё в окне → warn; очищаем окно, чтобы увидеть красный
    await h.ctx.db.update(schema.checkResults).set({ ok: false, ms: null, error: 'timeout' }).where(eq(schema.checkResults.routeId, route.id));
    expect((await get(`/api/routes/${route.id}`)).json.route.status).toBe('bad');
    expect((await get(`/api/routes/${route.id}`)).json.history.length).toBeGreaterThan(1);
    ag.close();
  });

  it('ручной запуск: run_checks доходит до агента, результаты записываются', async () => {
    const route = (await get('/api/routes')).json.routes.find((r: any) => r.slug === 'de');
    const ag = await FakeAgent.connect(h.base, b.key);
    ag.handlers.run_checks = () => ({ ok: true, data: { results: [{ routeId: route.id, exitId: exitDe, ok: true, ms: 55, error: null }] } });
    const before = (await h.ctx.db.select().from(schema.checkResults).where(eq(schema.checkResults.nodeId, b.id))).length;
    const r = await post(`/api/nodes/${b.id}/checks/run`);
    expect(r.json.agent).toBe(1);
    const list = (await get(`/api/nodes/${b.id}/checks`)).json.results;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty('routeName');
    expect((await h.ctx.db.select().from(schema.checkResults).where(eq(schema.checkResults.nodeId, b.id))).length).toBeGreaterThan(before);
    ag.close();
  });
});

describe('импорт существующего конфига', () => {
  const HAND = `global\n    daemon\ndefaults\n    mode tcp\nbackend st_clients\n    stick-table type ipv6 size 200k expire 24h store conn_cur\nfrontend fe_sni\n    bind :443\n    use_backend be_se if { req_ssl_sni -i se.popug.cloud }\n    use_backend be_de if { req_ssl_sni -i de.popug.cloud www.de.popug.cloud }\n    default_backend be_se\nbackend be_se\n    server se1 203.0.113.11:443 check\nbackend be_de\n    server de1 203.0.113.21:443 check send-proxy-v2\nfrontend fe_metrics\n    bind :9443\n`;
  let c: { id: string; key: string };
  let ag: FakeAgent;
  beforeAll(async () => {
    c = await h.makeNode('Ручная');
    ag = await FakeAgent.connect(h.base, c.key);
    ag.handlers.get_config = () => ({ ok: true, data: { path: '/etc/haproxy/haproxy.cfg', content: HAND, sha256: '0'.repeat(64) } });
  });
  afterAll(() => ag.close());

  it('предпросмотр ничего не меняет и показывает, что есть в панели', async () => {
    expect((await get(`/api/nodes/${c.id}/config`)).json.importPending).toBe(true);
    const routesBefore = (await get('/api/routes')).json.routes.length;
    const r = await post(`/api/nodes/${c.id}/import/preview`);
    expect(r.status).toBe(200);
    expect(r.json.preview.routes.map((x: any) => x.slug)).toEqual(['de', 'se']);
    expect(r.json.matches.be_de.exitIds[0]).toBe(exitDe); // выход уже есть → будет переиспользован
    expect(r.json.matches.be_de.routeName).toMatch(/Германия/); // и маршрут de уже есть
    expect(r.json.preview.ignoredSections.map((s: any) => s.name)).toContain('fe_metrics');
    expect((await get('/api/routes')).json.routes.length).toBe(routesBefore); // «до подтверждения не трогать»
    expect((await get(`/api/nodes/${c.id}/config`)).json.applied).toBeNull();
  });

  it('подтверждение: новый маршрут создаётся, существующий — привязывается; версия 1 — снимок ручного конфига', async () => {
    const p = (await post(`/api/nodes/${c.id}/import/preview`)).json;
    const de = (await get('/api/routes')).json.routes.find((x: any) => x.slug === 'de');
    const body = {
      cfgSha256: p.cfgSha256,
      defaultBackend: 'be_se',
      routes: [
        { backend: 'be_de', slug: 'de', name: 'Германия', snis: ['de.popug.cloud', 'www.de.popug.cloud'], proxyProtocol: true, healthCheck: true, attachToRouteId: de.id, exits: [{ host: '203.0.113.21', port: 443, name: 'de1', country: 'DE' }] },
        { backend: 'be_se', slug: 'se', name: 'Швеция (🇷🇺 → 🇸🇪)', snis: ['se.popug.cloud'], proxyProtocol: false, healthCheck: true, attachToRouteId: null, exits: [{ host: '203.0.113.11', port: 443, name: 'Швеция 1', country: 'SE' }] },
      ],
    };
    // конфиг на ноде успел измениться → отказ
    ag.handlers.get_config = () => ({ ok: true, data: { path: '/etc/haproxy/haproxy.cfg', content: HAND + '# правка\n', sha256: '1'.repeat(64) } });
    expect((await post(`/api/nodes/${c.id}/import/confirm`, body)).json.error).toBe('changed');
    ag.handlers.get_config = () => ({ ok: true, data: { path: '/etc/haproxy/haproxy.cfg', content: HAND, sha256: '0'.repeat(64) } });

    const r = await post(`/api/nodes/${c.id}/import/confirm`, body);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ routes: 1, attached: 1, exits: 1 });

    const st = (await get(`/api/nodes/${c.id}/config`)).json;
    expect(st.importPending).toBe(false);
    expect(st.applied).toMatchObject({ number: 1, source: 'import', status: 'imported' });
    expect(st.applied.cfg).toBe(HAND);
    expect(st.inSync).toBe(false); // панель хочет свой конфиг — дифф покажет разницу
    const routes = (await get(`/api/nodes/${c.id}/routes`)).json.routes;
    expect(routes.map((x: any) => x.slug).sort()).toEqual(['de', 'se']);
    // маршрут de теперь на трёх нодах, а не дублируется
    expect((await get('/api/routes')).json.routes.filter((x: any) => x.slug === 'de')).toHaveLength(1);
    expect((await get('/api/routes')).json.routes.find((x: any) => x.slug === 'de').nodeIds).toContain(c.id);
    // маршрут по умолчанию выставлен
    expect((await get(`/api/nodes/${c.id}/config`)).json.desired.cfg).toContain('default_backend be_se');
  });
});

describe('сквозная проверка панели: TLS-рукопожатие с SNI маршрута', () => {
  // самоподписанный сертификат для локального TLS-сервера (openssl есть везде, где есть Docker и Node)
  const dir = mkdtempSync(join(tmpdir(), 'popug-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=test'], { stdio: 'ignore' });

  it('успех и SNI доходит до сервера; закрытый порт и таймаут — ошибка', async () => {
    let gotSni = '';
    const srv = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')), SNICallback: (name, cb) => { gotSni = name; cb(null); } }, (s) => s.end());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as any).port;
    const ok = await probeTls('127.0.0.1', port, 'de.popug.cloud');
    expect(ok).toMatchObject({ ok: true, error: null });
    expect(ok.ms).toBeGreaterThan(0);
    expect(gotSni).toBe('de.popug.cloud');
    srv.close();
    const refused = await probeTls('127.0.0.1', port, 'de.popug.cloud');
    expect(refused.ok).toBe(false);
    expect(refused.ms).toBeNull();
    expect(refused.error).toBeTruthy();
    // сервер принял TCP, но молчит: рукопожатие не завершается
    const mute = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, () => {});
    const net = await import('node:net');
    const silent = net.createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const t = await probeTls('127.0.0.1', (silent.address() as any).port, 'x.example.com', 300);
    expect(t).toMatchObject({ ok: false, ms: null });
    expect(t.error).toMatch(/таймаут/);
    silent.close();
    mute.close();
  });

  it('runPanelChecks пишет результаты по каждому маршруту ноды с SNI', async () => {
    const n = await h.makeNode('Снаружи', { ip: '127.0.0.1' });
    await post('/api/routes', { name: 'Чехия', slug: 'cz', snis: ['cz.popug.cloud'], exitIds: [exitNl], nodeIds: [n.id] });
    const seen: string[] = [];
    const count = await runPanelChecks(h.ctx.db, n.id, async (host, port, sni) => (seen.push(`${host}:${port}/${sni}`), { ok: true, ms: 12, error: null }));
    expect(count).toBe(1);
    expect(seen).toEqual(['127.0.0.1:443/cz.popug.cloud']);
    const rows = await h.ctx.db.select().from(schema.checkResults).where(eq(schema.checkResults.nodeId, n.id));
    expect(rows[0]).toMatchObject({ source: 'panel', exitId: null, ok: true });
  });
});
