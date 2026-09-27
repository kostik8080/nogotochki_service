// Защита от двойной записи (docs/db-schema.md, раздел 10.3; паспорт, сценарий 4) — все три уровня:
//   1. триггеры bookings_no_overlap_insert и bookings_no_overlap_update в самой базе;
//   2. транзакция BEGIN IMMEDIATE (transaction() в connection.ts) — на двух настоящих подключениях к одному файлу;
//   3. ответ API, когда запись отклонил триггер: 409, понятный текст и ближайшие свободные слоты.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { SQLInputValue } from 'node:sqlite';
import { type Db, openDatabase, transaction } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrator.js';
import { fromDatabaseError } from '../src/http/errors.js';
import { at, nextWeekday, PASSWORDS, startApi, type TestApi } from './helpers/api.js';

const ADMIN = 1;
const CLIENT = 2;
const ANNA = 1;
const MARINA = 2;
const DAY = '2026-10-15';
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Схема и минимальные данные: администратор, клиент, два мастера. График триггерам не нужен. */
function setup(db: Db): void {
  runMigrations(db);
  const insert = (table: string, row: Record<string, SQLInputValue>) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
  };
  insert('users', { id: ADMIN, role: 'admin', name: 'Администратор', email: 'admin@example.com', password_hash: HASH });
  insert('users', { id: CLIENT, role: 'client', name: 'Клиентка', phone: '+79110000001' });
  insert('masters', { id: ANNA, name: 'Анна' });
  insert('masters', { id: MARINA, name: 'Марина' });
}

/** Запись по местному времени студии; уборка после визита — cleanupMin минут. Возвращает id. */
function book(db: Db, masterId: number, from: string, to: string, cleanupMin = 0): number {
  const busyUntil = new Date(Date.parse(at(DAY, to)) + cleanupMin * 60_000).toISOString();
  return Number(db.prepare(`
    INSERT INTO bookings (client_id, master_id, starts_at, ends_at, busy_until, price_level, created_by)
    VALUES (?, ?, ?, ?, ?, 'master', ?)
  `).run(CLIENT, masterId, at(DAY, from), at(DAY, to), busyUntil, ADMIN).lastInsertRowid);
}

function cancel(db: Db, id: number): void {
  db.prepare(`INSERT INTO booking_events (booking_id, event_type, actor_id, old_status, new_status) VALUES (?, 'cancelled', ?, 'active', 'cancelled_by_client')`)
    .run(id, CLIENT);
  db.prepare("UPDATE bookings SET status = 'cancelled_by_client' WHERE id = ?").run(id);
}

const SLOT_TAKEN = /SLOT_TAKEN/;

