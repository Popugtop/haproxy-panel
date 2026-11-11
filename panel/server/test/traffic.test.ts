import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { daysBetween, OTHER_KEY, trafficStats, trafficSummary } from '../src/lib/traffic.js';
import { makeHarness, type Harness } from './harness.js';
import { makeNode, testDb } from './helpers.js';

const GB = 1e9;
const NOW = Date.parse('2026-11-11T09:00:00Z');

let t: Awaited<ReturnType<typeof testDb>>;
let a: string, b: string, c: string;
beforeAll(async () => {
  t = await testDb();
  a = (await makeNode(t.db, { name: 'aeza' })).id;
  b = (await makeNode(t.db, { name: 'beget' })).id;
  c = (await makeNode(t.db, { name: 'cloud' })).id;
  const rows = (id: string, list: [string, number, number][]) => list.map(([day, tx, rx]) => ({ nodeId: id, day, txBytes: tx * GB, rxBytes: rx * GB }));
  await t.db.insert(schema.nodeDaily).values([
    ...rows(a, [['2026-10-30', 10, 1], ['2026-11-01', 20, 2], ['2026-11-10', 30, 3], ['2026-11-11', 5, 1]]),
    ...rows(b, [['2026-11-10', 8, 1], ['2026-11-11', 2, 1]]),
    ...rows(c, [['2026-11-11', 1, 1]]),
  ]);
  const [r] = await t.db.insert(schema.routes).values({ name: 'Германия', slug: 'de' }).returning();
  expect(r).toBeTruthy();
  await t.db.insert(schema.backendDaily).values([
    { nodeId: a, backend: 'be_de', day: '2026-11-10', binBytes: 1 * GB, boutBytes: 9 * GB },
    { nodeId: b, backend: 'be_de', day: '2026-11-10', binBytes: 1 * GB, boutBytes: 4 * GB }, // тот же маршрут на другой ноде суммируется
    { nodeId: a, backend: 'be_nl', day: '2026-11-10', binBytes: 1 * GB, boutBytes: 1 * GB },
    { nodeId: a, backend: 'be_unknown', day: '2026-11-11', binBytes: 1 * GB, boutBytes: 0 },
  ]);
}, 60_000);
afterAll(() => t.close());

describe('сводка трафика', () => {
  it('сегодня, календарный месяц и всё время', async () => {
    const s = await trafficSummary(t.db, NOW);
    expect(s.day).toBe('2026-11-11');
    expect(s.today).toEqual({ tx: 8 * GB, rx: 3 * GB }); // 5+2+1
    expect(s.month.tx).toBe((20 + 30 + 5 + 8 + 2 + 1) * GB); // с 1 ноября, без октября
    expect(s.total.tx).toBe(76 * GB);
    expect(s.since).toBe('2026-10-30');
  });

  it('без данных — нули и since=null', async () => {
    const empty = await testDb();
    const s = await trafficSummary(empty.db, NOW);
    expect(s).toMatchObject({ today: { tx: 0, rx: 0 }, month: { tx: 0 }, total: { tx: 0 }, since: null });
    await empty.close();
  });
});

describe('статистика по дням', () => {
  it('daysBetween включает обе границы', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('по нодам: топ, «Прочие», среднее и пик', async () => {
    const s = await trafficStats(t.db, { from: '2026-11-01', to: '2026-11-11', by: 'node', top: 2 });
    expect(s.days).toHaveLength(11);
    expect(s.series.map((x) => x.name)).toEqual(['aeza', 'beget', 'Прочие']);
    expect(s.series[0]!.total).toBe(55 * GB); // 20+30+5, октябрьские 10 не входят
    expect(s.series[2]).toMatchObject({ key: OTHER_KEY, total: 1 * GB });
    expect(s.others).toBe(1);
    expect(s.total).toBe(66 * GB);
    expect(s.avgPerDay).toBeCloseTo((66 * GB) / 11);
    expect(s.peak).toEqual({ day: '2026-11-10', bytes: 38 * GB });
    expect(s.dailyTotal[9]).toBe(38 * GB);
    expect(s.series[0]!.daily[0]).toBe(20 * GB);
  });

  it('по маршрутам: имя из маршрута, ноды суммируются, неизвестный бэкенд под своим именем', async () => {
    const s = await trafficStats(t.db, { from: '2026-11-10', to: '2026-11-11', by: 'route', top: 10 });
    const de = s.series.find((x) => x.name === 'Германия')!;
    expect(de.total).toBe(15 * GB); // (1+9)+(1+4)
    expect(de.daily).toEqual([15 * GB, 0]);
    expect(s.series.map((x) => x.name)).toEqual(['Германия', 'be_nl', 'be_unknown']);
    expect(s.others).toBe(0);
  });

  it('пустой период без падений', async () => {
    const s = await trafficStats(t.db, { from: '2025-01-01', to: '2025-01-03', by: 'node', top: 5 });
    expect(s).toMatchObject({ total: 0, avgPerDay: 0, peak: null, series: [] });
    expect(s.dailyTotal).toEqual([0, 0, 0]);
  });
});

describe('API статистики', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
  }, 60_000);
  afterAll(() => h.close());

  it('закрыт без входа, проверяет параметры', async () => {
    const { Session } = await import('./harness.js');
    expect((await new Session(h.base).req('GET', '/api/traffic/summary')).status).toBe(401);
    expect((await new Session(h.base).req('GET', '/api/traffic/stats')).status).toBe(401);
    for (const q of ['from=2026-13-01', 'from=abc', 'by=user', 'top=0', 'top=99', 'from=2026-11-10&to=2026-11-01', 'from=2020-01-01&to=2026-11-11']) {
      expect((await h.admin.req('GET', `/api/traffic/stats?${q}`)).status, q).toBe(400);
    }
  });

  it('по умолчанию — последние 7 дней по нодам', async () => {
    const r = await h.admin.req('GET', '/api/traffic/stats');
    expect(r.status).toBe(200);
    expect(r.json.days).toHaveLength(7);
    expect(r.json.by).toBe('node');
    expect((await h.admin.req('GET', '/api/traffic/summary')).json).toMatchObject({ total: { tx: 0, rx: 0 }, since: null });
  });
});
