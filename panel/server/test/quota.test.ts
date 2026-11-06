import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type DB } from '../src/db/index.js';
import { billingPeriod, quotaUsage, traffic24h } from '../src/lib/quota.js';
import { makeNode, testDb } from './helpers.js';

describe('billingPeriod', () => {
  const d = (s: string) => new Date(s + 'T12:00:00Z');
  it('день уже наступил в этом месяце', () => expect(billingPeriod(5, d('2026-11-06'))).toEqual({ start: '2026-11-05', end: '2026-12-05' }));
  it('день ещё не наступил — период начался в прошлом месяце', () => expect(billingPeriod(10, d('2026-11-06'))).toEqual({ start: '2026-10-10', end: '2026-11-10' }));
  it('граница: сегодня и есть день биллинга', () => expect(billingPeriod(6, d('2026-11-06'))).toEqual({ start: '2026-11-06', end: '2026-12-06' }));
  it('переход через год', () => expect(billingPeriod(20, d('2026-01-05'))).toEqual({ start: '2025-12-20', end: '2026-01-20' }));
  it('день 31 в коротком месяце сдвигается на последний день', () => {
    expect(billingPeriod(31, d('2026-02-28'))).toEqual({ start: '2026-02-28', end: '2026-03-31' });
    expect(billingPeriod(31, d('2026-03-15'))).toEqual({ start: '2026-02-28', end: '2026-03-31' });
  });
});

describe('quotaUsage', () => {
  let db: DB;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await testDb()));
  afterAll(() => close());

  it('суммирует сутки периода и считает процент от квоты (tx и tx+rx)', async () => {
    const node = await makeNode(db, { billingDay: 5, quotaTb: '2.00', quotaCounts: 'tx' });
    await db.insert(schema.nodeDaily).values([
      { nodeId: node.id, day: '2026-11-04', rxBytes: 9e12, txBytes: 9e12 }, // до периода — не считается
      { nodeId: node.id, day: '2026-11-05', rxBytes: 1e11, txBytes: 4e11 },
      { nodeId: node.id, day: '2026-11-06', rxBytes: 2e11, txBytes: 6e11 },
    ]);
    const now = new Date('2026-11-06T12:00:00Z');
    const tx = await quotaUsage(db, node, now);
    expect(tx).toMatchObject({ periodStart: '2026-11-05', usedBytes: 1e12, limitBytes: 2e12, counts: 'tx' });
    expect(tx.pct).toBeCloseTo(50);
    const both = await quotaUsage(db, { ...node, quotaCounts: 'txrx' }, now);
    expect(both.usedBytes).toBe(1.3e12);
  });

  it('без квоты процент не считается', async () => {
    const node = await makeNode(db, { name: 'noquota' });
    const q = await quotaUsage(db, node);
    expect(q.limitBytes).toBeNull();
    expect(q.pct).toBeNull();
  });

  it('трафик за 24 часа берёт только последние сутки', async () => {
    const node = await makeNode(db, { name: 'h24' });
    const now = new Date('2026-11-06T12:00:00Z');
    const mk = (hoursAgo: number, rx: number) => ({
      nodeId: node.id, res: 15, ts: new Date(now.getTime() - hoursAgo * 3600e3), dt: 15, rxBytes: rx, txBytes: rx * 2,
    });
    await db.insert(schema.nodeMetrics).values([mk(1, 100), mk(23, 50), mk(25, 9999)]);
    expect(await traffic24h(db, node.id, now)).toEqual({ rx: 150, tx: 300 });
  });
});
