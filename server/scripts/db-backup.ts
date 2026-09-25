// npm run db:backup (на сервере: npm run prod:backup) — резервная копия базы в BACKUP_DIR.
// Копия проверяется сразу после создания; старые копии сверх BACKUP_KEEP удаляются.
// На сервере запускается по расписанию (cron), см. README.
import { existsSync } from 'node:fs';
import { config } from '../src/config.js';
import { createBackup, pruneBackups } from '../src/db/backup.js';
import { openDatabase } from '../src/db/connection.js';

// Без этой проверки openDatabase создал бы пустую базу, и копия «успешно» сохранила бы пустоту.
if (!existsSync(config.databasePath)) {
  throw new Error(`Файла базы нет: ${config.databasePath}. Проверьте DATABASE_PATH.`);
}

const db = openDatabase();
try {
  const { file, sizeBytes } = createBackup(db, config.backup.dir);
  console.log(`Резервная копия создана и проверена: ${file} (${(sizeBytes / 1024).toFixed(0)} КБ)`);
} finally {
  db.close();
}

const removed = pruneBackups(config.backup.dir, config.backup.keep);
if (removed.length > 0) {
  console.log(`Удалены старые копии (храним последние ${config.backup.keep}): ${removed.length}`);
}
