import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { billingPeriod } from '../src/lib/quota.js';
import { clearAlert, evaluateAlerts, humanDuration, raiseAlert } from '../src/lib/alerts.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { putSetting } from '../src/lib/settings.js';
import { escapeHtml } from '../src/lib/telegram.js';
import { FakeAgent, Session, makeHarness, until, type Harness } from './harness.js';
import { metrics } from './helpers.js';

const TG_TOKEN = '123456789:AAEhBP0av28CHxyzabcdefghijklmnopqrs';
const MIN = 60_000;

let h: Harness;
let sent: { chat: string; text: string }[] = [];
let tgFail: { status: number; description: string } | null = null;
let tgThrow = false;

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('https://api.telegram.org/bot')) return new Response('{}', { status: 404 });
  if (tgThrow) throw new Error(`connect ECONNREFUSED ${url}`);
  if (tgFail) return Response.json({ ok: false, description: tgFail.description }, { status: tgFail.status });
  const body = JSON.parse(String(init?.body));
  sent.push({ chat: body.chat_id, text: body.text });
  return Response.json({ ok: true });
};

const setTelegram = (enabled = true) => putSetting(h.ctx.db, 'telegram', { enabled, tokenEnc: encryptSecret(TG_TOKEN, 'a'.repeat(40)), chatId: '-1001234567890' });
const rows = () => h.ctx.db.select().from(schema.alerts);
const ofKind = async (kind: string) => (await rows()).filter((a) => a.kind === kind);
const setRule = (kind: string, over: Partial<typeof schema.alertRules.$inferInsert>) => h.ctx.db.update(schema.alertRules).set(over).where(eq(schema.alertRules.kind, kind));

beforeAll(async () => {
  h = await makeHarness();
  h.ctx.http = fakeFetch;
}, 60_000);
afterAll(() => h.close());
beforeEach(async () => {
  sent = [];
  tgFail = null;
  tgThrow = false;
  await h.ctx.db.delete(schema.alerts);
  await h.ctx.db.delete(schema.nodes);
  await h.ctx.db.delete(schema.settings);
  await h.ctx.db.delete(schema.alertRules);
});

describe('вспомогательное', () => {
  it('длительности по-русски и экранирование HTML', () => {
    expect(humanDuration(20_000)).toBe('меньше минуты');
    expect(humanDuration(5 * MIN)).toBe('5 мин');
    expect(humanDuration(125 * MIN)).toBe('2 ч 5 мин');
    expect(humanDuration(26 * 60 * MIN)).toBe('26 ч');
    expect(humanDuration(60 * 60 * MIN)).toBe('2 д 12 ч');
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;');
  });
});

describe('нода не на связи', () => {
  it('ожидание → срабатывание через 2 минуты → без дублей → напоминание → «починилось»', async () => {
    await setTelegram();
    const node = await h.makeNode('Aeza · Стокгольм');
    const t0 = new Date('2026-11-06T12:00:00Z');
    expect(await evaluateAlerts(h.ctx, t0)).toMatchObject({ fired: 0, pending: 1 });
    expect(sent).toHaveLength(0); // ещё не продержалось два минуты
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + MIN));
    expect(sent).toHaveLength(0);
    expect(await evaluateAlerts(h.ctx, new Date(t0.getTime() + 2 * MIN))).toMatchObject({ fired: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat).toBe('-1001234567890');
    expect(sent[0]!.text).toContain('Нода не на связи');
    expect(sent[0]!.text).toContain('Aeza · Стокгольм');
    // дедупликация: следующие циклы молчат
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 10 * MIN));
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 60 * MIN));
    expect(sent).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    // напоминание раз в 6 часов
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 2 * MIN + 6 * 60 * MIN));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain('Всё ещё');
    // нода вернулась
    const ag = await FakeAgent.connect(h.base, node.key);
    const done = await evaluateAlerts(h.ctx, new Date(t0.getTime() + 7 * 60 * MIN));
    expect(done.resolved).toBe(1);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.text).toContain('Починилось');
    expect(sent[2]!.text).toMatch(/длилась 6 ч/);
    const [a] = await rows();
    expect(a).toMatchObject({ status: 'resolved', notifyCount: 3 });
    ag.close();
  });

  it('если нода вернулась раньше времени, алерт не рождается и не попадает в историю', async () => {
    await setTelegram();
    const node = await h.makeNode('Хорёк');
    const t0 = new Date();
    await evaluateAlerts(h.ctx, t0);
    expect(await rows()).toHaveLength(1);
    const ag = await FakeAgent.connect(h.base, node.key);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + MIN));
    expect(await rows()).toHaveLength(0);
    expect(sent).toHaveLength(0);
    ag.close();
  });

  it('ожидающие подключения и отозванные ноды — не авария', async () => {
    await h.makeNode('Новая', { keyHash: null });
    await h.makeNode('Отозвана', { keyRevokedAt: new Date() });
    expect(await evaluateAlerts(h.ctx)).toMatchObject({ fired: 0, pending: 0 });
  });

  it('порог времени и повтор настраиваются, выключенное правило молчит', async () => {
    await setTelegram();
    await h.makeNode('Aeza');
    const t0 = new Date();
    await evaluateAlerts(h.ctx, t0); // создаёт правила по умолчанию
    await setRule('node_offline', { forMin: 10, repeatHours: 1 });
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 5 * MIN));
    expect(sent).toHaveLength(0);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 10 * MIN));
    expect(sent).toHaveLength(1);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 71 * MIN));
    expect(sent).toHaveLength(2);
    // правило выключили, пока алерт горит: закрывается молча
    await setRule('node_offline', { enabled: false });
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 72 * MIN));
    expect(sent).toHaveLength(2);
    expect((await rows())[0]!.status).toBe('resolved');
  });
});

