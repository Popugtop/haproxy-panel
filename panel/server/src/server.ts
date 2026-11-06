import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db/index.js';
import { purgeDemo, startDemo } from './demo.js';
import { startPanelChecker } from './lib/checks.js';
import { purgeAlerts, startAlertEngine } from './lib/alerts.js';
import { purgeExpiredBans } from './lib/bans.js';
import { startMaintenance } from './lib/rollup.js';
import { purgeTorrentEvents, startTorrentPoller } from './lib/torrent.js';

const config = loadConfig();
const migrations = resolve(process.env.MIGRATIONS_DIR ?? new URL('../drizzle', import.meta.url).pathname);
const { db, close } = await connect(config.DATABASE_URL, migrations);
const { app, ctx } = await buildApp(db, config);
let stopDemo = () => {};
if (config.DEMO) {
  app.log.warn('ВКЛЮЧЁН ДЕМО-РЕЖИМ: данные ниже ненастоящие');
  stopDemo = await startDemo(ctx, app.log);
} else {
  const purged = await purgeDemo(db);
  if (purged > 0) app.log.info({ purged }, 'удалены демо-ноды, оставшиеся от прошлого запуска с DEMO=1');
}
const stopMaintenance = startMaintenance(db, app.log);
// Сквозные проверки панели (панель → мост:443 с SNI маршрута). В демо их заменяет генератор результатов.
const stopChecker = config.DEMO ? () => {} : startPanelChecker(ctx, app.log);

// Алерты работают и в демо (на сидированных данных). Опрос Remnawave — только вне демо: настоящих токенов там нет.
const stopAlerts = startAlertEngine(ctx, app.log, { graceMs: config.DEMO ? 20_000 : 60_000 });
const stopTorrent = config.DEMO ? () => {} : startTorrentPoller(ctx, app.log);
const purge = () => Promise.all([purgeTorrentEvents(db), purgeAlerts(db), purgeExpiredBans(db)]).catch((err) => app.log.error({ err }, 'очистка старых записей не удалась'));
void purge();
const purgeTimer = setInterval(() => void purge(), 6 * 3600_000);
purgeTimer.unref();

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'останавливаюсь');
  stopMaintenance();
  stopChecker();
  stopAlerts();
  stopTorrent();
  clearInterval(purgeTimer);
  stopDemo();
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info({ publicUrl: config.publicUrl }, `панель запущена, агентов онлайн: ${ctx.registry.onlineCount()}`);
