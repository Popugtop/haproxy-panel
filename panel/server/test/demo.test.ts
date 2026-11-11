import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { schema } from '../src/db/index.js';
import { purgeDemo, startDemo } from '../src/demo.js';
import { Ingestor } from '../src/lib/ingest.js';
import { Registry } from '../src/lib/registry.js';
import { nodeSummaries } from '../src/lib/nodes.js';
import { nodeSeries } from '../src/lib/series.js';
import { quotaUsage } from '../src/lib/quota.js';
import { configState, loadRoutes } from '../src/lib/routes.js';
import { pairStatuses, worst } from '../src/lib/checks.js';
import { testDb } from './helpers.js';
import type { Ctx } from '../src/app.js';

const silent = { info() {}, error(o: unknown, m: string) { throw new Error(m + ' ' + String(o)); } };
let ctx: Ctx;
let close: () => Promise<void>;
let stop: () => void;

beforeAll(async () => {
  const t = await testDb();
  close = t.close;
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'x', APP_SECRET: 'a'.repeat(40), DEMO: '1' });
  ctx = { db: t.db, config, registry: new Registry(), ingestor: new Ingestor(t.db), probe: async () => ({ ok: false, ms: null, error: 'stub' }), release: () => ({ version: null, files: {}, hasPublicKey: false }), fetchLogo: async () => { throw new Error('stub'); }, http: async () => { throw new Error('stub'); } };
  stop = await startDemo(ctx, silent);
}, 60_000);
afterAll(async () => {
  stop();
  await close();
});