describe('квота', () => {
  const setUsage = async (nodeId: string, frac: number) => {
    const day = billingPeriod(1, new Date()).start;
    await h.ctx.db.delete(schema.nodeDaily);
    await h.ctx.db.insert(schema.nodeDaily).values({ nodeId, day, rxBytes: 0, txBytes: Math.round(frac * 1e12) });
  };

  it('80% — предупреждение, 95% — авария («стало хуже»), спад — «починилось»', async () => {
    await setTelegram();
    const n = await h.makeNode('cloud4box', { quotaTb: '1', billingDay: 1, quotaCounts: 'tx' });
    const ag = await FakeAgent.connect(h.base, n.key);
    const t = new Date();
    await setUsage(n.id, 0.5);
    await evaluateAlerts(h.ctx, t);
    expect(sent).toHaveLength(0);
    await setUsage(n.id, 0.83);
    await evaluateAlerts(h.ctx, t);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Квота хостера');
    expect(sent[0]!.text).toContain('83%');
    expect((await rows())[0]!.severity).toBe('warn');
    await evaluateAlerts(h.ctx, t);
    expect(sent).toHaveLength(1);
    await setUsage(n.id, 0.96);
    await evaluateAlerts(h.ctx, t);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain('Стало хуже');
    expect((await rows())[0]!.severity).toBe('crit');
    expect(await rows()).toHaveLength(1);
    await setUsage(n.id, 0.2);
    await evaluateAlerts(h.ctx, t);
    expect(sent[2]!.text).toContain('Починилось');
    ag.close();
  });

  it('ноды без квоты не беспокоят', async () => {
    const n = await h.makeNode('Без квоты');
    const ag = await FakeAgent.connect(h.base, n.key);
    await evaluateAlerts(h.ctx);
    expect(await rows()).toHaveLength(0);
    ag.close();
  });
});

