// npm run db:fresh — удаляет локальную базу и создает ее заново: все миграции по порядку номеров,
// без тестовых данных. Получается база ровно такой, какой ее строят миграции, — как новая база на проде.
// С тестовыми данными — npm run db:reset. В production команда не запускается.
import { existsSync, rmSync } from 'node:fs';
import { config } from '../src/config.js';

if (config.isProduction) throw new Error('В production база не пересоздается');

// Вместе с базой — служебные файлы режима WAL: старый -wal рядом с новой базой испортил бы ее.
const files = ['', '-wal', '-shm'].map((suffix) => config.databasePath + suffix).filter((file) => existsSync(file));
for (const file of files) {
  try {
    rmSync(file);
  } catch (error) {
    // В Windows открытый файл удалить нельзя.
    throw new Error(`Не удалось удалить ${file}: закройте программы, которые держат базу открытой (сервер, просмотрщик БД).\n${String(error)}`);
  }
}
console.log(files.length > 0 ? `Удалена база: ${config.databasePath}` : `Базы не было: ${config.databasePath}`);

// Дальше то же, что npm run db:migrate: создать файл и применить миграции по порядку.
await import('./db-migrate.js');