describe('уровень 1: триггеры базы', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
    setup(db);
  });

  it('добавление: пересечение отклоняется, визиты вплотную (15:00–16:00 и 16:00–17:00) — нет', () => {
    book(db, ANNA, '15:00', '16:00');
    book(db, ANNA, '16:00', '17:00');
    book(db, ANNA, '14:00', '15:00');
    assert.throws(() => book(db, ANNA, '15:30', '16:30'), SLOT_TAKEN);
    assert.throws(() => book(db, ANNA, '14:30', '15:10'), SLOT_TAKEN);
    assert.throws(() => book(db, ANNA, '13:00', '18:00'), SLOT_TAKEN); // охватывает все
    assert.throws(() => book(db, ANNA, '15:15', '15:45'), SLOT_TAKEN); // внутри
  });

  it('другой мастер в то же время — не пересечение', () => {
    book(db, ANNA, '15:00', '16:00');
    book(db, MARINA, '15:00', '16:00');
  });

  it('отмененная запись слот не блокирует', () => {
    const id = book(db, ANNA, '15:00', '16:00');
    assert.throws(() => book(db, ANNA, '15:00', '16:00'), SLOT_TAKEN);
    cancel(db, id);
    book(db, ANNA, '15:00', '16:00');
  });

  it('концом занятого времени считается конец уборки: следующий визит — не раньше', () => {
    book(db, ANNA, '15:00', '16:00', 15); // занято до 16:15
    assert.throws(() => book(db, ANNA, '16:00', '17:00'), SLOT_TAKEN);
    book(db, ANNA, '16:15', '17:00');
  });

  it('изменение: перенос на занятое время и смена мастера тоже проверяются', () => {
    book(db, ANNA, '15:00', '16:00');
    const other = book(db, ANNA, '17:00', '18:00');
    const marina = book(db, MARINA, '15:00', '16:00');
    const move = (id: number, masterId: number, from: string, to: string) =>
      db.prepare('UPDATE bookings SET master_id = ?, starts_at = ?, ends_at = ?, busy_until = ? WHERE id = ?')
        .run(masterId, at(DAY, from), at(DAY, to), at(DAY, to), id);

    assert.throws(() => move(other, ANNA, '15:30', '16:30'), SLOT_TAKEN); // перенос
    assert.throws(() => move(marina, ANNA, '15:00', '16:00'), SLOT_TAKEN); // смена мастера
    move(other, ANNA, '16:00', '17:00'); // вплотную — можно
    move(other, ANNA, '16:30', '17:30'); // сдвиг внутри своего же времени — сама запись себе не мешает
  });

  it('возврат отмененной записи в работу проверяется так же', () => {
    const id = book(db, ANNA, '15:00', '16:00');
    cancel(db, id);
    book(db, ANNA, '15:00', '16:00');
    assert.throws(() => db.prepare("UPDATE bookings SET status = 'active' WHERE id = ?").run(id), SLOT_TAKEN);
  });

  it('вторая линия — уникальный индекс: даже без триггеров одна и та же минута начала не пройдет, и в API это «время занято»', () => {
    db.exec('DROP TRIGGER bookings_no_overlap_insert');
    book(db, ANNA, '15:00', '16:00');
    let caught: unknown;
    try {
      book(db, ANNA, '15:00', '15:30');
    } catch (error) {
      caught = error;
    }
    const http = fromDatabaseError(caught);
    assert.equal(http?.status, 409);
    assert.equal(http?.code, 'SLOT_TAKEN');
    assert.equal(http?.details, undefined); // имена таблиц и полей наружу не уходят
  });
});

describe('уровень 2: BEGIN IMMEDIATE', () => {
  let dir: string;
  let a: Db;
  let b: Db;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nogotochki-lock-'));
    const file = path.join(dir, 'test.db');
    a = openDatabase(file);
    setup(a);
    b = openDatabase(file); // второе подключение к тому же файлу — как второй процесс сервера
    b.exec('PRAGMA busy_timeout = 50'); // не ждать 5 секунд в тесте
  });
  after(() => {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('transaction() берет блокировку на запись сразу, до первой вставки', () => {
    transaction(a, () => {
      // Первое подключение еще ничего не записало, а второе уже не может начать запись.
      assert.throws(() => b.exec('BEGIN IMMEDIATE'), /locked/);
      book(a, ANNA, '10:00', '11:00');
    });
    // После фиксации второе подключение начинает транзакцию и видит новую запись: триггер дает понятный отказ.
    assert.throws(() => transaction(b, () => book(b, ANNA, '10:00', '11:00')), SLOT_TAKEN);
  });

  it('для сравнения — BEGIN DEFERRED: оба видят «свободно», второй падает на непонятной ошибке блокировки', () => {
    const free = (db: Db) => (db.prepare(`SELECT count(*) AS n FROM bookings WHERE master_id = ? AND starts_at = ?`).get(MARINA, at(DAY, '12:00')) as { n: number }).n === 0;
    a.exec('BEGIN');
    b.exec('BEGIN');
    assert.ok(free(a));
    assert.ok(free(b)); // второй прочитал снимок базы до записи первого
    book(a, MARINA, '12:00', '13:00');
    a.exec('COMMIT');
    // Писать по устаревшему снимку SQLite не дает: ошибка «database is locked», а не SLOT_TAKEN.
    assert.throws(() => book(b, MARINA, '12:00', '13:00'), (e: Error) => /locked/.test(e.message) && !SLOT_TAKEN.test(e.message));
    b.exec('ROLLBACK');
  });
});

