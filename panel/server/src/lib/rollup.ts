import { sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';

/** Хранение: сырые 15 с — 48 ч, 1 мин — 30 дней, 1 ч — 1 год. */
export const RES = { raw: 15, min: 60, hour: 3600 } as const;
export const RETENTION_MS = { [RES.raw]: 48 * 3600e3, [RES.min]: 30 * 86400e3, [RES.hour]: 365 * 86400e3 } as const;

const iso = (ms: number) => new Date(ms).toISOString();
const floorTo = (ms: number, sec: number) => Math.floor(ms / (sec * 1000)) * sec * 1000;
const n = (v: number) => sql.raw(String(Math.trunc(v)));

/**
 * Пересчитывает завершённые корзины dst из корзин src за последние lookback мс. Идемпотентно:
 * повторный запуск даёт тот же результат, поэтому пропущенные из-за простоя панели корзины
 * наверстываются следующим запуском. lookback должен быть меньше срока хранения src, иначе
 * частично удалённая корзина перезапишет корректное значение.
 */
export async function rollup(db: DB, src: number, dst: number, lookbackMs: number, nowMs = Date.now()): Promise<void> {
  const from = iso(floorTo(nowMs - lookbackMs, dst));
  const to = iso(floorTo(nowMs, dst));
  const bin = sql`date_bin('${n(dst)} seconds'::interval, ts, TIMESTAMPTZ '2000-01-01 00:00:00+00')`;
  const wavg = (col: string) => sql.raw(`sum(${col} * n) / NULLIF(sum(n) FILTER (WHERE ${col} IS NOT NULL), 0)`);

  await db.execute(sql`
    INSERT INTO node_metrics (node_id, res, ts, dt, n, rx_bytes, tx_bytes, cpu_avg, cpu_max, mem_total, mem_avail_avg,
                              load1_avg, sessions_avg, sessions_max, clients_avg, clients_max)
    SELECT node_id, ${n(dst)}::smallint, ${bin} AS b, sum(dt), sum(n)::int, sum(rx_bytes)::bigint, sum(tx_bytes)::bigint,
           ${wavg('cpu_avg')}, max(cpu_max), max(mem_total), ${wavg('mem_avail_avg')},
           ${wavg('load1_avg')}, sum(sessions_avg * n) / sum(n), max(sessions_max), ${wavg('clients_avg')}, max(clients_max)
    FROM node_metrics
    WHERE res = ${n(src)} AND ts >= ${from}::timestamptz AND ts < ${to}::timestamptz
    GROUP BY node_id, b
    ON CONFLICT (node_id, res, ts) DO UPDATE SET
      dt = EXCLUDED.dt, n = EXCLUDED.n, rx_bytes = EXCLUDED.rx_bytes, tx_bytes = EXCLUDED.tx_bytes,
      cpu_avg = EXCLUDED.cpu_avg, cpu_max = EXCLUDED.cpu_max, mem_total = EXCLUDED.mem_total,
      mem_avail_avg = EXCLUDED.mem_avail_avg, load1_avg = EXCLUDED.load1_avg, sessions_avg = EXCLUDED.sessions_avg,
      sessions_max = EXCLUDED.sessions_max, clients_avg = EXCLUDED.clients_avg, clients_max = EXCLUDED.clients_max
  `);

  await db.execute(sql`
    INSERT INTO backend_metrics (node_id, backend, res, ts, dt, n, bin_bytes, bout_bytes, scur_avg, scur_max, servers_up_min, servers_total)
    SELECT node_id, backend, ${n(dst)}::smallint, ${bin} AS b, sum(dt), sum(n)::int, sum(bin_bytes)::bigint, sum(bout_bytes)::bigint,
           sum(scur_avg * n) / sum(n), max(scur_max), min(servers_up_min), max(servers_total)
    FROM backend_metrics
    WHERE res = ${n(src)} AND ts >= ${from}::timestamptz AND ts < ${to}::timestamptz
    GROUP BY node_id, backend, b
    ON CONFLICT (node_id, backend, res, ts) DO UPDATE SET
      dt = EXCLUDED.dt, n = EXCLUDED.n, bin_bytes = EXCLUDED.bin_bytes, bout_bytes = EXCLUDED.bout_bytes,
      scur_avg = EXCLUDED.scur_avg, scur_max = EXCLUDED.scur_max,
      servers_up_min = EXCLUDED.servers_up_min, servers_total = EXCLUDED.servers_total
  `);
}

export async function applyRetention(db: DB, nowMs = Date.now()): Promise<void> {
  await db.execute(sql`DELETE FROM bans WHERE expires_at < ${iso(nowMs - 86400e3)}::timestamptz`); // истёкшие баны — сутки в истории
  // История проверок маршрутов хранится 7 дней.
  await db.execute(sql`DELETE FROM check_results WHERE ts < ${iso(nowMs - 7 * 86400e3)}::timestamptz`);
  for (const [res, keep] of Object.entries(RETENTION_MS)) {
    const before = iso(nowMs - keep);
    await db.execute(sql`DELETE FROM node_metrics WHERE res = ${n(Number(res))} AND ts < ${before}::timestamptz`);
    await db.execute(sql`DELETE FROM backend_metrics WHERE res = ${n(Number(res))} AND ts < ${before}::timestamptz`);
  }
}

/** Запускает фоновое обслуживание; возвращает функцию остановки. */
export function startMaintenance(db: DB, log: { error: (o: unknown, m: string) => void }): () => void {
  const run = (name: string, fn: () => Promise<void>) => () => fn().catch((err) => log.error({ err }, `фоновая задача ${name} упала`));
  const minute = run('rollup-1m', () => rollup(db, RES.raw, RES.min, 36 * 3600e3));
  const hour = run('rollup-1h', () => rollup(db, RES.min, RES.hour, 72 * 3600e3));
  const retain = run('retention', () => applyRetention(db));
  // На старте наверстываем пропущенное, пока панель была выключена.
  void minute();
  void hour();
  void retain();
  const timers = [setInterval(minute, 60_000), setInterval(hour, 5 * 60_000), setInterval(retain, 30 * 60_000)];
  timers.forEach((t) => t.unref());
  return () => timers.forEach(clearInterval);
}
