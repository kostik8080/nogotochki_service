// npm run db:seed — заполняет базу тестовыми данными (перед этим применяет миграции).
// Повторный запуск не создает дублей: добавляется только то, чего в базе еще нет.
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrator.js';
import { seedDevData } from '../src/db/seed/dev-seed.js';

if (config.isProduction) throw new Error('Тестовые данные в production не загружаются');

const { adminPassword, masterPassword, clientPassword } = config.seed;
const passwords = { SEED_ADMIN_PASSWORD: adminPassword, SEED_MASTER_PASSWORD: masterPassword, SEED_CLIENT_PASSWORD: clientPassword };
const missing = Object.entries(passwords).filter(([, value]) => !value || value.length < 8).map(([name]) => name);
if (missing.length > 0 || !adminPassword || !masterPassword || !clientPassword) {
  throw new Error(`Задайте в server/.env пароли не короче 8 символов: ${missing.join(', ')}`);
}

const db = openDatabase();
try {
  runMigrations(db);
  const report = seedDevData(db, { adminPassword, masterPassword, clientPassword, uploadsDir: config.uploadsDir });

  console.log(`Тестовые данные: ${config.databasePath}\n`);
  console.log(`${'Таблица'.padEnd(28)}${'добавлено'.padStart(10)}${'уже было'.padStart(10)}`);
  for (const [table, { created, existing }] of report.tables) {
    console.log(`${table.padEnd(28)}${String(created).padStart(10)}${String(existing).padStart(10)}`);
  }
  console.log(report.scenarioCreated
    ? '\nСценарные данные (история визитов, записи, отпуск Елены) добавлены.'
    : '\nСценарные данные уже есть — пропущены. Чтобы начать с чистой базы: npm run db:reset');
} finally {
  db.close();
}