describe('CPU, скорость IP, маршрут', () => {
  it('CPU выше порога дольше 15 минут', async () => {
    await setTelegram();
    const n = await h.makeNode('Aeza');
    const ag = await FakeAgent.connect(h.base, n.key);
    const t0 = new Date();
    // данные «живые» на момент каждой проверки (иначе панель считает их устаревшими)
    const at = async (min: number, cpu: number) => {
      const t = new Date(t0.getTime() + min * MIN);
      await h.ctx.ingestor.ingest(n.id, metrics({ cpu }), t.getTime());
      await evaluateAlerts(h.ctx, t);
    };
    await at(0, 92);
    await at(14, 92);
    expect(sent).toHaveLength(0);
    await at(15, 92);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('CPU');
    expect(sent[0]!.text).toContain('92%');
    await at(16, 30);
    expect(sent[1]!.text).toContain('Починилось');
    ag.close();
  });

  it('один IP быстрее 200 Мбит/с дольше 10 минут, по нескольким нодам отдельно', async () => {
    await setTelegram();
    const n = await h.makeNode('Aeza');
    const ag = await FakeAgent.connect(h.base, n.key);
    const m = metrics({});
    m.clients!.top = [
      { ip: '198.51.100.7', connCur: 5, connCnt: 50, bytesIn: 1, bytesOut: 1, rateIn: 1_000_000, rateOut: 30_000_000 }, // 240 Мбит/с
      { ip: '198.51.100.8', connCur: 1, connCnt: 1, bytesIn: 1, bytesOut: 1, rateIn: 100, rateOut: 1_000_000 }, // 8 Мбит/с
    ];
    await h.ctx.ingestor.ingest(n.id, m);
    const t0 = new Date();
    await evaluateAlerts(h.ctx, t0);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 9 * MIN));
    expect(sent).toHaveLength(0);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 10 * MIN));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('198.51.100.7');
    expect(sent[0]!.text).toContain('240');
    expect(sent[0]!.text).not.toContain('198.51.100.8');
    ag.close();
  });

  it('маршрут красный дольше 2 минут', async () => {
    await setTelegram();
    const n = await h.makeNode('Aeza');
    const ag = await FakeAgent.connect(h.base, n.key);
    const [exit] = await h.ctx.db.insert(schema.exits).values({ name: 'DE', country: 'DE', host: '203.0.113.99', port: 443 }).returning();
    const [route] = await h.ctx.db.insert(schema.routes).values({ name: 'Германия', slug: 'de', snis: ['de.example.com'] }).returning();
    await h.ctx.db.insert(schema.routeNodes).values({ routeId: route!.id, nodeId: n.id });
    const t0 = new Date();
    const fail = () => h.ctx.db.insert(schema.checkResults).values({ nodeId: n.id, routeId: route!.id, exitId: exit!.id, source: 'agent', ok: false, error: 'timeout', ts: new Date(Date.now() - 5_000) });
    await fail();
    await evaluateAlerts(h.ctx, t0);
    expect(sent).toHaveLength(0);
    await fail();
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 2 * MIN));
    // pairStatuses смотрит на «сейчас», а не на переданное время: результаты ещё свежие
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Маршрут не работает');
    expect(sent[0]!.text).toContain('Германия');
    ag.close();
  });
});

