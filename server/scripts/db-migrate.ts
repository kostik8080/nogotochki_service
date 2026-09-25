// npm run db:migrate — создает файл базы, если его нет, и применяет новые миграции.
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrator.js';

const db = openDatabase();
try {
  const applied = runMigrations(db);
  console.log(applied.length > 0 ? `Применены миграции: ${applied.join(', ')}` : 'Новых миграций нет');
  console.log(`База: ${config.databasePath}`);
} finally {
  db.close();
}
