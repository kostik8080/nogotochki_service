// npm run db:reset — удаляет файл базы и создает его заново: миграции и тестовые данные.
// Записи в базе удалять запрещено (триггеры), поэтому пересоздается весь файл.
import { rmSync } from 'node:fs';
import { config } from '../src/config.js';

if (config.isProduction) throw new Error('В production база не пересоздается');

// Вместе с базой — служебные файлы режима WAL.
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(config.databasePath + suffix, { force: true });
}

// Дальше то же, что npm run db:seed.
await import('./db-seed.js');
