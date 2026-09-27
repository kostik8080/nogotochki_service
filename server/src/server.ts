// npm start — HTTP-сервер API. Открывает базу, проверяет, что все миграции применены, и слушает PORT.
// Раз в минуту удаляет истекшие брони времени и сессии (docs/db-schema.md, раздел 8, шаг 4).
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { cleanupExpired } from './booking/cleanup.js';
import { config } from './config.js';
import { openDatabase } from './db/connection.js';
import { pendingMigrations } from './db/migrator.js';
import { ConsoleMailer, type Mailer, SmtpMailer } from './notify/mailer.js';

const CLEANUP_INTERVAL_MS = 60_000;

const db = openDatabase();
const pending = pendingMigrations(db);
if (pending.length > 0) {
  // Код ждет схему, которой в базе еще нет: запросы падали бы на отсутствующих полях.
  console.error(`В базе не применены миграции: ${pending.join(', ')}. Выполните npm run db:migrate (на сервере — npm run prod:migrate).`);
  db.close();
  process.exit(1);
}

// Почта: SMTP, если он настроен; при разработке без него письма печатаются в консоль.
// SMS в сервисе нет: коды приходят на e-mail, а телефон подтверждает администратор (решение студии).
// В production без SMTP ссылки и коды на e-mail не уходят — их заменяет администратор.
const { smtp } = config;
if (smtp.host && !smtp.from) {
  console.error('SMTP_HOST задан, а SMTP_FROM нет: укажите адрес отправителя, например "Ноготочки <noreply@nogotochki.ru>".');
  process.exit(1);
}
const mailer: Mailer | null = smtp.host
  ? new SmtpMailer({ host: smtp.host, port: smtp.port, user: smtp.user, password: smtp.password, from: smtp.from! })
  : config.isProduction ? null : new ConsoleMailer();
if (config.isProduction && !config.appUrl.startsWith('https://')) {
  console.error(`APP_URL=${config.appUrl}: в production нужен адрес с https:// — из него строятся ссылки в письмах.`);
  process.exit(1);
}

const app = createApp(db, {
  secureCookies: config.isProduction, trustProxy: config.trustProxy,
  mailer, appUrl: config.appUrl, uploadsDir: config.uploadsDir,
});
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
