// Приведение базы к нужной схеме: применяются миграции, которых в базе еще нет.
// Этим пользуются и команда `npm run db:migrate`, и сам сервер при запуске — чтобы они вели себя
// одинаково. На сервере в контейнере команду миграций набирать некому: контейнер собирается заново
// при каждом обновлении, а база лежит в отдельной папке и переживает его.
//
// Повторно миграция не применяется: мигратор помнит примененные в таблице schema_migrations
// (src/db/migrator.ts). Каждая выполняется в своей транзакции, поэтому при ошибке база остается прежней.
import { config } from '../config.js';
import { createBackup } from './backup.js';
import type { Db } from './connection.js';
import { pendingMigrations, runMigrations } from './migrator.js';

/**
 * Применяет новые миграции и возвращает их имена. В production перед этим делается резервная копия,
 * если в базе уже есть данные: миграция откатывается при ошибке сама, а копия защищает от миграции,
 * которая прошла, но сделала не то.
 */
export function applyMigrations(db: Db): string[] {
  const pending = pendingMigrations(db);
  const hasData = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (config.isProduction && pending.length > 0 && hasData) {
    const backup = createBackup(db, config.backup.dir, 'pre-migrate');
    console.log(`Резервная копия перед миграциями: ${backup.file}`);
  }
  return runMigrations(db);
}