describe('событие «конфиг не применился»', () => {
  it('срабатывает сразу, не дублируется, закрывается успешным применением', async () => {
    await setTelegram();
    const n = await h.makeNode('Aeza');
    const ag = await FakeAgent.connect(h.base, n.key); // нода на связи: лишних алертов нет
    await evaluateAlerts(h.ctx); // создать правила
    await raiseAlert(h.ctx, { kind: 'config_failed', subject: n.id, label: 'Aeza', message: 'Конфиг откачен (версия 4): [ALERT] cannot bind' });
    await raiseAlert(h.ctx, { kind: 'config_failed', subject: n.id, label: 'Aeza', message: 'Конфиг откачен (версия 5)' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Конфиг не применился');
    expect(await ofKind('config_failed')).toHaveLength(1);
    expect((await ofKind('config_failed'))[0]!.message).toContain('версия 5');
    // движок не закрывает событийные алерты сам
    await evaluateAlerts(h.ctx, new Date(Date.now() + 60 * MIN));
    expect((await ofKind('config_failed'))[0]!.status).toBe('firing');
    await clearAlert(h.ctx, 'config_failed', n.id);
    expect(sent[1]!.text).toContain('Починилось');
    await clearAlert(h.ctx, 'config_failed', n.id); // повторное закрытие безопасно
    expect(sent).toHaveLength(2);
    ag.close();
  });

  it('выключенное правило событий не создаёт', async () => {
    const n = await h.makeNode('Aeza');
    await evaluateAlerts(h.ctx);
    await setRule('config_failed', { enabled: false });
    await raiseAlert(h.ctx, { kind: 'config_failed', subject: n.id, label: 'Aeza', message: 'x' });
    expect(await ofKind('config_failed')).toHaveLength(0);
  });
});

describe('доставка в Telegram', () => {
  it('без настроенного Telegram инцидент виден в панели; после настройки уведомление уходит', async () => {
    await h.makeNode('Aeza');
    const t0 = new Date();
    await evaluateAlerts(h.ctx, t0);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 3 * MIN));
    expect((await rows())[0]).toMatchObject({ status: 'firing', lastNotifiedAt: null });
    expect(sent).toHaveLength(0);
    await setTelegram();
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 4 * MIN));
    expect(sent).toHaveLength(1);
  });

  it('ошибка Telegram записывается, отправка повторяется на следующем цикле', async () => {
    await setTelegram();
    await h.makeNode('Aeza');
    tgFail = { status: 400, description: 'Bad Request: chat not found' };
    const t0 = new Date();
    await evaluateAlerts(h.ctx, t0);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 3 * MIN));
    let [a] = await rows();
    expect(a!.lastNotifiedAt).toBeNull();
    expect(a!.lastNotifyError).toMatch(/чат не найден/);
    tgFail = null;
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 4 * MIN));
    [a] = await rows();
    expect(sent).toHaveLength(1);
    expect(a).toMatchObject({ lastNotifyError: null, notifyCount: 1 });
  });

  it('токен бота не попадает в сообщения об ошибках', async () => {
    await setTelegram();
    await h.makeNode('Aeza');
    tgThrow = true;
    const t0 = new Date();
    await evaluateAlerts(h.ctx, t0);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 3 * MIN));
    const [a] = await rows();
    expect(a!.lastNotifyError).toBeTruthy();
    expect(a!.lastNotifyError).not.toContain(TG_TOKEN);
  });

  it('удалённая нода уносит свои инциденты без шума', async () => {
    await setTelegram();
    const n = await h.makeNode('Временная');
    const t0 = new Date();
    await evaluateAlerts(h.ctx, t0);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 3 * MIN));
    expect(sent).toHaveLength(1);
    await h.ctx.db.delete(schema.nodes).where(eq(schema.nodes.id, n.id));
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 4 * MIN));
    expect(await rows()).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });
});

