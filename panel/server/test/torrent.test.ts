import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { parseNodes, parseReports } from '../src/lib/remnawave.js';
import { loadTorrentState, pollOnce } from '../src/lib/torrent.js';
import { FakeAgent, Session, makeHarness, until, type Harness } from './harness.js';

const TOKEN = 'rw-secret-token-ABCDEF123456';
const URL_ = 'https://remna.test';

interface Rep { id: number; ip: string; blocked?: boolean; dur?: number; unblock?: string | null; user?: string; node?: string }
let reports: Rep[] = [];
let remnaNodes: { uuid: string; name: string; address: string; ips: { ip: string }[] }[] = [];
let failWith: number | null = null;
let seenAuth: string[] = [];

const wire = (r: Rep) => ({
  id: r.id, user: { username: r.user ?? 'alice' }, node: { uuid: 'u-1', name: r.node ?? 'de-1' },
  report: { actionReport: { blocked: r.blocked ?? true, ip: r.ip, blockDuration: r.dur ?? 3600, willUnblockAt: r.unblock === undefined ? new Date(Date.now() + 3600e3).toISOString() : r.unblock } },
});

const fakeFetch: typeof fetch = async (input, init) => {
  const u = new URL(String(input));
  seenAuth.push(String((init?.headers as Record<string, string>)?.authorization));
  if (failWith) return new Response('{}', { status: failWith });
  if (u.pathname === '/api/node-plugins/torrent-blocker') {
    const start = Number(u.searchParams.get('start')), size = Number(u.searchParams.get('size'));
    const sorted = [...reports].sort((a, b) => b.id - a.id);
    return Response.json({ response: { records: sorted.slice(start, start + size).map(wire), total: sorted.length } });
  }
  if (u.pathname === '/api/nodes') return Response.json({ response: remnaNodes });
  return new Response('{}', { status: 404 });
};

let h: Harness;
let a: { id: string; key: string };
let b: { id: string; key: string };
let ag: FakeAgent;
const deltas: any[] = [];
const put = (body: object) => h.admin.req('PUT', '/api/settings/remnawave', { enabled: true, url: URL_, observeOnly: false, banMode: 'report', fixedBanSec: 3600, maxBanSec: 86400, pollIntervalSec: 15, allowlist: [], ...body });
const events = async () => (await h.ctx.db.select().from(schema.torrentEvents)).sort((x, y) => x.reportId - y.reportId);
const bansOf = async (ip: string) => h.ctx.db.select().from(schema.bans).where(eq(schema.bans.ip, ip));

beforeAll(async () => {
  h = await makeHarness();
  h.ctx.http = fakeFetch;
  a = await h.makeNode('Aeza', { ip: '203.0.113.5' });
  b = await h.makeNode('Хорёк', { ip: '203.0.113.6' });
  ag = await FakeAgent.connect(h.base, a.key);
  ag.handlers.apply_bans = (c) => (deltas.push(c.args), { ok: true, data: { active: 1, rejected: [] } });
  await h.ctx.db.insert(schema.exits).values({ name: 'Выход DE', country: 'DE', host: '203.0.113.50', port: 443 });
}, 60_000);
afterAll(async () => {
  ag.close();
  await h.close();
});
beforeEach(async () => {
  failWith = null;
  seenAuth = [];
  deltas.length = 0;
  await h.ctx.db.delete(schema.torrentEvents);
  await h.ctx.db.delete(schema.bans);
  await h.ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'torrent_state'));
  remnaNodes = [];
});

describe('разбор ответов Remnawave', () => {
  it('понимает оба формата времени и не падает на битой записи', () => {
    const p = parseReports({ response: { total: 3, records: [wire({ id: 3, ip: '1.2.3.4', unblock: '2026-11-03T19:50:00' }), { id: 'x', junk: true }, wire({ id: 2, ip: '1.2.3.5', unblock: null })] } });
    expect(p.records.map((r) => r.id)).toEqual([3, 2]);
    expect(p.records[0]!.willUnblockAt?.toISOString()).toBe('2026-11-03T19:50:00.000Z');
    expect(p.records[1]!.willUnblockAt).toBeNull();
    expect(() => parseReports({ nope: 1 })).toThrow(/response\.records/);
    expect(parseNodes({ response: [{ uuid: 'u', name: 'n', address: '1.1.1.1', ips: [{ ip: '2.2.2.2' }] }] })[0]!.ips).toEqual(['2.2.2.2']);
  });
});

