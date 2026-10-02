// npm start — HTTP-сервер API. Открывает базу, применяет новые миграции и слушает PORT.
// Раз в минуту удаляет истекшие брони времени и сессии (docs/db-schema.md, раздел 8, шаг 4).
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { cleanupExpired } from './booking/cleanup.js';
import { config } from './config.js';
import { applyMigrations } from './db/auto-migrate.js';
import { bootstrapAdmin } from './db/bootstrap-admin.js';
import { openDatabase } from './db/connection.js';
import { ConsoleMailer, type Mailer, SmtpMailer } from './notify/mailer.js';

const CLEANUP_INTERVAL_MS = 60_000;

// Папку базы создает openDatabase, если ее еще нет: на чистом сервере первый запуск не должен падать.
const db = openDatabase();

// Схему базы сервер приводит в порядок сам, до того как начнет отвечать: код ждет схему, которой
// в базе может еще не быть, а на сервере команду миграций набирать некому. Уже примененные миграции
// второй раз не применяются.
try {
  const applied = applyMigrations(db);
  console.log(applied.length > 0 ? `Применены миграции: ${applied.join(', ')}` : 'Новых миграций нет');
} catch (error) {
  // Без нужной схемы запросы падали бы на отсутствующих полях — лучше не начинать отвечать вовсе.
  console.error('Не удалось применить миграции, сервер не запущен:', error);
  db.close();
  process.exit(1);
}

// Первый администратор: заводится, только если администраторов в базе еще нет. Сбой здесь сервис
// не останавливает — клиенты должны видеть витрину, даже если учетную запись завести не удалось.
try {
  const admin = bootstrapAdmin(db, { email: config.admin.email, password: config.admin.password });
  if (admin.status === 'created') {
    console.log(`Создана учетная запись администратора: ${admin.email}`);
    if (admin.generatedPassword) {
      console.log(`Пароль (показывается один раз, смените его в профиле после входа): ${admin.generatedPassword}`);
    }
  } else if (admin.status === 'invalid') {
    console.error(`Администратор не создан. ${admin.message}`);
  } else if (admin.status === 'skipped') {
    console.log('Администраторов в базе нет. Задайте ADMIN_EMAIL и перезапустите сервер либо заведите учетную запись командой admin:create');
  }
} catch (error) {
  console.error('Не удалось завести учетную запись администратора:', error);
}

// Почта: SMTP, если он настроен; при разработке без него письма печатаются в консоль.
// SMS в сервисе нет: коды приходят на e-mail, а телефон подтверждает администратор (решение студии).
// В production без SMTP ссылки и коды на e-mail не уходят — их заменяет администратор.
const { smtp } = config;
if (smtp.host && !smtp.from) {
  console.error('SMTP_HOST задан, а MAIL_FROM нет: укажите адрес отправителя, например "Ноготочки <noreply@nogotochki.ru>".');
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
