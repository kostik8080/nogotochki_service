// npm start — HTTP-сервер API. Открывает базу, проверяет, что все миграции применены, и слушает PORT.
// Раз в минуту удаляет истекшие брони времени и сессии (docs/db-schema.md, раздел 8, шаг 4).
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { cleanupExpired } from './booking/cleanup.js';
import { config } from './config.js';
import { openDatabase } from './db/connection.js';
import { pendingMigrations } from './db/migrator.js';

const CLEANUP_INTERVAL_MS = 60_000;

const db = openDatabase();
const pending = pendingMigrations(db);
if (pending.length > 0) {
  // Код ждет схему, которой в базе еще нет: запросы падали бы на отсутствующих полях.
  console.error(`В базе не применены миграции: ${pending.join(', ')}. Выполните npm run db:migrate (на сервере — npm run prod:migrate).`);
  db.close();
  process.exit(1);
}

const app = createApp(db, { secureCookies: config.isProduction, trustProxy: config.trustProxy });
const server = createServer(app.handle);

const cleanup = () => {
  try {
    const now = new Date();
    cleanupExpired(db, now);
    app.prune(now);
  } catch (error) {
    console.error('Уборка истекших броней и сессий не удалась:', error);
  }
};
cleanup();
const timer = setInterval(cleanup, CLEANUP_INTERVAL_MS);

server.listen(config.port, () => {
  console.log(`API «Ноготочки» слушает порт ${config.port} (${config.nodeEnv}), база: ${config.databasePath}`);
});

function shutdown(signal: string): void {
  console.log(`${signal}: останавливаю сервер`);
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Долгие соединения не должны держать остановку бесконечно.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
