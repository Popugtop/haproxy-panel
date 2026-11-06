import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type DB } from '../src/db/index.js';
import { applyRetention, rollup, RES } from '../src/lib/rollup.js';
import { fleetSeries, nodeSeries, plan } from '../src/lib/series.js';
import { makeNode, testDb } from './helpers.js';

let db: DB;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await testDb()));
afterAll(() => close());

const T0 = Date.parse('2026-11-06T12:00:00Z');

describe('rollup 15с → 1м → 1ч', () => {
  it('агрегирует суммы, средние с весом и максимумы; повторный запуск идемпотентен', async () => {
    const node = await makeNode(db, { name: 'r1' });
    // Минута 12:00: 4 сырые точки по 15 с.
    const rows = [0, 15, 30, 45].map((s, i) => ({
      nodeId: node.id, res: 15, ts: new Date(T0 + s * 1000), dt: 15,
      rxBytes: 1500, txBytes: 3000, cpuAvg: 10 + i * 10, cpuMax: 10 + i * 10, memTotal: 1000, memAvailAvg: 400,
      load1Avg: 1, sessionsAvg: i, sessionsMax: i, clientsAvg: 5, clientsMax: 5,
    }));
    await db.insert(schema.nodeMetrics).values(rows);
    await db.insert(schema.backendMetrics).values(
      [0, 15, 30, 45].map((s, i) => ({
        nodeId: node.id, backend: 'be_de', res: 15, ts: new Date(T0 + s * 1000), dt: 15,
        binBytes: 100, boutBytes: 900, scurAvg: i * 2, scurMax: i * 2, serversUpMin: i === 2 ? 0 : 1, serversTotal: 1,
      })),
    );

    const now = T0 + 90_000; // минута 12:00 уже завершена
    await rollup(db, RES.raw, RES.min, 3600e3, now);
    await rollup(db, RES.raw, RES.min, 3600e3, now);

    const m = await db.select().from(schema.nodeMetrics).where(and(eq(schema.nodeMetrics.nodeId, node.id), eq(schema.nodeMetrics.res, 60)));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ dt: 60, n: 4, rxBytes: 6000, txBytes: 12000, cpuMax: 40, memTotal: 1000, sessionsMax: 3, clientsMax: 5 });
    expect(m[0]!.ts.toISOString()).toBe('2026-11-06T12:00:00.000Z');
    expect(m[0]!.cpuAvg).toBeCloseTo(25);
    expect(m[0]!.sessionsAvg).toBeCloseTo(1.5);

    const b = await db.select().from(schema.backendMetrics).where(and(eq(schema.backendMetrics.nodeId, node.id), eq(schema.backendMetrics.res, 60)));
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ backend: 'be_de', binBytes: 400, boutBytes: 3600, scurMax: 6, serversUpMin: 0, serversTotal: 1 });

    // Час: из минутных корзин.
    await rollup(db, RES.min, RES.hour, 3600e3, T0 + 3600e3 + 1000);
    const h = await db.select().from(schema.nodeMetrics).where(and(eq(schema.nodeMetrics.nodeId, node.id), eq(schema.nodeMetrics.res, 3600)));
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ dt: 60, rxBytes: 6000, n: 4 });
  });

  it('текущая (незавершённая) корзина не агрегируется', async () => {
    const node = await makeNode(db, { name: 'r2' });
    await db.insert(schema.nodeMetrics).values({ nodeId: node.id, res: 15, ts: new Date(T0 + 10_000), dt: 15, rxBytes: 1, txBytes: 1 });
    await rollup(db, RES.raw, RES.min, 3600e3, T0 + 30_000); // корзина 12:00 ещё идёт
    const m = await db.select().from(schema.nodeMetrics).where(and(eq(schema.nodeMetrics.nodeId, node.id), eq(schema.nodeMetrics.res, 60)));
    expect(m).toHaveLength(0);
  });

  it('retention удаляет устаревшее по каждому разрешению', async () => {
    const node = await makeNode(db, { name: 'r3' });
    const now = T0;
    const mk = (res: number, ageMs: number) => ({ nodeId: node.id, res, ts: new Date(now - ageMs), dt: 15, rxBytes: 1, txBytes: 1 });
    await db.insert(schema.nodeMetrics).values([
      mk(15, 49 * 3600e3), mk(15, 47 * 3600e3),
      mk(60, 31 * 86400e3), mk(60, 29 * 86400e3),
      mk(3600, 366 * 86400e3), mk(3600, 364 * 86400e3),
    ]);
    await applyRetention(db, now);
    const left = await db.select().from(schema.nodeMetrics).where(eq(schema.nodeMetrics.nodeId, node.id));
    expect(left.map((r) => r.res).sort((a, b) => a - b)).toEqual([15, 60, 3600]);
  });
});