describe('уровень 3: ответ API, когда запись отклонил триггер', () => {
  let api: TestApi;
  before(async () => {
    api = await startApi();
  });
  after(() => api.close());

  it('409, понятное сообщение без текста базы и ближайшие свободные слоты мастера', async () => {
    const maria = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
    const date = nextWeekday(3, 9);
    const startsAt = at(date, '12:00');
    const body = { masterId: MARINA, startsAt, services: [{ serviceId: 12 }] };
    assert.equal((await maria.post('/api/holds', body)).status, 201);

    // Имитация гонки: проверка сервера прошла, а к моменту вставки время занял другой запрос —
    // вставку отклоняет триггер. Временный триггер живет только в этом подключении.
    api.db.exec(`CREATE TEMP TRIGGER race BEFORE INSERT ON bookings BEGIN SELECT RAISE(ABORT, 'SLOT_TAKEN'); END`);
    try {
      const res = await maria.post('/api/bookings', body);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'SLOT_TAKEN');
      assert.match(res.body.error.message, /уже занято/);
      const alternatives = res.body.error.details.alternatives as { masterId: number; startsAt: string }[];
      assert.ok(alternatives.length > 0);
      assert.ok(alternatives.every((s) => s.masterId === MARINA && s.startsAt !== startsAt));
      assert.ok(alternatives.some((s) => s.startsAt.startsWith(startsAt.slice(0, 10)) || s.startsAt > startsAt));
      assert.doesNotMatch(JSON.stringify(res.body), /sqlite|RAISE|constraint|bookings\./i);
    } finally {
      api.db.exec('DROP TRIGGER temp.race');
    }
    // Ничего не записалось: транзакция откатилась целиком.
    assert.equal((api.db.prepare('SELECT count(*) AS n FROM bookings WHERE starts_at = ? AND master_id = ?').get(startsAt, MARINA) as { n: number }).n, 0);
  });

  it('альтернативы берутся и из следующих дней, если выбранный день занят', async () => {
    const date = nextWeekday(3, 16);
    const admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
    // Весь рабочий день Марины закрыт блокировкой: свободного времени в этот день нет.
    await admin.post('/api/admin/time-blocks', { masterId: MARINA, type: 'personal', startsAt: at(date, '00:00'), endsAt: at(date, '23:59') });
    const client = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
    const res = await client.post('/api/holds', { masterId: MARINA, startsAt: at(date, '12:00'), services: [{ serviceId: 12 }] });
    assert.equal(res.status, 409);
    const first = res.body.error.details.alternatives[0].startsAt as string;
    assert.ok(first > at(date, '23:59'), `первая альтернатива ${first} — в следующие дни`);
  });
});

