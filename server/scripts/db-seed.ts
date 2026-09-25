// npm run db:seed — заполняет пустую базу тестовыми данными (перед этим применяет миграции).
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrator.js';
import { seedDevData } from '../src/db/seed/dev-seed.js';

if (config.isProduction) throw new Error('Тестовые данные в production не загружаются');

const { adminPassword, clientPassword } = config.seed;
if (!adminPassword || !clientPassword || adminPassword.length < 8 || clientPassword.length < 8) {
  throw new Error('Задайте в server/.env SEED_ADMIN_PASSWORD и SEED_CLIENT_PASSWORD (не короче 8 символов)');
}

const db = openDatabase();
try {
  runMigrations(db);
  seedDevData(db, { adminPassword, clientPassword });
  console.log(`Тестовые данные загружены: ${config.databasePath}`);
} finally {
  db.close();
}
