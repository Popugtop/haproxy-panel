import { and, eq } from 'drizzle-orm';
import { isIP } from 'node:net';
import { type DB, schema } from '../db/index.js';

export interface FirewallBridge {
  nodeId: string;
  name: string;
  ip: string;
}

export interface FirewallHints {
  port: number;
  /** Мосты с включённым маршрутом на этот выход, у которых известен корректный IP. */
  bridges: FirewallBridge[];
  /** Мосты, для которых IP не задан или некорректен: правило для них составить нельзя. */
  noIp: string[];
  ufw: string;
  iptables: string;
}

/** Только значения, прошедшие isIP, попадают в команды: текст из БД в шелл не уходит. */
export function firewallCommands(port: number, ips: string[]): Pick<FirewallHints, 'ufw' | 'iptables'> {
  const safe = [...new Set(ips)].filter((ip) => isIP(ip) !== 0);
  const p = Math.trunc(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { ufw: '', iptables: '' };
  const ufw = safe.map((ip) => `ufw allow from ${ip} to any port ${p} proto tcp`).join('\n');
  const iptables = safe.map((ip) => `${isIP(ip) === 6 ? 'ip6tables' : 'iptables'} -I INPUT -s ${ip} -p tcp --dport ${p} -j ACCEPT`).join('\n');
  return { ufw, iptables };
}

/** Что открыть на фаерволе выхода, чтобы мосты могли до него достучаться. */
export async function firewallHints(db: DB, exit: { id: string; port: number }): Promise<FirewallHints> {
  const rows = await db
    .selectDistinct({ nodeId: schema.nodes.id, name: schema.nodes.name, ip: schema.nodes.ip })
    .from(schema.routeExits)
    .innerJoin(schema.routes, and(eq(schema.routes.id, schema.routeExits.routeId), eq(schema.routes.enabled, true)))
    .innerJoin(schema.routeNodes, eq(schema.routeNodes.routeId, schema.routes.id))
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.routeNodes.nodeId))
    .where(eq(schema.routeExits.exitId, exit.id))
    .orderBy(schema.nodes.name);
  const bridges: FirewallBridge[] = [];
  const noIp: string[] = [];
  for (const r of rows) {
    const ip = r.ip?.trim() ?? '';
    if (isIP(ip) !== 0) bridges.push({ nodeId: r.nodeId, name: r.name, ip });
    else noIp.push(r.name);
  }
  return { port: exit.port, bridges, noIp, ...firewallCommands(exit.port, bridges.map((b) => b.ip)) };
}
