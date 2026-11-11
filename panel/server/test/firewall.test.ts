import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { firewallCommands, firewallHints } from '../src/lib/firewall.js';
import { makeNode, testDb } from './helpers.js';

describe('команды фаервола', () => {
  it('ufw и iptables с подставленными IP и портом, IPv6 через ip6tables', () => {
    const c = firewallCommands(7444, ['45.88.176.156', '31.129.103.45', '2001:db8::1', '45.88.176.156']);
    expect(c.ufw.split('\n')).toEqual([
      'ufw allow from 45.88.176.156 to any port 7444 proto tcp',
      'ufw allow from 31.129.103.45 to any port 7444 proto tcp',
      'ufw allow from 2001:db8::1 to any port 7444 proto tcp',
    ]);
    expect(c.iptables).toContain('iptables -I INPUT -s 45.88.176.156 -p tcp --dport 7444 -j ACCEPT');
    expect(c.iptables).toContain('ip6tables -I INPUT -s 2001:db8::1 -p tcp --dport 7444 -j ACCEPT');
  });

  it('не пропускает в команды ничего, кроме IP', () => {
    const c = firewallCommands(443, ['1.2.3.4; rm -rf /', 'example.com', '$(id)', '5.6.7.8']);
    expect(c.ufw).toBe('ufw allow from 5.6.7.8 to any port 443 proto tcp');
    expect(c.ufw + c.iptables).not.toMatch(/[;$()]/);
  });
});

describe('firewallHints', () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeAll(async () => {
    db = await testDb();
  }, 60_000);
  afterAll(() => db.close());

  it('берёт мосты только из включённых маршрутов на этот выход; мост без IP попадает в noIp', async () => {
    const [exit] = await db.db.insert(schema.exits).values({ name: 'de', host: '203.0.113.9', port: 7444 }).returning();
    const [other] = await db.db.insert(schema.exits).values({ name: 'nl', host: '203.0.113.10', port: 443 }).returning();
    const a = await makeNode(db.db, { name: 'a', ip: '45.88.176.156' });
    const b = await makeNode(db.db, { name: 'b', ip: null });
    const c = await makeNode(db.db, { name: 'c', ip: '31.129.103.45' });
    const d = await makeNode(db.db, { name: 'd', ip: '198.51.100.1' });
    const mk = async (slug: string, enabled: boolean, exitId: string, nodes: string[]) => {
      const [r] = await db.db.insert(schema.routes).values({ name: slug, slug, enabled }).returning();
      await db.db.insert(schema.routeExits).values({ routeId: r!.id, exitId });
      await db.db.insert(schema.routeNodes).values(nodes.map((nodeId) => ({ routeId: r!.id, nodeId })));
    };
    await mk('de', true, exit!.id, [a.id, b.id, c.id]);
    await mk('de2', true, exit!.id, [a.id]); // дубль моста не удваивает правило
    await mk('off', false, exit!.id, [d.id]); // выключенный маршрут не открывает порт
    await mk('nl', true, other!.id, [d.id]); // другой выход

    const h = await firewallHints(db.db, exit!);
    expect(h.port).toBe(7444);
    expect(h.bridges.map((x) => x.ip)).toEqual(['45.88.176.156', '31.129.103.45']);
    expect(h.noIp).toEqual(['b']);
    expect(h.ufw.split('\n')).toHaveLength(2);
    expect(h.ufw).not.toContain('198.51.100.1');
  });
});