describe('настройки и секреты', () => {
  it('токен хранится зашифрованным, наружу и в аудит не попадает', async () => {
    expect((await put({ token: TOKEN, enabled: true })).status).toBe(200);
    const pub = (await h.admin.req('GET', '/api/settings/remnawave')).json;
    expect(pub).toMatchObject({ enabled: true, url: URL_, hasToken: true, observeOnly: false });
    expect(JSON.stringify(pub)).not.toContain(TOKEN);
    const [row] = await h.ctx.db.select().from(schema.settings).where(eq(schema.settings.key, 'remnawave'));
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    const audit = JSON.stringify(await h.ctx.db.select().from(schema.auditLog));
    expect(audit).not.toContain(TOKEN);
    expect(audit).toContain('settings.remnawave');
  });

  it('без токена опрос не включить; адрес и параметры проверяются', async () => {
    await h.ctx.db.delete(schema.settings);
    expect((await put({ enabled: true })).status).toBe(400);
    expect((await put({ token: TOKEN, url: 'ftp://x' })).status).toBe(400);
    expect((await put({ token: TOKEN, url: 'https://u:p@remna.test' })).status).toBe(400);
    expect((await put({ token: TOKEN, maxBanSec: 10 })).status).toBe(400);
    expect((await put({ token: TOKEN, allowlist: ['не ip'] })).status).toBe(400);
    expect((await put({ token: TOKEN, headers: { Authorization: 'x' } })).status).toBe(400);
    expect((await put({ token: TOKEN, headers: { 'X-Gate-Key': 'k' } })).status).toBe(200);
    // токен не передан — прежний остаётся
    expect((await put({ url: URL_ })).status).toBe(200);
    expect((await h.admin.req('GET', '/api/settings/remnawave')).json).toMatchObject({ hasToken: true, headerNames: ['X-Gate-Key'] });
  });

  it('все запросы к Remnawave идут с Bearer-токеном и своими заголовками', async () => {
    reports = [{ id: 1, ip: '198.51.100.1' }];
    await pollOnce(h.ctx);
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every((x) => x === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('проверка связи различает отчёты и ноды (scope)', async () => {
    const ok = (await h.admin.req('POST', '/api/settings/remnawave/test', {})).json;
    expect(ok).toMatchObject({ reports: { ok: true }, nodes: { ok: true } });
    failWith = 403;
    const bad = (await h.admin.req('POST', '/api/settings/remnawave/test', {})).json;
    expect(bad.reports.error).toMatch(/scope/);
  });
});

describe('опрос и баны', () => {
  beforeEach(async () => {
    await put({ token: TOKEN, enabled: true, observeOnly: false, headers: {} });
  });

  it('первый запуск ставит курсор на последний отчёт и старое не банит', async () => {
    reports = [{ id: 10, ip: '198.51.100.10' }, { id: 9, ip: '198.51.100.9' }];
    expect(await pollOnce(h.ctx)).toMatchObject({ status: 'initialized', banned: 0 });
    expect((await loadTorrentState(h.ctx.db)).cursor).toBe(10);
    expect(await events()).toHaveLength(0);
    expect(await bansOf('198.51.100.10')).toHaveLength(0);
  });

  it('новый отчёт банит IP клиента на всех нодах, агент получает дельту со сроком', async () => {
    reports = [{ id: 10, ip: '198.51.100.10' }];
    await pollOnce(h.ctx);
    reports.push({ id: 11, ip: '198.51.100.20', dur: 7200, user: 'bob', node: 'nl-2' });
    expect(await pollOnce(h.ctx)).toMatchObject({ status: 'ok', processed: 1, banned: 1 });
    const bans = await bansOf('198.51.100.20');
    expect(bans.map((x) => x.nodeId).sort()).toEqual([a.id, b.id].sort());
    expect(bans[0]).toMatchObject({ reason: 'torrent', createdBy: 'torrent-blocker' });
    expect(bans[0]!.note).toContain('bob');
    const ttl = (bans[0]!.expiresAt.getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(7100);
    expect(ttl).toBeLessThanOrEqual(7200);
    await until(() => deltas.length > 0);
    expect(deltas[0]).toMatchObject({ full: false, ban: [{ ip: '198.51.100.20' }], unban: [] });
    const [ev] = await events();
    expect(ev).toMatchObject({ reportId: 11, action: 'ban', ip: '198.51.100.20', username: 'bob', remnaNode: 'nl-2', durationSec: 7200, nodesCount: 2 });
    expect((await loadTorrentState(h.ctx.db)).cursor).toBe(11);
  });

  it('срок ограничен предохранителем, а в режиме fixed берётся свой', async () => {
    reports = [{ id: 1, ip: '198.51.100.1' }];
    await pollOnce(h.ctx);
    await put({ token: TOKEN, maxBanSec: 600 });
    reports.push({ id: 2, ip: '198.51.100.2', dur: 999_999 });
    await pollOnce(h.ctx);
    expect((await events()).find((e) => e.reportId === 2)!.durationSec).toBe(600);
    await put({ token: TOKEN, banMode: 'fixed', fixedBanSec: 1800, maxBanSec: 86400 });
    reports.push({ id: 3, ip: '198.51.100.3', dur: 60 });
    await pollOnce(h.ctx);
    expect((await events()).find((e) => e.reportId === 3)!.durationSec).toBe(1800);
  });

  it('режим наблюдения записывает решение, но не банит', async () => {
    await put({ token: TOKEN, observeOnly: true });
    reports = [{ id: 1, ip: '198.51.100.1' }];
    await pollOnce(h.ctx);
    reports.push({ id: 2, ip: '198.51.100.2' });
    expect(await pollOnce(h.ctx)).toMatchObject({ banned: 0 });
    expect(await bansOf('198.51.100.2')).toHaveLength(0);
    expect(deltas).toHaveLength(0);
    expect((await events())[0]).toMatchObject({ action: 'observe', nodesCount: 2, durationSec: 3600 });
  });

  it('пропуски с понятной причиной: исключения плагина, защищённые адреса, свой список, нода Remnawave', async () => {
    remnaNodes = [{ uuid: 'n1', name: 'de-1', address: '192.0.2.77', ips: [{ ip: '192.0.2.78' }] }];
    await put({ token: TOKEN, allowlist: ['198.51.100.0/28'] });
    reports = [{ id: 1, ip: '198.51.100.100' }];
    await pollOnce(h.ctx);
    reports.push(
      { id: 2, ip: '198.51.100.101', blocked: false },
      { id: 3, ip: '10.1.2.3' },
      { id: 4, ip: '203.0.113.50' }, // выход панели
      { id: 5, ip: '203.0.113.5' }, // нода панели
      { id: 6, ip: '198.51.100.5' }, // свой список
      { id: 7, ip: '192.0.2.78' }, // нода Remnawave
      { id: 8, ip: '100.64.1.1' }, // CGNAT
      { id: 9, ip: 'не-ip' },
      { id: 10, ip: '198.51.100.102', unblock: '2020-01-01T00:00:00Z' },
      { id: 11, ip: '198.51.100.103', dur: 0 },
    );
    const r = await pollOnce(h.ctx);
    expect(r).toMatchObject({ processed: 10, banned: 0 });
    const ev = await events();
    expect(ev.every((e) => e.action === 'skip')).toBe(true);
    const why = Object.fromEntries(ev.map((e) => [e.reportId, e.reason]));
    expect(why[2]).toMatch(/исключений плагина/);
    expect(why[3]).toMatch(/частный/);
    expect(why[4]).toMatch(/выход/);
    expect(why[5]).toMatch(/нода/);
    expect(why[6]).toMatch(/списке исключений/);
    expect(why[7]).toMatch(/Remnawave/);
    expect(why[8]).toMatch(/CGNAT/);
    expect(why[9]).toMatch(/нет корректного IP/);
    expect(why[10]).toMatch(/истёк/);
    expect(why[11]).toMatch(/нулевой срок/);
    expect(await h.ctx.db.select().from(schema.bans)).toHaveLength(0);
  });

  it('повторный отчёт не продлевает и не укорачивает действующий бан', async () => {
    reports = [{ id: 1, ip: '198.51.100.1' }];
    await pollOnce(h.ctx);
    reports.push({ id: 2, ip: '198.51.100.30', dur: 3600 });
    await pollOnce(h.ctx);
    const before = (await bansOf('198.51.100.30'))[0]!.expiresAt.getTime();
    reports.push({ id: 3, ip: '198.51.100.30', dur: 86400 });
    await pollOnce(h.ctx);
    expect((await bansOf('198.51.100.30'))[0]!.expiresAt.getTime()).toBe(before);
    expect((await events()).find((e) => e.reportId === 3)!.action).toBe('already_banned');
  });

  it('ошибка API не двигает курсор и записывается; после восстановления отчёты не теряются', async () => {
    reports = [{ id: 1, ip: '198.51.100.1' }];
    await pollOnce(h.ctx);
    reports.push({ id: 2, ip: '198.51.100.40' });
    failWith = 401;
    await expect(pollOnce(h.ctx)).rejects.toThrow(/токен/);
    const st = await loadTorrentState(h.ctx.db);
    expect(st.cursor).toBe(1);
    expect(st.lastError).toMatch(/401/);
    failWith = null;
    expect(await pollOnce(h.ctx)).toMatchObject({ processed: 1, banned: 1 });
    expect((await loadTorrentState(h.ctx.db)).lastError).toBeNull();
  });

  it('постраничное чтение собирает все новые отчёты без дублей', async () => {
    reports = [{ id: 1, ip: '198.51.100.1' }];
    await pollOnce(h.ctx);
    for (let i = 2; i <= 251; i++) reports.push({ id: i, ip: `198.51.${100 + (i % 3)}.${i % 200}`, blocked: false });
    const r = await pollOnce(h.ctx);
    expect(r.processed).toBe(250);
    expect(new Set((await events()).map((e) => e.reportId)).size).toBe(250);
  });

  it('если отчёты в Remnawave очистили, курсор сбрасывается', async () => {
    reports = [{ id: 500, ip: '198.51.100.1' }];
    await pollOnce(h.ctx);
    reports = [{ id: 3, ip: '198.51.100.2' }];
    expect(await pollOnce(h.ctx)).toMatchObject({ status: 'cursor_reset' });
    expect((await loadTorrentState(h.ctx.db)).cursor).toBe(3);
    expect(await events()).toHaveLength(0);
  });

  it('недоступный список нод Remnawave — предупреждение, а не остановка', async () => {
    reports = [{ id: 1, ip: '198.51.100.1' }];
    const orig = h.ctx.http;
    h.ctx.http = async (i, n) => (String(i).includes('/api/nodes') ? new Response('{}', { status: 403 }) : orig(i, n));
    await pollOnce(h.ctx);
    expect((await loadTorrentState(h.ctx.db)).warning).toMatch(/список нод/);
    h.ctx.http = orig;
  });

  it('выключенный опрос ничего не делает', async () => {
    await put({ token: TOKEN, enabled: false });
    expect(await pollOnce(h.ctx)).toMatchObject({ status: 'disabled' });
  });
});

describe('API торрент-блокера', () => {
  it('статус, события с фильтром, ручной опрос; все требуют входа', async () => {
    await put({ token: TOKEN, enabled: true, observeOnly: false, headers: {} });
    reports = [{ id: 1, ip: '198.51.100.1' }];
    await pollOnce(h.ctx);
    reports.push({ id: 2, ip: '198.51.100.60' }, { id: 3, ip: '10.0.0.1' });
    const r = await h.admin.req('POST', '/api/torrent/poll', {});
    expect(r.json).toMatchObject({ status: 'ok', processed: 2, banned: 1 });
    const st = (await h.admin.req('GET', '/api/torrent')).json;
    expect(st).toMatchObject({ configured: true, enabled: true, observeOnly: false, state: { cursor: 3, lastError: null }, stats: { last24h: { ban: 1, skip: 1 }, activeBans: 1 } });
    const skips = (await h.admin.req('GET', '/api/torrent/events?action=skip')).json.events;
    expect(skips.map((e: any) => e.ip)).toEqual(['10.0.0.1']);
    failWith = 500;
    expect((await h.admin.req('POST', '/api/torrent/poll', {})).status).toBe(502);
    const anon = new Session(h.base);
    for (const p of ['/api/torrent', '/api/torrent/events', '/api/settings/remnawave', '/api/settings/telegram']) expect((await anon.req('GET', p)).status, p).toBe(401);
  });
});
