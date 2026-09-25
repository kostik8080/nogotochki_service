// npm run db:migrate — создает файл базы, если его нет, и применяет новые миграции.
// В production перед применением делается резервная копия, если в базе уже есть данные:
// миграция откатывается при ошибке сама, а копия защищает от миграции, которая прошла, но сделала не то.
import { config } from '../src/config.js';
import { createBackup } from '../src/db/backup.js';
import { openDatabase } from '../src/db/connection.js';
import { pendingMigrations, runMigrations } from '../src/db/migrator.js';

const db = openDatabase();
try {
  const pending = pendingMigrations(db);
  const hasData = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (config.isProduction && pending.length > 0 && hasData) {
    const backup = createBackup(db, config.backup.dir, 'pre-migrate');
    console.log(`Резервная копия перед миграциями: ${backup.file}`);
  }

  const applied = runMigrations(db);
  console.log(applied.length > 0 ? `Применены миграции: ${applied.join(', ')}` : 'Новых миграций нет');
  console.log(`База: ${config.databasePath}`);
} finally {
  db.close();
}
