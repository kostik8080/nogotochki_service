// Резервные копии базы. Копия делается командой VACUUM INTO: SQLite записывает целостный снимок
// базы на момент начала команды, даже если сервер в это время пишет в базу. Простое копирование
// файла так не умеет: в режиме WAL часть данных лежит в соседнем файле -wal, и копия может выйти битой.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './connection.js';

/** Имя копии: nogotochki-ГГГГММДД-ЧЧММССZ[-метка].db, время в UTC. По нему же копии находятся для удаления. */
const BACKUP_FILE = /^nogotochki-\d{8}-\d{6}Z(?:-[a-z0-9-]+)?\.db$/;

export interface BackupInfo {
  file: string;
  sizeBytes: number;
}

/**
 * Делает копию базы в папку dir и проверяет ее. Метка попадает в имя файла:
 * например, pre-migrate — копия перед применением миграций.
 */
export function createBackup(db: Db, dir: string, label?: string, now = new Date()): BackupInfo {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '-');
  const file = path.join(dir, `nogotochki-${stamp}${label ? `-${label}` : ''}.db`);
  if (existsSync(file)) throw new Error(`Копия ${file} уже есть: повторите через секунду`);

  db.prepare('VACUUM INTO ?').run(file);
  try {
    verifyBackup(file);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
  return { file, sizeBytes: statSync(file).size };
}

/**
 * Проверяет копию: SQLite читает ее целиком (integrity_check) и находит таблицу миграций.
 * Заодно переводит копию из режима WAL в обычный, чтобы она была одним самодостаточным файлом.
 */
export function verifyBackup(file: string): void {
  const copy = new DatabaseSync(file);
  try {
    copy.exec('PRAGMA journal_mode = DELETE');
    const { integrity_check: result } = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (result !== 'ok') throw new Error(`Копия ${file} повреждена: ${result}`);
    const migrations = copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!migrations) throw new Error(`В копии ${file} нет таблицы schema_migrations — это не база сервиса`);
  } finally {
    copy.close();
  }
}

/** Копии в папке, от новых к старым. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  // Время в имени идет в порядке ГГГГММДД-ЧЧММСС, поэтому сортировка имен — это сортировка по времени.
  return readdirSync(dir).filter((name) => BACKUP_FILE.test(name)).sort().reverse()
    .map((name) => path.join(dir, name));
}

/** Удаляет старые копии, оставляя keep последних. Другие файлы в папке не трогает. Возвращает удаленные. */
export function pruneBackups(dir: string, keep: number): string[] {
  const removed = listBackups(dir).slice(keep);
  for (const file of removed) rmSync(file);
  return removed;
}
