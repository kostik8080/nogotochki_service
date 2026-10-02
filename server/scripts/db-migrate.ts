// npm run db:migrate — создает файл базы, если его нет, и применяет новые миграции.
// В production перед применением делается резервная копия, если в базе уже есть данные:
// миграция откатывается при ошибке сама, а копия защищает от миграции, которая прошла, но сделала не то.
import { config } from '../src/config.js';
import { applyMigrations } from '../src/db/auto-migrate.js';
import { openDatabase } from '../src/db/connection.js';

const db = openDatabase();
try {
  // Та же функция, что применяет миграции при запуске сервера (src/db/auto-migrate.ts):
  // команда и автоматическое применение не могут разойтись.
  const applied = applyMigrations(db);
  console.log(applied.length > 0 ? `Применены миграции: ${applied.join(', ')}` : 'Новых миграций нет');
  console.log(`База: ${config.databasePath}`);
} finally {
  db.close();
}
