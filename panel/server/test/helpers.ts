import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { join } from 'node:path';
import type { Metrics } from '@popug/protocol';
import { type DB, schema } from '../src/db/index.js';

export async function testDb(): Promise<{ db: DB; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../drizzle') });
  return { db: db as unknown as DB, close: () => client.close() };
}

export async function makeNode(db: DB, over: Partial<typeof schema.nodes.$inferInsert> = {}) {
  const [n] = await db.insert(schema.nodes).values({ name: 'ru-1', ...over }).returning();
  return n!;
}

export function metrics(o: {
  rx?: number;
  tx?: number;
  backends?: { name: string; bin: number; bout: number; scur?: number; up?: boolean }[];
  cpu?: number | null;
  active?: number;
}): Metrics {
  return {
    t: 'metrics',
    ts: 0,
    seq: 1,
    sys: {
      cpuPct: o.cpu === undefined ? 10 : o.cpu,
      load1: 0.5,
      load5: 0.4,
      load15: 0.3,
      memTotal: 2_000_000_000,
      memAvail: 1_000_000_000,
      uptimeSec: 1000,
      net: { rxBytes: o.rx ?? 0, txBytes: o.tx ?? 0, ifaces: [{ name: 'eth0', rx: o.rx ?? 0, tx: o.tx ?? 0 }] },
    },
    haproxy: {
      ok: true,
      error: null,
      version: '2.8.5',
      uptimeSec: 100,
      backends: (o.backends ?? []).map((b) => ({
        name: b.name,
        status: 'UP',
        bin: b.bin,
        bout: b.bout,
        stot: 1,
        scur: b.scur ?? 0,
        servers: [{ name: 's1', status: b.up === false ? 'DOWN' : 'UP', check: 'L4OK', checkMs: 2 }],
      })),
      frontends: [],
    },
    clients: { tracked: 10, active: o.active ?? 3, top: [] },
    clientsError: null,
  };
}