describe('series', () => {
  it('plan выбирает ряд по диапазону и держит ~720 точек', () => {
    expect(plan(3600)).toEqual({ src: 15, bin: 15 });
    expect(plan(6 * 3600)).toEqual({ src: 15, bin: 30 });
    expect(plan(24 * 3600).src).toBe(60);
    expect(plan(7 * 86400)).toEqual({ src: 60, bin: 840 });
    expect(plan(30 * 86400).src).toBe(3600);
    expect(plan(365 * 86400).bin % 3600).toBe(0);
  });

  it('отдаёт скорости, считая по сумме дельт / сумме dt (пропуски не искажают)', async () => {
    const node = await makeNode(db, { name: 's1' });
    const now = T0 + 120_000;
    await db.insert(schema.nodeMetrics).values([
      { nodeId: node.id, res: 15, ts: new Date(T0 + 15_000), dt: 15, rxBytes: 1_500_000, txBytes: 3_000_000, cpuAvg: 20, memTotal: 1000, memAvailAvg: 250, sessionsAvg: 5 },
      { nodeId: node.id, res: 15, ts: new Date(T0 + 30_000), dt: 15, rxBytes: 3_000_000, txBytes: 3_000_000, cpuAvg: 40, memTotal: 1000, memAvailAvg: 250, sessionsAvg: 7 },
    ]);
    await db.insert(schema.backendMetrics).values({
      nodeId: node.id, backend: 'be_de', res: 15, ts: new Date(T0 + 15_000), dt: 15, binBytes: 150, boutBytes: 1500, scurAvg: 3,
    });
    const s = await nodeSeries(db, node.id, '1h', now);
    expect(s.bin).toBe(15);
    expect(s.t).toHaveLength(2);
    expect(s.rxBps).toEqual([100_000, 200_000]);
    expect(s.txBps).toEqual([200_000, 200_000]);
    expect(s.cpu).toEqual([20, 40]);
    expect(s.memUsedPct[0]).toBeCloseTo(75);
    expect(s.backends.be_de!.outBps).toEqual([100, null]);
    expect(s.backends.be_de!.inBps[0]).toBe(10);
  });

  it('пустая нода — пустые массивы', async () => {
    const node = await makeNode(db, { name: 's2' });
    const s = await nodeSeries(db, node.id, '24h');
    expect(s.t).toEqual([]);
    expect(s.backends).toEqual({});
  });
});

describe('fleetSeries', () => {
  it('складывает скорости всех нод в общие 30-секундные корзины', async () => {
    const a = await makeNode(db, { name: 'f1' });
    const b = await makeNode(db, { name: 'f2' });
    const base = T0 + 5 * 3600e3; // окно, свободное от данных предыдущих тестов
    const now = base + 3 * 60_000;
    const row = (nodeId: string, sec: number, tx: number) => ({ nodeId, res: 15, ts: new Date(base + sec * 1000), dt: 15, rxBytes: tx, txBytes: tx });
    // корзина 12:00:00–12:00:30: по две точки от каждой ноды
    await db.insert(schema.nodeMetrics).values([row(a.id, 5, 1_500_000), row(a.id, 20, 1_500_000), row(b.id, 7, 3_000_000), row(b.id, 22, 3_000_000)]);
    const s = await fleetSeries(db, now);
    const i = s.t.indexOf(base / 1000);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(s.txBps[i]).toBe(9_000_000 / 30);
  });

  it('строка, покрывающая провал связи (большой dt), не даёт ложного всплеска', async () => {
    const a = await makeNode(db, { name: 'gap1' });
    const base = T0 + 8 * 3600e3;
    await db.insert(schema.nodeMetrics).values([
      { nodeId: a.id, res: 15, ts: new Date(base + 5_000), dt: 15, rxBytes: 1_500_000, txBytes: 1_500_000 },
      { nodeId: a.id, res: 15, ts: new Date(base + 20_000), dt: 600, rxBytes: 900_000_000, txBytes: 900_000_000 }, // после 10-минутного обрыва
    ]);
    const s = await fleetSeries(db, base + 3 * 60_000);
    const i = s.t.indexOf(base / 1000);
    expect(s.txBps[i]).toBe(1_500_000 / 15);
  });

  it('джиттер меток: 1, 2 или 3 строки в корзине дают одну и ту же скорость', async () => {
    const a = await makeNode(db, { name: 'jit1' });
    const base = T0 + 10 * 3600e3;
    // 100 кБ/с ровно; в первой корзине три строки (джиттер), во второй одна
    const row = (sec: number, dt: number) => ({ nodeId: a.id, res: 15, ts: new Date(base + sec * 1000), dt, rxBytes: dt * 100_000, txBytes: dt * 100_000 });
    await db.insert(schema.nodeMetrics).values([row(1, 15), row(15, 14), row(29, 15), row(44, 15)]);
    const s = await fleetSeries(db, base + 3 * 60_000);
    for (const t of [base / 1000, base / 1000 + 30]) expect(s.txBps[s.t.indexOf(t)]).toBeCloseTo(100_000, 0);
  });
});