describe('API алертов и настроек Telegram', () => {
  const api = (m: string, p: string, b?: unknown) => h.admin.req(m, p, b);

  it('список, история, сводка; всё требует входа', async () => {
    await setTelegram();
    await h.makeNode('Aeza');
    const t0 = new Date();
    await evaluateAlerts(h.ctx, t0);
    await evaluateAlerts(h.ctx, new Date(t0.getTime() + 3 * MIN));
    const list = (await api('GET', '/api/alerts')).json;
    expect(list.active).toHaveLength(1);
    expect(list.active[0]).toMatchObject({ kind: 'node_offline', title: 'Нода не на связи', label: 'Aeza', severity: 'crit', status: 'firing' });
    expect(list.telegram).toEqual({ configured: true, enabled: true });
    expect((await api('GET', '/api/alerts/summary')).json).toEqual({ firing: 1, crit: 1, warn: 0 });
    expect((await api('GET', '/api/alerts/history')).json.alerts).toHaveLength(1);
    expect((await api('GET', '/api/alerts/history?kind=cpu')).json.alerts).toHaveLength(0);
    const anon = new Session(h.base);
    for (const p of ['/api/alerts', '/api/alerts/summary', '/api/alerts/history', '/api/alerts/rules']) expect((await anon.req('GET', p)).status, p).toBe(401);
  });

  it('правила: чтение, правка с проверкой порогов, сброс, запись в аудит', async () => {
    const rules = (await api('GET', '/api/alerts/rules')).json.rules;
    expect(rules.map((r: any) => r.kind)).toEqual(['node_offline', 'config_failed', 'route_red', 'quota', 'ip_speed', 'cpu']);
    expect(rules.find((r: any) => r.kind === 'quota')).toMatchObject({ threshold: 80, threshold2: 95, unit: '%', hasThreshold2: true });
    const put = (kind: string, b: object) => api('PUT', `/api/alerts/rules/${kind}`, { enabled: true, threshold: null, threshold2: null, forMin: 0, repeatHours: 6, ...b });
    expect((await put('cpu', { threshold: 90, forMin: 20 })).status).toBe(200);
    expect((await put('cpu', { threshold: 150, forMin: 20 })).status).toBe(400);
    expect((await put('cpu', { threshold: null })).status).toBe(400);
    expect((await put('cpu', { threshold: 90, threshold2: 95 })).status).toBe(400);
    expect((await put('quota', { threshold: 90, threshold2: 85 })).status).toBe(400);
    expect((await put('quota', { threshold: 70, threshold2: 90 })).status).toBe(200);
    expect((await put('node_offline', { threshold: 5 })).status).toBe(400);
    expect((await put('config_failed', { forMin: 5 })).status).toBe(400);
    expect((await put('nonsense', {})).status).toBe(404);
    expect((await put('cpu', { forMin: 99999, threshold: 90 })).status).toBe(400);
    expect((await api('GET', '/api/alerts/rules')).json.rules.find((r: any) => r.kind === 'cpu')).toMatchObject({ threshold: 90, forMin: 20 });
    expect((await api('POST', '/api/alerts/rules/cpu/reset')).status).toBe(200);
    expect((await api('GET', '/api/alerts/rules')).json.rules.find((r: any) => r.kind === 'cpu')).toMatchObject({ threshold: 85, forMin: 15 });
    expect((await h.ctx.db.select().from(schema.auditLog)).some((a) => a.action === 'alert.rule_update')).toBe(true);
  });

  it('Telegram: токен только на запись, проверка формата, тестовое сообщение', async () => {
    const put = (b: object) => api('PUT', '/api/settings/telegram', { enabled: true, chatId: '-1001234567890', ...b });
    expect((await put({})).status).toBe(400); // нет токена
    expect((await put({ token: 'не токен' })).status).toBe(400);
    expect((await put({ token: TG_TOKEN, chatId: 'abc' })).status).toBe(400);
    const ok = await put({ token: TG_TOKEN });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ enabled: true, hasToken: true, chatId: '-1001234567890' });
    const got = await api('GET', '/api/settings/telegram');
    expect(JSON.stringify(got.json)).not.toContain(TG_TOKEN);
    const [row] = await h.ctx.db.select().from(schema.settings).where(eq(schema.settings.key, 'telegram'));
    expect(JSON.stringify(row)).not.toContain(TG_TOKEN);
    expect(JSON.stringify(await h.ctx.db.select().from(schema.auditLog))).not.toContain(TG_TOKEN);
    const t = await api('POST', '/api/settings/telegram/test', {});
    expect(t.json).toEqual({ ok: true, error: null });
    expect(sent.at(-1)!.text).toContain('Тестовое сообщение');
    tgFail = { status: 401, description: 'Unauthorized' };
    expect((await api('POST', '/api/settings/telegram/test', {})).json).toMatchObject({ ok: false, error: expect.stringMatching(/неверный токен/) });
    // можно проверить ещё не сохранённые значения
    tgFail = null;
    expect((await api('POST', '/api/settings/telegram/test', { token: TG_TOKEN, chatId: '@my_channel' })).json.ok).toBe(true);
    expect(sent.at(-1)!.chat).toBe('@my_channel');
  });
});

describe('журнал аудита', () => {
  it('фильтры по действию, автору и тексту, постраничная выдача', async () => {
    await h.ctx.db.delete(schema.auditLog);
    const mk = (action: string, actor: string, diff?: Record<string, unknown>, entityType?: string, entityId?: string) => h.ctx.db.insert(schema.auditLog).values({ action, actor, diff, entityType, entityId, ip: '127.0.0.1' });
    await mk('route.create', 'popug', { slug: 'de' }, 'route', 'r1');
    await mk('route.update', 'popug', { snis: { from: ['a'], to: ['b'] } }, 'route', 'r1');
    await mk('settings.branding', 'popug', { name: 'X' });
    await mk('torrent.ban', 'torrent-blocker', { user: 'alice' }, 'ip', '198.51.100.7');
    for (let i = 0; i < 4; i++) await mk('auth.login', 'popug');
    const get = async (qs = '') => (await h.admin.req('GET', `/api/audit${qs}`)).json;
    expect((await get()).entries).toHaveLength(8);
    expect((await get('?action=route')).entries.map((e: any) => e.action).sort()).toEqual(['route.create', 'route.update']);
    expect((await get('?actor=torrent-blocker')).entries).toHaveLength(1);
    expect((await get('?q=alice')).entries[0].action).toBe('torrent.ban');
    expect((await get('?entityType=route')).entries).toHaveLength(2);
    // записи с подстановочными символами в фильтре не ломают запрос
    expect((await get('?action=%25')).entries).toHaveLength(0);
    const p1 = await get('?limit=3');
    expect(p1.entries).toHaveLength(3);
    expect(p1.next).toBeTruthy();
    const p2 = await get(`?limit=3&before=${p1.next}`);
    expect(p2.entries).toHaveLength(3);
    expect(p2.entries[0].id).toBeLessThan(p1.entries[2].id);
    const p3 = await get(`?limit=3&before=${p2.next}`);
    expect(p3.entries.length).toBeLessThanOrEqual(3);
    const facets = (await h.admin.req('GET', '/api/audit/facets')).json;
    expect(facets.actors).toContain('torrent-blocker');
    expect(facets.actions).toContain('route.update');
    expect((await new Session(h.base).req('GET', '/api/audit')).status).toBe(401);
  });
});