describe('демо-режим', () => {
  it('в production DEMO запрещён', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', APP_SECRET: 'a'.repeat(40), PUBLIC_URL: 'https://p.example.com', DEMO: '1' })).toThrow(/DEMO/);
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', APP_SECRET: 'a'.repeat(40), PUBLIC_URL: 'https://p.example.com' })).not.toThrow();
  });

  it('создаёт 3 онлайн-ноды с правдоподобными данными', async () => {
    const list = await nodeSummaries(ctx.db, ctx.registry);
    expect(list).toHaveLength(3);
    for (const n of list) {
      expect(n.status).toBe('online');
      expect(n.live?.rxBps).toBeGreaterThan(0);
      expect(n.live?.activeClients).toBeGreaterThan(0);
      expect(n.quota.limitBytes).not.toBeNull();
      expect(n.traffic24h.tx).toBeGreaterThan(1e10);
    }
    const by = (s: string) => list.find((n) => n.name.startsWith(s))!;
    const [a, b, c] = [by('Aeza'), by('xorek'), by('cloud4box')];
    expect(a!.quota.pct!).toBeGreaterThan(40); // ~60% на ~66% периода
    expect(a!.quota.pct!).toBeLessThan(80);
    expect(c!.quota.pct!).toBeGreaterThan(80); // третья — на грани квоты
    expect(c!.live!.backendsDown).toBe(1);
    expect(c!.bwlimSupported).toBe(false);
    expect(b!.live!.cpuPct!).toBeLessThan(50);
    expect(c!.live!.cpuPct!).toBeGreaterThan(b!.live!.cpuPct!); // третья загружена сильнее второй в любое время суток
  });

  it('история есть для всех диапазонов графиков', async () => {
    const n = (await nodeSummaries(ctx.db, ctx.registry)).find((x) => x.name.startsWith('Aeza'));
    for (const r of ['1h', '24h', '7d', '30d'] as const) {
      const s = await nodeSeries(ctx.db, n!.id, r);
      expect(s.t.length, r).toBeGreaterThan(20);
      expect(Object.keys(s.backends).length).toBe(5);
    }
  });

  it('маршруты: один маршрут на нескольких нодах, версии, ожидающее применение и статусы проверок', async () => {
    const nodes = await ctx.db.select().from(schema.nodes);
    const by = (p: string) => nodes.find((n) => n.name.startsWith(p))!;
    const routes = await loadRoutes(ctx.db);
    expect(routes.map((r) => r.slug)).toEqual(['cz', 'de', 'ee', 'nl', 'se', 'sg']);
    const de = routes.find((r) => r.slug === 'de')!;
    expect(de.nodeIds).toHaveLength(3); // одинаковый маршрут на трёх нодах
    expect(de.exits).toHaveLength(2);

    // конфиг: у Aeza и xorek применено то, что хочет панель; у cloud4box есть неприменённое изменение (маршрут cz)
    expect((await configState(ctx.db, by('Aeza'))).inSync).toBe(true);
    expect((await configState(ctx.db, by('xorek'))).inSync).toBe(true);
    const c4 = await configState(ctx.db, by('cloud4box'));
    expect(c4.inSync).toBe(false);
    expect(c4.desired.sniMap).toContain('cz.popug.cloud');
    expect(c4.applied!.sniMap).not.toContain('cz.popug.cloud');

    const vs = await ctx.db.select().from(schema.configVersions).where(eq(schema.configVersions.nodeId, by('xorek').id));
    expect(vs.map((v) => v.status).sort()).toEqual(['applied', 'imported', 'rolled_back']);

    // проверки: sg на cloud4box красный, cz на Aeza жёлтый, остальное зелёное
    const pairs = await pairStatuses(ctx.db);
    const tone = (slug: string, nodePrefix: string) => pairs.find((p) => p.routeId === routes.find((r) => r.slug === slug)!.id && p.nodeId === by(nodePrefix).id)?.tone;
    expect(tone('sg', 'cloud4box')).toBe('bad');
    expect(tone('cz', 'Aeza')).toBe('warn');
    expect(tone('de', 'Aeza')).toBe('ok');
    expect(tone('sg', 'xorek')).toBe('ok');
    expect(worst(pairs.filter((p) => p.routeId === routes.find((r) => r.slug === 'sg')!.id).map((p) => p.tone))).toBe('bad');
  });

  it('демо-агент применяет конфиг и откатывает сценарий с «fail»', async () => {
    const { applyToNode } = await import('../src/lib/applyconfig.js');
    const c4 = (await ctx.db.select().from(schema.nodes)).find((n) => n.name.startsWith('cloud4box'))!;
    const before = await configState(ctx.db, c4);
    const ok = await applyToNode(ctx, c4, { login: 'test' }, before.desired.sha256);
    expect(ok.ok).toBe(true);
    const fresh = async () => (await ctx.db.select().from(schema.nodes).where(eq(schema.nodes.id, c4.id)))[0]!; // строка ноды меняется после применения
    expect((await configState(ctx.db, await fresh())).inSync).toBe(true);
    // маршрут с SNI «fail» вызывает демо-откат
    const [r] = await loadRoutes(ctx.db, { nodeId: c4.id });
    await ctx.db.update(schema.routes).set({ snis: ['fail.popug.cloud'] }).where(eq(schema.routes.id, r!.id));
    const st = await configState(ctx.db, await fresh());
    const bad = await applyToNode(ctx, await fresh(), { login: 'test' }, st.desired.sha256);
    expect(bad.ok).toBe(false);
    expect(bad.rolledBack).toBe(true);
    expect(bad.output).toContain('cannot bind');
  });

  it('клиенты, баны, лимиты и обновление агента работают в демо', async () => {
    const nodes = await ctx.db.select().from(schema.nodes);
    const aeza = nodes.find((n) => n.name.startsWith('Aeza'))!;
    const r = await ctx.registry.send(aeza.id, 'get_clients');
    expect(r.ok).toBe(true);
    const top = (r.data as { top: { ip: string; rateOut: number }[] }).top;
    expect(top.length).toBeGreaterThan(20);
    expect(top[0]!.rateOut).toBeGreaterThan(0);
    // IP клиентов не пересекаются с адресами нод и выходов
    const infra = new Set([...nodes.map((n) => n.ip), ...(await ctx.db.select().from(schema.exits)).map((e) => e.host)]);
    for (const c of top) expect(infra.has(c.ip), c.ip).toBe(false);

    const bans = await ctx.db.select().from(schema.bans);
    expect(bans.map((b) => b.reason).sort()).toEqual(['manual', 'manual', 'torrent']);
    expect((await ctx.db.select().from(schema.ipLimits)).length).toBe(2);
    // лимит Aeza уже в применённом конфиге (HAProxy 2.8), на cloud4box (2.6) лимитов нет
    expect((await configState(ctx.db, aeza)).applied!.cfg).toContain('dl_20m');

    expect(ctx.release().version).toBe('0.3.0');
    const u = await ctx.registry.send(aeza.id, 'update_agent', { args: { version: '0.3.0', sha256: 'd'.repeat(64) } });
    expect(u.ok).toBe(true);
  });

  it('фейковый агент отвечает на get_config', async () => {
    const [n] = await nodeSummaries(ctx.db, ctx.registry);
    const r = await ctx.registry.send(n!.id, 'get_config');
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.data)).toContain('Сгенерировано popug-bridges');
  });

  it('помечены is_demo и удаляются purgeDemo без следа', async () => {
    const rows = await ctx.db.select().from(schema.nodes);
    expect(rows.every((r) => r.isDemo)).toBe(true);
    // настоящая нода не затрагивается
    const [real] = await ctx.db.insert(schema.nodes).values({ name: 'real' }).returning();
    expect(await purgeDemo(ctx.db)).toBe(3);
    const left = await ctx.db.select().from(schema.nodes);
    expect(left.map((n) => n.name)).toEqual(['real']);
    expect(await ctx.db.select().from(schema.nodeMetrics)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.routes)).toHaveLength(0); // демо-маршруты и выходы тоже удалены
    expect(await ctx.db.select().from(schema.exits)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.checkResults)).toHaveLength(0);
    expect((await quotaUsage(ctx.db, real!)).usedBytes).toBe(0);
    await ctx.db.delete(schema.nodes).where(eq(schema.nodes.id, real!.id));
  });
});
