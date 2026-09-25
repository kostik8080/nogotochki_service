// Применение миграций: SQL-файлы из папки migrations/ выполняются по порядку имен,
// каждый один раз. Какие уже применены, база помнит в таблице schema_migrations.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type Db, transaction } from './connection.js';

export const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/** Имя файла миграции: номер из трех цифр и описание, например 001_init.sql. */
const FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

interface AppliedMigration {
  name: string;
  checksum: string;
}

/** Имена миграций, которые еще не применены к базе. Базу не меняет. */
export function pendingMigrations(db: Db, dir: string = MIGRATIONS_DIR): string[] {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = new Set(hasTable
    ? (db.prepare('SELECT name FROM schema_migrations').all() as unknown as { name: string }[]).map((m) => m.name)
    : []);
  return readdirSync(dir).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort();
}

/** Применяет новые миграции и возвращает их имена. */
export function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);

  const applied = new Map(
    (db.prepare('SELECT name, checksum FROM schema_migrations').all() as unknown as AppliedMigration[])
      .map((m) => [m.name, m.checksum]),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const newlyApplied: string[] = [];

  for (const name of files) {
    if (!FILE_PATTERN.test(name)) {
      throw new Error(`Миграция ${name}: имя должно быть вида 001_description.sql`);
    }
    const sql = readFileSync(path.join(dir, name), 'utf8');
    // Сумма считается по тексту с едиными окончаниями строк: git в Windows может заменить \n на \r\n,
    // и без этого та же миграция выглядела бы измененной.
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

    const appliedChecksum = applied.get(name);
    if (appliedChecksum !== undefined) {
      // Примененную миграцию нельзя править: база уже построена по старому тексту.
      // Изменение схемы оформляется новым файлом со следующим номером.
      if (appliedChecksum !== checksum) {
        throw new Error(`Миграция ${name} изменена после применения. Добавьте изменения новой миграцией.`);
      }
      continue;
    }

    applyMigration(db, name, sql, checksum);
    newlyApplied.push(name);
  }

  // Контрольная проверка всех ссылок: в SQLite внешний ключ меняют пересозданием таблицы,
  // и ошибка в такой миграции могла оставить строки со ссылками в никуда.
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new Error(`После миграций нарушены внешние ключи: ${JSON.stringify(violations)}`);
  }
  return newlyApplied;
}

/**
 * Пометка в тексте миграции, которая пересоздает таблицу. Так в SQLite меняют CHECK, внешние ключи
 * и типы полей: создать новую таблицу, скопировать строки, удалить старую, переименовать новую
 * (https://sqlite.org/lang_altertable.html#otheralter). Пока старая таблица удалена, ссылки на нее
 * формально нарушены, поэтому проверка внешних ключей выключается на время миграции,
 * а перед фиксацией все ссылки проверяются разом.
 */
const FOREIGN_KEYS_OFF = /^--\s*migrator:\s*foreign_keys\s*=\s*off\s*$/m;

/** Файл целиком в одной транзакции: при ошибке база остается в прежнем состоянии. */
function applyMigration(db: Db, name: string, sql: string, checksum: string): void {
  const foreignKeysOff = FOREIGN_KEYS_OFF.test(sql);
  // Внутри транзакции PRAGMA foreign_keys не действует, поэтому выключается до BEGIN.
  if (foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      db.exec(sql);
      if (foreignKeysOff) {
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(`Миграция ${name} нарушает внешние ключи: ${JSON.stringify(violations)}`);
        }
      }
      db.prepare('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)').run(name, checksum);
    });
  } finally {
    if (foreignKeysOff) {
      // Миграция включает legacy_alter_table для переименования; если она упала, флаг остался бы включен.
      db.exec('PRAGMA legacy_alter_table = OFF');
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}
