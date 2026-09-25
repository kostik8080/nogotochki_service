// npm run db:check-schema — сверяет базу, которую строят миграции, с документом docs/db-schema.md:
// таблицы, поля, типы, обязательность, первичные и внешние ключи, уникальные поля (раздел 5)
// и индексы (разделы 9 и 10.1). База собирается в памяти, файл data/ не затрагивается.
// При расхождениях команда завершается с кодом 1.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_ROOT } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrator.js';

const DOC_PATH = path.resolve(SERVER_ROOT, '../docs/db-schema.md');

interface DocField {
  name: string;
  type: string;
  notNull: boolean;
  key: string;
}

interface DocIndex {
  table: string;
  columns: string;
  unique: boolean;
  partial: boolean;
}

// ---------------------------------------------------------------------------
// Разбор документа
// ---------------------------------------------------------------------------

const doc = readFileSync(DOC_PATH, 'utf8');

/** Раздел 5: заголовок «### 5.N. `table`» и таблица | Поле | Тип | Обяз. | Ключ | Описание |. */
function parseTables(): Map<string, DocField[]> {
  const tables = new Map<string, DocField[]>();
  let current: DocField[] | null = null;
  for (const line of doc.split(/\r?\n/)) {
    const heading = line.match(/^### 5\.\d+\. `(\w+)`/);
    if (heading) {
      current = [];
      tables.set(heading[1]!, current);
      continue;
    }
    if (line.startsWith('## ')) current = null;
    if (!current || !line.startsWith('| `')) continue;
    // В разделе есть и другие таблицы (например, статусы записи) — у них меньше колонок.
    const cells = line.split('|').map((s) => s.trim());
    if (cells.length < 7) continue;
    current.push({
      name: cells[1]!.replace(/`/g, ''),
      type: cells[2]!,
      notNull: cells[3] === 'да',
      key: cells[4]!,
    });
  }
  return tables;
}

function section(from: string, to: string): string {
  const start = doc.indexOf(from);
  const end = doc.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`В документе не найден раздел «${from}»`);
  return doc.slice(start, end);
}

/** Индексы: таблица раздела 10.1 и составные уникальные ограничения раздела 9. */
function parseIndexes(): DocIndex[] {
  const result: DocIndex[] = [];
  for (const m of section('### 10.1.', '### 10.2.').matchAll(/^\| `(\w+) \(([^)]+)\)`/gm)) {
    result.push({ table: m[1]!, columns: m[2]!, unique: false, partial: false });
  }
  for (const m of section('## 9.', '## 10.').matchAll(/^\| `(\w+) \(([^)]+)\)( WHERE [^`]*)?` — (?:UNIQUE|уникальный)/gm)) {
    result.push({ table: m[1]!, columns: m[2]!, unique: true, partial: m[3] !== undefined });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Сверка
// ---------------------------------------------------------------------------

const docTables = parseTables();
const docIndexes = parseIndexes();
if (docTables.size === 0 || docIndexes.length === 0) {
  throw new Error('Не удалось разобрать docs/db-schema.md: изменился формат разделов 5, 9 или 10.1');
}

const db = openDatabase(':memory:');
runMigrations(db);

const problems: string[] = [];
const all = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];

interface ColumnInfo { name: string; type: string; notnull: number; pk: number }
interface ForeignKeyInfo { table: string; from: string; to: string; on_delete: string }
interface IndexListInfo { name: string; unique: number }

const dbTables = all<{ name: string }>(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'",
).map((t) => t.name);

for (const table of docTables.keys()) if (!dbTables.includes(table)) problems.push(`нет таблицы ${table}`);
for (const table of dbTables) if (!docTables.has(table)) problems.push(`таблица ${table} не описана в документе`);

/** Одноколоночные уникальные индексы таблицы: UNIQUE у поля или отдельный индекс. */
function uniqueColumns(table: string): Set<string> {
  const columns = new Set<string>();
  for (const index of all<IndexListInfo>(`PRAGMA index_list(${table})`)) {
    if (!index.unique) continue;
    const cols = all<{ name: string }>(`PRAGMA index_info(${index.name})`);
    if (cols.length === 1) columns.add(cols[0]!.name);
  }
  return columns;
}

let fieldCount = 0;
let foreignKeyCount = 0;
for (const [table, fields] of docTables) {
  if (!dbTables.includes(table)) continue;
  const columns = all<ColumnInfo>(`PRAGMA table_info(${table})`);
  const foreignKeys = all<ForeignKeyInfo>(`PRAGMA foreign_key_list(${table})`);
  const unique = uniqueColumns(table);

  for (const field of fields) {
    fieldCount++;
    const where = `${table}.${field.name}`;
    const column = columns.find((c) => c.name === field.name);
    if (!column) {
      problems.push(`${where}: нет поля`);
      continue;
    }
    if (column.type !== field.type) problems.push(`${where}: тип ${column.type}, в документе ${field.type}`);
    // Первичный ключ STRICT-таблицы не бывает пустым, даже без явного NOT NULL.
    const notNull = column.notnull === 1 || column.pk > 0;
    if (notNull !== field.notNull) {
      problems.push(`${where}: ${notNull ? 'NOT NULL' : 'может быть пустым'}, в документе — ${field.notNull ? 'обязательно' : 'необязательно'}`);
    }
    if (/PK/.test(field.key) !== column.pk > 0) problems.push(`${where}: первичный ключ не совпадает с документом`);
    if (/UQ/.test(field.key) && !unique.has(field.name)) problems.push(`${where}: нет UNIQUE`);

    const ref = field.key.match(/FK → `(\w+)\.(\w+)`/);
    const fk = foreignKeys.find((f) => f.from === field.name);
    if (ref) {
      foreignKeyCount++;
      if (!fk) problems.push(`${where}: нет внешнего ключа`);
      else if (fk.table !== ref[1] || fk.to !== ref[2]) problems.push(`${where}: ссылка на ${fk.table}.${fk.to}, в документе ${ref[1]}.${ref[2]}`);
      else if (fk.on_delete !== 'RESTRICT') problems.push(`${where}: ON DELETE ${fk.on_delete}, в документе RESTRICT (раздел 1)`);
    } else if (fk) {
      problems.push(`${where}: внешний ключ на ${fk.table} не описан в документе`);
    }
  }
  for (const column of columns) {
    if (!fields.some((f) => f.name === column.name)) problems.push(`${table}.${column.name}: поле не описано в документе`);
  }
  const strict = db.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').pluck().get(table);
  if (!strict) problems.push(`${table}: таблица не STRICT (раздел 1)`);
}

const dbIndexes = all<{ table: string; name: string; sql: string }>(
  "SELECT tbl_name AS \"table\", name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
).map((index) => ({
  ...index,
  columns: all<{ name: string }>(`PRAGMA index_info(${index.name})`).map((c) => c.name).join(', '),
  unique: /^CREATE UNIQUE/i.test(index.sql),
  partial: /\bWHERE\b/i.test(index.sql),
}));

for (const want of docIndexes) {
  const found = dbIndexes.some((i) =>
    i.table === want.table && i.columns === want.columns && i.unique === want.unique && i.partial === want.partial);
  if (!found) {
    problems.push(`нет ${want.unique ? 'уникального ' : ''}${want.partial ? 'частичного ' : ''}индекса ${want.table} (${want.columns})`);
  }
}
for (const index of dbIndexes) {
  const described = docIndexes.some((w) => w.table === index.table && w.columns === index.columns && w.unique === index.unique);
  if (!described) problems.push(`индекс ${index.name} на ${index.table} (${index.columns}) не описан в разделах 9 и 10.1`);
}

db.close();

console.log(`Таблицы: документ ${docTables.size}, миграции ${dbTables.length}`);
console.log(`Поля: ${fieldCount}, внешние ключи: ${foreignKeyCount}, индексы: ${docIndexes.length}`);
if (problems.length > 0) {
  console.log(`\nРасхождений: ${problems.length}`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  process.exitCode = 1;
} else {
  console.log('Расхождений со схемой нет');
}
