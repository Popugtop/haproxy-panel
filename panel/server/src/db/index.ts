import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema.js';

export { schema };
// Один тип для postgres-js (прод) и PGlite (тесты).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DB = PgDatabase<any, typeof schema>;

export interface DbHandle {
  db: DB;
  close: () => Promise<void>;
}

export async function connect(url: string, migrationsFolder: string): Promise<DbHandle> {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzlePg(client, { schema });
  await migratePg(db, { migrationsFolder });
  return { db, close: () => client.end({ timeout: 5 }) };
}