describe('сквозной сценарий: применение конфига', () => {
  it('откат поднимает алерт «конфиг не применился», успешное применение его закрывает; лимиты маршрута доходят до конфига', async () => {
    await setTelegram();
    const n = await h.makeNode('Aeza', { haproxyVersion: '2.8.5' });
    const ag = await FakeAgent.connect(h.base, n.key);
    const ex = await h.admin.req('POST', '/api/exits', { name: 'DE', country: 'DE', host: '203.0.113.77', port: 443 });
    const rt = await h.admin.req('POST', '/api/routes', { name: 'Франция', slug: 'fr', snis: ['fr.example.com'], exitIds: [ex.json.exit.id], nodeIds: [n.id], limitMbit: 50, ipLimitMbit: 10 });
    expect(rt.status).toBe(201);
    expect(rt.json.route).toMatchObject({ limitMbit: 50, ipLimitMbit: 10 });

    let received: any;
    ag.handlers.apply_config = (c) => ((received = c.args), { ok: false, error: 'haproxy не поднялся', data: { version: c.args.version, applied: false, rolledBack: true, rollbackFailed: false, sha256: null, output: '[ALERT] cannot bind socket', durationMs: 900 } });
    const st = (await h.admin.req('GET', `/api/nodes/${n.id}/config`)).json;
    // лимиты маршрута попали в конфиг, который панель отправила на ноду
    const bad = await h.admin.req('POST', `/api/nodes/${n.id}/config/apply`, { expectedHash: st.desired.sha256 });
    expect(received.cfg).toContain('route_dl_fr limit 6250000 key str(be_fr) table st_route_bw');
    expect(received.cfg).toContain('set-bandwidth-limit dl_r10m if');
    expect(bad.json.ok).toBe(false);
    const failed = await ofKind('config_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'firing', subject: n.id });
    expect(sent.some((m) => m.text.includes('Конфиг не применился') && m.text.includes('откачен'))).toBe(true);

    ag.handlers.apply_config = (c) => ({ ok: true, data: { version: c.args.version, applied: true, rolledBack: false, rollbackFailed: false, sha256: 'a'.repeat(64), output: 'ok', durationMs: 100 } });
    const good = await h.admin.req('POST', `/api/nodes/${n.id}/config/apply`, { expectedHash: st.desired.sha256 });
    expect(good.json.ok).toBe(true);
    expect((await ofKind('config_failed'))[0]!.status).toBe('resolved');
    expect(sent.at(-1)!.text).toContain('Починилось');
    ag.close();
  });

  it('лимиты маршрута: частичная правка не сбрасывает, значения проверяются', async () => {
    const [route] = await h.ctx.db.select().from(schema.routes).where(eq(schema.routes.slug, 'fr'));
    const patch = (b: object) => h.admin.req('PATCH', `/api/routes/${route!.id}`, b);
    expect((await patch({ name: 'Франция 2' })).json.route).toMatchObject({ name: 'Франция 2', limitMbit: 50, ipLimitMbit: 10 });
    expect((await patch({ limitMbit: null })).json.route).toMatchObject({ limitMbit: null, ipLimitMbit: 10 });
    expect((await patch({ limitMbit: 0 })).status).toBe(400);
    expect((await patch({ ipLimitMbit: 1.5 })).status).toBe(400);
    expect((await patch({ ipLimitMbit: 100001 })).status).toBe(400);
  });
});
