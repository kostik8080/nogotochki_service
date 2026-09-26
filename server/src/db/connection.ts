// Подключение к файлу базы SQLite через встроенный модуль node:sqlite (без нативных пакетов).
// Все модули сервера получают базу только отсюда, чтобы у каждого подключения были одинаковые настройки.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

export type Db = DatabaseSync;

/** Таблицы STRICT появились в SQLite 3.37 (docs/db-schema.md, раздел 1). */
const MIN_SQLITE_VERSION = [3, 37, 0];

export function openDatabase(file: string = config.databasePath): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // Внешние ключи в SQLite включаются для каждого подключения отдельно. node:sqlite включает их сам,
  // но команда здесь явная, чтобы не зависеть от значения по умолчанию.
  db.exec('PRAGMA foreign_keys = ON');
  // WAL: чтение не ждет записи, запись не ждет чтения.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // Сколько ждать, если базу сейчас пишет другая транзакция (BEGIN IMMEDIATE, раздел 10.3), а не падать сразу.
  db.exec('PRAGMA busy_timeout = 5000');

  checkSqlite(db);
  return db;
}

/**
 * Выполняет fn в транзакции BEGIN IMMEDIATE: блокировка на запись берется сразу,
 * поэтому проверка «свободно ли» и вставка неразделимы (docs/db-schema.md, раздел 10.3).
 * При ошибке все изменения откатываются.
 *
 * Внутри уже открытой транзакции (например, отмена записей при удалении аккаунта) fn выполняется
 * в точке сохранения SAVEPOINT: блокировку уже держит внешняя транзакция, а ошибка откатывает
 * только изменения fn.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    db.exec('SAVEPOINT nested');
    try {
      const result = fn();
      db.exec('RELEASE nested');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO nested');
      db.exec('RELEASE nested');
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function checkSqlite(db: Db): void {
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  if (fk.foreign_keys !== 1) {
    throw new Error('SQLite: не удалось включить внешние ключи (PRAGMA foreign_keys)');
  }
  const { version } = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
  const parts = version.split('.').map(Number);
  for (let i = 0; i < MIN_SQLITE_VERSION.length; i++) {
    const have = parts[i] ?? 0;
    const need = MIN_SQLITE_VERSION[i] ?? 0;
    if (have > need) break;
    if (have < need) throw new Error(`SQLite ${version}: нужна версия ${MIN_SQLITE_VERSION.join('.')} или новее`);
  }
}
