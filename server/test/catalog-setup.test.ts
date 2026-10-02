// Заполнение каталога на сервере (src/db/catalog.ts, команда setup:catalog): категории, услуги,
// опция «Дизайн ногтей», несовместимые услуги и мастера с графиком — и ничего, кроме них.
// Главное, что проверяется: повторный запуск ничего не меняет и никаких людей команда не заводит.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { seedCatalog } from '../src/db/catalog.js';
import { type Db, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrator.js';

/** Чистая база, как на новом сервере: только схема, без тестовых данных. */
function freshDb(): Db {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

const rows = (db: Db, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

it('на чистой базе заполняет каталог и мастеров с графиком', () => {
  const db = freshDb();
  try {
    seedCatalog(db);
    assert.equal(rows(db, 'service_categories'), 4);
    assert.equal(rows(db, 'services'), 14);
    assert.equal(rows(db, 'masters'), 3);
    // Опция «Дизайн ногтей» доступна с маникюром, маникюром без покрытия, комплексом и наращиванием.
    assert.equal(rows(db, 'service_addon_rules'), 4);
    assert.equal(rows(db, 'service_incompatibilities'), 1);

    const anna = db.prepare("SELECT level, specialty FROM masters WHERE name = 'Анна Ковалева'").get() as
      { level: string; specialty: string };
    assert.equal(anna.level, 'master');
    // У Анны два периода графика: до 1 октября 2026 и после (сценарий 14).
    const schedule = db.prepare('SELECT weekday, valid_from, valid_to, start_time, end_time FROM master_weekly_hours WHERE master_id = 1 ORDER BY valid_from, weekday')
      .all() as unknown as { weekday: number; valid_from: string; valid_to: string | null }[];
    assert.equal(schedule.length, 8);
    assert.equal(schedule[0]!.valid_to, '2026-09-30', 'прежний график закрывается днем накануне нового');
    assert.equal(schedule.at(-1)!.valid_to, null, 'действующий график не ограничен сверху');

    // Цены в копейках: маникюр с покрытием — 1800 ₽ у мастера и 2200 ₽ у топ-мастера.
    const manicure = db.prepare('SELECT price_master_kop, price_top_kop, duration_min FROM services WHERE id = 1').get() as
      { price_master_kop: number; price_top_kop: number; duration_min: number };
    assert.equal(manicure.price_master_kop, 1800_00);
    assert.equal(manicure.price_top_kop, 2200_00);
    assert.equal(manicure.duration_min, 90);
  } finally {
    db.close();
  }
});

it('не заводит ни людей, ни записи, ни фото и не трогает режим технических работ', () => {
  const db = freshDb();
  try {
    const maintenanceBefore = (db.prepare('SELECT is_maintenance FROM settings WHERE id = 1').get() as { is_maintenance: number }).is_maintenance;
    seedCatalog(db);
    assert.equal(rows(db, 'users'), 0, 'учетных записей команда не создает');
    assert.equal(rows(db, 'bookings'), 0);
    assert.equal(rows(db, 'work_photos'), 0);
    assert.equal(rows(db, 'client_profiles'), 0);
    assert.equal(rows(db, 'time_blocks'), 0);
    assert.equal((db.prepare('SELECT is_maintenance FROM settings WHERE id = 1').get() as { is_maintenance: number }).is_maintenance, maintenanceBefore);
  } finally {
    db.close();
  }
});

it('повторный запуск ничего не добавляет и не возвращает измененную цену', () => {
  const db = freshDb();
  try {
    seedCatalog(db);
    // Администратор поправил цену в панели.
    db.prepare('UPDATE services SET price_master_kop = 200000 WHERE id = 1').run();

    const report = seedCatalog(db);
    const created = [...report.values()].reduce((sum, stat) => sum + stat.created, 0);
    assert.equal(created, 0, 'второй запуск ничего не добавляет');
    assert.equal(rows(db, 'services'), 14);
    assert.equal((db.prepare('SELECT price_master_kop FROM services WHERE id = 1').get() as { price_master_kop: number }).price_master_kop,
      200000, 'цена администратора осталась');
  } finally {
    db.close();
  }
});
