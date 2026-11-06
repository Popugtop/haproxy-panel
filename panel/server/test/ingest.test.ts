import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type DB } from '../src/db/index.js';
import { compute, delta, Ingestor } from '../src/lib/ingest.js';
import { makeNode, metrics, testDb } from './helpers.js';

let db: DB;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await testDb()));
afterAll(() => close());

describe('delta', () => {
  it('обычный прирост', () => expect(delta(150, 100)).toBe(50));
  it('рестарт счётчика (значение меньше) — дельта равна новому значению', () => expect(delta(30, 1000)).toBe(30));
  it('без изменений', () => expect(delta(5, 5)).toBe(0));
});

describe('compute', () => {
  it('первый снимок: скоростей и шагов нет', () => {
    const c = compute(metrics({ rx: 1000, tx: 2000 }), 1_000_000, null);
    expect(c.step).toBeNull();
    expect(c.live.sys.rxBps).toBe(0);
    expect(c.counters.rx).toBe(1000);
  });

  it('считает скорость по разнице снимков', () => {
    const a = compute(metrics({ rx: 1000, tx: 1000, backends: [{ name: 'be_de', bin: 100, bout: 200 }] }), 1_000_000, null);
    const b = compute(
      metrics({ rx: 1000 + 15_000_000, tx: 1000 + 30_000_000, backends: [{ name: 'be_de', bin: 100 + 1500, bout: 200 + 3000, scur: 4 }] }),
      1_015_000,
      a.counters,
    );
    expect(b.step?.dt).toBe(15);
    expect(b.live.sys.rxBps).toBe(1_000_000);
    expect(b.live.sys.txBps).toBe(2_000_000);
    expect(b.live.backends[0]).toMatchObject({ name: 'be_de', inBps: 100, outBps: 200, scur: 4 });
    expect(b.live.sessions).toBe(4);
  });

  it('reload HAProxy: счётчики бэкенда сброшены — не уходит в минус', () => {
    const a = compute(metrics({ backends: [{ name: 'be_de', bin: 9_000_000, bout: 9_000_000 }] }), 0, null);
    const b = compute(metrics({ backends: [{ name: 'be_de', bin: 300, bout: 600 }] }), 15_000, a.counters);
    expect(b.step?.backends[0]).toMatchObject({ bin: 300, bout: 600 });
  });

  it('новый бэкенд после предыдущего снимка считается с нуля (создан reload’ом)', () => {
    const a = compute(metrics({ backends: [{ name: 'be_de', bin: 1, bout: 1 }] }), 0, null);
    const b = compute(metrics({ backends: [{ name: 'be_de', bin: 1, bout: 1 }, { name: 'be_se', bin: 500, bout: 700 }] }), 15_000, a.counters);
    expect(b.step?.backends.find((x) => x.name === 'be_se')).toMatchObject({ bin: 500, bout: 700 });
  });

  it('считает живые серверы бэкенда', () => {
    const c = compute(metrics({ backends: [{ name: 'be_x', bin: 0, bout: 0, up: false }] }), 1, null);
    expect(c.live.backends[0]?.servers[0]?.status).toBe('DOWN');
  });
});

describe('Ingestor + БД', () => {
  it('пишет сырой ряд, сутки и live; рестарт панели не теряет дельту', async () => {
    const node = await makeNode(db, { name: 'ing-1' });
    const t0 = Date.parse('2026-11-06T12:00:00Z');
    const ing = new Ingestor(db);
    await ing.ingest(node.id, metrics({ rx: 1000, tx: 1000, backends: [{ name: 'be_de', bin: 0, bout: 0 }] }), t0);
    await ing.ingest(node.id, metrics({ rx: 6000, tx: 11000, backends: [{ name: 'be_de', bin: 100, bout: 900 }] }), t0 + 15_000);

    // «Перезапуск панели»: новый Ingestor подхватывает счётчики из node_live.
    const ing2 = new Ingestor(db);
    await ing2.ingest(node.id, metrics({ rx: 7000, tx: 12000, backends: [{ name: 'be_de', bin: 150, bout: 1000 }] }), t0 + 30_000);

    const raw = await db.select().from(schema.nodeMetrics).where(eq(schema.nodeMetrics.nodeId, node.id));
    expect(raw).toHaveLength(2);
    const daily = await db.select().from(schema.nodeDaily).where(eq(schema.nodeDaily.nodeId, node.id));
    expect(daily).toEqual([{ nodeId: node.id, day: '2026-11-06', rxBytes: 6000, txBytes: 11000 }]);
    const bd = await db.select().from(schema.backendDaily).where(eq(schema.backendDaily.nodeId, node.id));
    expect(bd[0]).toMatchObject({ backend: 'be_de', binBytes: 150, boutBytes: 1000 });
    const [live] = await db.select().from(schema.nodeLive).where(eq(schema.nodeLive.nodeId, node.id));
    expect(live?.data.sys.rxBps).toBeCloseTo(1000 / 15);
  });

  it('границу суток считает по UTC', async () => {
    const node = await makeNode(db, { name: 'ing-2' });
    const t0 = Date.parse('2026-11-06T23:59:50Z');
    const ing = new Ingestor(db);
    await ing.ingest(node.id, metrics({ rx: 0, tx: 0 }), t0);
    await ing.ingest(node.id, metrics({ rx: 100, tx: 100 }), t0 + 5_000); // 23:59:55
    await ing.ingest(node.id, metrics({ rx: 300, tx: 300 }), t0 + 20_000); // 00:00:10 (следующие сутки)
    const rows = await db.select().from(schema.nodeDaily).where(eq(schema.nodeDaily.nodeId, node.id)).orderBy(schema.nodeDaily.day);
    expect(rows.map((r) => [r.day, r.rxBytes])).toEqual([['2026-11-06', 100], ['2026-11-07', 200]]);
  });
});
