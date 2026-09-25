// Подключение к файлу базы SQLite. Все модули сервера получают базу только отсюда,
// чтобы у каждого подключения были одинаковые настройки.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

export type Db = Database.Database;

/** Таблицы STRICT появились в SQLite 3.37 (docs/db-schema.md, раздел 1). */
const MIN_SQLITE_VERSION = [3, 37, 0];

export function openDatabase(file: string = config.databasePath): Db {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);

  // Внешние ключи в SQLite по умолчанию выключены и включаются для каждого подключения отдельно.
  db.pragma('foreign_keys = ON');
  // WAL: чтение не ждет записи, запись не ждет чтения.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Сколько ждать, если базу сейчас пишет другая транзакция (BEGIN IMMEDIATE, раздел 10.3), а не падать сразу.
  db.pragma('busy_timeout = 5000');

  checkSqlite(db);
  return db;
}

function checkSqlite(db: Db): void {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('SQLite: не удалось включить внешние ключи (PRAGMA foreign_keys)');
  }
  const version = db.prepare('SELECT sqlite_version() AS v').pluck().get() as string;
  const parts = version.split('.').map(Number);
  for (let i = 0; i < MIN_SQLITE_VERSION.length; i++) {
    const have = parts[i] ?? 0;
    const need = MIN_SQLITE_VERSION[i] ?? 0;
    if (have > need) break;
    if (have < need) throw new Error(`SQLite ${version}: нужна версия ${MIN_SQLITE_VERSION.join('.')} или новее`);
  }
}