describe('осознанное наложение (is_overbooking)', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
    setup(db);
  });
  const overbook = (masterId: number, from: string, to: string, createdBy = ADMIN) =>
    Number(db.prepare(`
      INSERT INTO bookings (client_id, master_id, is_overbooking, starts_at, ends_at, busy_until, price_level, created_by)
      VALUES (?, ?, 1, ?, ?, ?, 'master', ?)
    `).run(CLIENT, masterId, at(DAY, from), at(DAY, to), at(DAY, to), createdBy).lastInsertRowid);

  it('администратор ставит запись поверх занятого времени, в том числе с той же минуты', () => {
    book(db, ANNA, '15:00', '16:00');
    overbook(ANNA, '15:30', '16:30');
    overbook(ANNA, '15:00', '15:30');
  });

  it('клиент поставить признак не может — отказ базы, даже если сервер ошибется', () => {
    book(db, ANNA, '15:00', '16:00');
    assert.throws(() => overbook(ANNA, '15:30', '16:30', CLIENT), /WRONG_USER_ROLE/);
  });

  it('дальше наложение занимает время как обычная запись', () => {
    book(db, ANNA, '15:00', '16:00');
    const over = overbook(ANNA, '15:30', '16:30');
    assert.throws(() => book(db, ANNA, '16:00', '17:00'), SLOT_TAKEN); // пересекается только с наложением
    book(db, ANNA, '16:30', '17:30'); // вплотную к наложению — можно
    // Обычный перенос (без наложения) снимает признак, и запись проверяется как обычная.
    const move = (from: string, to: string) =>
      db.prepare('UPDATE bookings SET starts_at = ?, ends_at = ?, busy_until = ?, is_overbooking = 0 WHERE id = ?').run(at(DAY, from), at(DAY, to), at(DAY, to), over);
    assert.throws(() => move('15:45', '16:45'), SLOT_TAKEN);
    move('18:00', '19:00');
  });

  it('итог визита у обеих пересекающихся записей отмечается без отказа', () => {
    const base = book(db, ANNA, '15:00', '16:00');
    const over = overbook(ANNA, '15:30', '16:30');
    for (const id of [base, over]) {
      db.prepare("INSERT INTO booking_events (booking_id, event_type, actor_id, old_status, new_status) VALUES (?, 'status_changed', ?, 'active', 'completed')").run(id, ADMIN);
      db.prepare("UPDATE bookings SET status = 'completed' WHERE id = ?").run(id);
    }
  });

  it('перенос поверх занятого времени: только если последнее событие — перенос сюда администратором', () => {
    book(db, ANNA, '15:00', '16:00');
    const moved = book(db, ANNA, '17:00', '18:00');
    const reschedule = (actorId: number) => db.prepare(`
      INSERT INTO booking_events (booking_id, event_type, actor_id, old_master_id, new_master_id, old_starts_at, new_starts_at)
      VALUES (?, 'rescheduled', ?, ?, ?, ?, ?)
    `).run(moved, actorId, ANNA, ANNA, at(DAY, '17:00'), at(DAY, '15:30'));
    const move = () => db.prepare('UPDATE bookings SET starts_at = ?, ends_at = ?, busy_until = ?, is_overbooking = 1 WHERE id = ?')
      .run(at(DAY, '15:30'), at(DAY, '16:30'), at(DAY, '16:30'), moved);

    assert.throws(move, /WRONG_USER_ROLE/); // события переноса нет
    reschedule(CLIENT);
    assert.throws(move, /WRONG_USER_ROLE/); // перенос сделал клиент
    reschedule(ADMIN);
    move(); // администратор — можно
    // Обычный перенос снимает признак: запись снова проверяется как обычная.
    assert.throws(() => db.prepare('UPDATE bookings SET starts_at = ?, ends_at = ?, busy_until = ?, is_overbooking = 0 WHERE id = ?')
      .run(at(DAY, '15:15'), at(DAY, '16:15'), at(DAY, '16:15'), moved), SLOT_TAKEN);
  });

  it('чужую действующую бронь наложение не перебивает', () => {
    const expires = new Date(Date.now() + 600_000).toISOString();
    db.prepare(`
      INSERT INTO slot_holds (owner_id, master_id, starts_at, ends_at, busy_until, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(CLIENT, ANNA, at(DAY, '15:00'), at(DAY, '16:00'), at(DAY, '16:00'), expires, new Date().toISOString());
    assert.throws(() => overbook(ANNA, '15:00', '16:00'), SLOT_TAKEN);
  });
});

describe('осознанное наложение через API', () => {
  let api: TestApi;
  before(async () => {
    api = await startApi();
  });
  after(() => api.close());

  it('администратор записывает поверх занятого времени только с isOverbooking: true', async () => {
    const admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
    const maria = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
    const date = nextWeekday(3, 9);
    const body = { masterId: MARINA, startsAt: at(date, '12:00'), services: [{ serviceId: 12 }] };
    assert.equal((await maria.post('/api/holds', body)).status, 201);
    assert.equal((await maria.post('/api/bookings', body)).status, 201);

    const over = { ...body, newClient: { name: 'Без записи', phone: '+79001230000' } };
    const refused = await admin.post('/api/bookings', over);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'SLOT_TAKEN');

    const created = await admin.post('/api/bookings', { ...over, isOverbooking: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.booking.isOverbooking, true);

    // Рабочее время мастера наложение не отменяет: вечером Марина не работает.
    const late = await admin.post('/api/bookings', { ...body, startsAt: at(date, '21:00'), clientId: created.body.booking.client.id, isOverbooking: true });
    assert.equal(late.status, 409);
  });

  it('наложение поверх блокировки (обеда) и перенос поверх занятого времени — только администратор', async () => {
    const admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
    const date = nextWeekday(4, 16); // четверг: у Анны обед 13:00–14:00
    const clientId = (api.db.prepare("SELECT id FROM users WHERE email = 'maria@example.com'").get() as { id: number }).id;
    const lunch = { masterId: 1, startsAt: at(date, '13:00'), services: [{ serviceId: 2 }], clientId };
    assert.equal((await admin.post('/api/bookings', lunch)).status, 409); // обед занят
    const overLunch = await admin.post('/api/bookings', { ...lunch, isOverbooking: true });
    assert.equal(overLunch.status, 201, JSON.stringify(overLunch.body));

    // Запись в 10:00 переносим на 13:00 — поверх записи на обеде.
    const second = await admin.post('/api/bookings', { ...lunch, startsAt: at(date, '10:00') });
    assert.equal(second.status, 201);
    const id = second.body.booking.id;
    assert.equal((await admin.post(`/api/bookings/${id}/reschedule`, { startsAt: at(date, '13:00') })).status, 409);
    const moved = await admin.post(`/api/bookings/${id}/reschedule`, { startsAt: at(date, '13:00'), isOverbooking: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.booking.isOverbooking, true);
    // Обратно на свободное время — обычным переносом, признак снимается.
    const back = await admin.post(`/api/bookings/${id}/reschedule`, { startsAt: at(date, '10:00') });
    assert.equal(back.body.booking.isOverbooking, false);
  });

  it('клиент передает признак при переносе — он отбрасывается, занятое время недоступно', async () => {
    const maria = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
    const date = nextWeekday(3, 9);
    const free = { masterId: MARINA, startsAt: at(date, '19:00'), services: [{ serviceId: 12 }] };
    assert.equal((await maria.post('/api/holds', free)).status, 201);
    const created = await maria.post('/api/bookings', free);
    assert.equal(created.status, 201);
    // 12:00 у Марины занято (первый тест). Бронь на перенос туда клиенту не дадут, а без брони перенос не пройдет.
    const hold = await maria.post('/api/holds', { bookingId: created.body.booking.id, startsAt: at(date, '12:00') });
    assert.equal(hold.status, 409);
    const res = await maria.post(`/api/bookings/${created.body.booking.id}/reschedule`, { startsAt: at(date, '12:00'), isOverbooking: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'HOLD_NOT_FOUND');
  });

  it('клиент передает признак — он молча отбрасывается, запись обычная', async () => {
    const maria = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
    const date = nextWeekday(3, 9);
    // На занятое время клиент не получит даже брони: признак тут ничего не меняет.
    const busy = await maria.post('/api/holds', { masterId: MARINA, startsAt: at(date, '12:00'), services: [{ serviceId: 12 }] });
    assert.equal(busy.status, 409);

    const free = { masterId: MARINA, startsAt: at(date, '17:00'), services: [{ serviceId: 12 }] };
    assert.equal((await maria.post('/api/holds', free)).status, 201);
    const res = await maria.post('/api/bookings', { ...free, isOverbooking: true });
    assert.equal(res.status, 201);
    assert.equal(res.body.booking.isOverbooking, undefined); // клиенту признак не показывается
    const row = api.db.prepare('SELECT is_overbooking FROM bookings WHERE id = ?').get(res.body.booking.id) as { is_overbooking: number };
    assert.equal(row.is_overbooking, 0);
  });
});
