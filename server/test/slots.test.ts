// Тесты расчета свободных слотов (docs/db-schema.md, раздел 7) на примерах из раздела 7.4
// и сценариях паспорта. База — в памяти, со всеми миграциями; данные — на фиксированных датах,
// поэтому результат не зависит от дня запуска. Время в проверках — по Москве.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { SQLInputValue } from 'node:sqlite';
import { findMastersForServices, getFreeIntervals, getMasterDay, getSlots, getSlotsAnyMaster, getVisitTiming, type SlotQuery } from '../src/booking/slots.js';
import { type Db, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrator.js';
import { zonedTime, zonedTimeToUtc } from '../src/lib/studio-time.js';

const TZ = 'Europe/Moscow';
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADMIN = 1;
const CLIENT = 2;
const OTHER_CLIENT = 3;
const ANNA = 1;
const MARINA = 2;
const ELENA = 3;
const MANICURE = 1; // 90 мин, уборка 15
const MANICURE_PLAIN = 2; // 45 мин, уборка 15
const DESIGN = 3; // опция, 30 мин, уборка 0
const PEDICURE = 5; // 90 мин, уборка 15
const EXTENSION = 8; // 150 мин, уборка 15
const LAMINATION = 12; // 60 мин, уборка 10

// Даты 2026 года: 22.09 — вторник, 24.09 — четверг, 25.09 — пятница, 26.09 — суббота.
const TUE = '2026-09-22';
const THU = '2026-09-24';
const FRI = '2026-09-25';
const SAT = '2026-09-26';
/** Задолго до проверяемых дат: ограничения клиента (2 часа, горизонт) не мешают. */
const EARLY = new Date('2026-09-01T00:00:00.000Z');

const at = (date: string, time: string) => new Date(zonedTimeToUtc(date, time, TZ)).toISOString();
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

let db: Db;

function insert(table: string, row: Record<string, SQLInputValue>): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
}

/** Запись к мастеру; уборка задается явно, как ее копирует сервис в момент записи. */
function addBooking(masterId: number, date: string, time: string, durationMin: number, cleanupMin: number, status = 'active'): number {
  const startsAt = at(date, time);
  const endsAt = plus(startsAt, durationMin);
  insert('bookings', {
    client_id: OTHER_CLIENT, master_id: masterId, starts_at: startsAt, ends_at: endsAt,
    busy_until: plus(endsAt, cleanupMin), price_level: 'master', created_by: ADMIN,
  });
  const id = Number((db.prepare('SELECT max(id) AS id FROM bookings').get() as { id: number }).id);
  if (status !== 'active') {
    if (status.startsWith('cancelled')) {
      insert('booking_events', { booking_id: id, event_type: 'cancelled', actor_id: ADMIN, old_status: 'active', new_status: status });
    }
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, id);
  }
  return id;
}

function addHold(ownerId: number, masterId: number, date: string, time: string, durationMin: number, cleanupMin: number, expiresAt: Date): void {
  const startsAt = at(date, time);
  insert('slot_holds', {
    owner_id: ownerId, master_id: masterId, starts_at: startsAt, ends_at: plus(startsAt, durationMin),
    busy_until: plus(startsAt, durationMin + cleanupMin), expires_at: expiresAt.toISOString(),
    created_at: new Date(expiresAt.getTime() - 10 * 60_000).toISOString(),
  });
}

function addBlock(masterId: number, type: string, fromDate: string, fromTime: string, toDate: string, toTime: string): void {
  insert('time_blocks', {
    master_id: masterId, block_type: type, starts_at: at(fromDate, fromTime), ends_at: at(toDate, toTime), created_by: ADMIN,
  });
}

/** Время начала слотов по Москве. */
function times(q: Partial<SlotQuery> & Pick<SlotQuery, 'masterId' | 'date' | 'durationMin' | 'cleanupMin'>): string[] {
  return getSlots(db, { now: EARLY, audience: 'admin', ...q }).map((s) => s.time);
}

/** Слоты с шагом 30 минут от from до to включительно. */
function range(from: string, to: string): string[] {
  const result: string[] = [];
  for (let t = zonedTimeToUtc(THU, from, TZ); t <= zonedTimeToUtc(THU, to, TZ); t += 30 * 60_000) result.push(zonedTime(t, TZ));
  return result;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db); // миграция 002 создает настройки: шаг 30 минут, 2 часа до визита, горизонт 90 дней
  insert('users', { id: ADMIN, role: 'admin', name: 'Администратор', email: 'admin@example.com', password_hash: HASH });
  insert('users', { id: CLIENT, role: 'client', name: 'Клиентка', phone: '+79110000001' });
  insert('users', { id: OTHER_CLIENT, role: 'client', name: 'Другая клиентка', phone: '+79110000002' });

  insert('service_categories', { id: 1, name: 'Ногти' });
  insert('service_categories', { id: 2, name: 'Брови' });
  const service = (id: number, category: number, kind: string, name: string, duration: number, cleanup: number) =>
    insert('services', {
      id, category_id: category, kind, name, duration_min: duration, cleanup_min: cleanup,
      price_master_kop: 100_000, price_top_kop: 100_000, max_quantity: kind === 'addon' ? 5 : 1,
    });
  service(MANICURE, 1, 'main', 'Маникюр с покрытием', 90, 15);
  service(MANICURE_PLAIN, 1, 'main', 'Маникюр без покрытия', 45, 15);
  service(DESIGN, 1, 'addon', 'Дизайн ногтей', 30, 0);
  service(PEDICURE, 1, 'main', 'Педикюр с покрытием', 90, 15);
  service(EXTENSION, 1, 'main', 'Наращивание', 150, 15);
  service(LAMINATION, 2, 'main', 'Ламинирование бровей', 60, 10);

  // Мастера и график — как в паспорте. У Анны с 1 октября новый график ср–сб (сценарий 14).
  const master = (id: number, name: string, services: number[], schedule: [string, string | null, number[], string, string][]) => {
    insert('masters', { id, name, sort_order: id });
    for (const s of services) insert('master_services', { master_id: id, service_id: s });
    for (const [from, to, weekdays, start, end] of schedule) {
      for (const weekday of weekdays) {
        insert('master_weekly_hours', { master_id: id, weekday, valid_from: from, valid_to: to, start_time: start, end_time: end });
      }
    }
  };
  master(ANNA, 'Анна Ковалева', [MANICURE, MANICURE_PLAIN, DESIGN, PEDICURE, EXTENSION], [
    ['2024-01-01', '2026-09-30', [2, 3, 4, 5], '10:00', '18:00'],
    ['2026-10-01', null, [3, 4, 5, 6], '10:00', '18:00'],
  ]);
  master(MARINA, 'Марина Орлова', [LAMINATION], [['2024-01-01', null, [3, 4, 5, 6], '11:00', '20:00']]);
  master(ELENA, 'Елена Смирнова', [MANICURE, MANICURE_PLAIN, PEDICURE, EXTENSION, LAMINATION], [['2024-01-01', null, [2, 4, 6], '10:00', '19:00']]);

  // Сценарий 1: обед Анны в четверг. Сценарий 3: личное время Марины в пятницу, выходной Елены в субботу.
  addBlock(ANNA, 'lunch', THU, '13:00', THU, '14:00');
  addBlock(MARINA, 'personal', FRI, '15:00', FRI, '17:00');
  addBlock(ELENA, 'day_off', SAT, '00:00', '2026-09-27', '00:00');

  // Особые дни студии: санитарный день и сокращенный предпраздничный.
  insert('studio_day_overrides', { work_date: '2026-09-29', is_open: 0, reason: 'Санитарный день', created_by: ADMIN });
  insert('studio_day_overrides', { work_date: '2026-12-31', is_open: 1, open_time: '10:00', close_time: '16:00', reason: 'Предпраздничный день', created_by: ADMIN });
});

describe('примеры раздела 7.4', () => {
  it('сценарий 1: у Анны в четверг нет слотов на обеде и позже 16:30', () => {
    assert.deepEqual(
      getFreeIntervals(db, { masterId: ANNA, date: THU, now: EARLY }).map((i) => `${zonedTime(i.start, TZ)}–${zonedTime(i.end, TZ)}`),
      ['10:00–13:00', '14:00–18:00'],
    );
    assert.deepEqual(times({ masterId: ANNA, date: THU, durationMin: 90, cleanupMin: 15 }), [...range('10:00', '11:30'), ...range('14:00', '16:30')]);
  });

  it('уборка может заходить на обед и за конец смены', () => {
    const slots = times({ masterId: ANNA, date: THU, durationMin: 90, cleanupMin: 15 });
    assert.ok(slots.includes('11:30'), 'визит до 13:00, уборка 13:00–13:15 на обеде');
    assert.ok(slots.includes('16:30'), 'визит до 18:00, уборка до 18:15 за сменой');
  });

  it('уборка между клиентами: после записи 10:00–11:30 первый слот 12:00, а не 11:30', () => {
    addBooking(ANNA, TUE, '10:00', 90, 15);
    const slots = times({ masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15 });
    assert.equal(slots[0], '12:00');
    assert.ok(!slots.includes('11:30'));
  });

  it('сценарий 3: у Марины в пятницу последний слот до личного времени — 14:00', () => {
    assert.deepEqual(times({ masterId: MARINA, date: FRI, durationMin: 60, cleanupMin: 10 }), [...range('11:00', '14:00'), ...range('17:00', '19:00')]);
  });

  it('сценарий 3: у Елены суббота заблокирована как выходной — слотов нет', () => {
    assert.equal(getMasterDay(db, ELENA, SAT).status, 'open', 'по графику суббота рабочая');
    assert.deepEqual(getFreeIntervals(db, { masterId: ELENA, date: SAT, now: EARLY }), []);
    assert.deepEqual(times({ masterId: ELENA, date: SAT, durationMin: 60, cleanupMin: 10 }), []);
  });

  it('особый день студии: 31 декабря окно Марины 11:00–16:00, последний часовой слот 15:00', () => {
    const slots = times({ masterId: MARINA, date: '2026-12-31', durationMin: 60, cleanupMin: 10 });
    assert.equal(slots[0], '11:00');
    assert.equal(slots.at(-1), '15:00');
    const day = getMasterDay(db, MARINA, '2026-12-31');
    assert.equal(day.status === 'open' && day.studioReason, 'Предпраздничный день');
  });

  it('смена графика: вторник 22.09 — по старому графику, вторник 06.10 — Анна не работает', () => {
    assert.equal(times({ masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15 })[0], '10:00');
    assert.deepEqual(getMasterDay(db, ANNA, '2026-10-06'), { status: 'master_off', date: '2026-10-06' });
    assert.equal(times({ masterId: ANNA, date: '2026-10-03', durationMin: 90, cleanupMin: 15 })[0], '10:00', 'суббота 03.10 — уже рабочая');
  });
});

describe('порядок правил 7.2', () => {
  it('закрытая студия важнее рабочего дня мастера', () => {
    insert('master_day_overrides', { master_id: ANNA, work_date: '2026-09-29', is_working: 1, start_time: '10:00', end_time: '18:00', created_by: ADMIN });
    assert.deepEqual(getMasterDay(db, ANNA, '2026-09-29'), { status: 'studio_closed', date: '2026-09-29', reason: 'Санитарный день' });
  });

  it('обычный выходной студии — без причины', () => {
    assert.deepEqual(getMasterDay(db, ANNA, '2026-09-27'), { status: 'studio_closed', date: '2026-09-27', reason: null });
  });

  it('изменение на дату: выход в нерабочий день и выходной в рабочий', () => {
    insert('master_day_overrides', { master_id: ELENA, work_date: '2026-09-23', is_working: 1, start_time: '12:00', end_time: '19:00', created_by: ADMIN });
    insert('master_day_overrides', { master_id: ANNA, work_date: FRI, is_working: 0, created_by: ADMIN });
    assert.equal(times({ masterId: ELENA, date: '2026-09-23', durationMin: 60, cleanupMin: 10 })[0], '12:00');
    assert.deepEqual(getMasterDay(db, ANNA, FRI), { status: 'master_off', date: FRI });
  });

  it('смена мастера обрезается часами студии', () => {
    insert('master_day_overrides', { master_id: ELENA, work_date: THU, is_working: 1, start_time: '08:00', end_time: '22:00', created_by: ADMIN });
    const slots = times({ masterId: ELENA, date: THU, durationMin: 60, cleanupMin: 10 });
    assert.equal(slots[0], '10:00');
    assert.equal(slots.at(-1), '19:00');
  });

  it('отключенный мастер не получает свободного времени', () => {
    db.prepare('UPDATE masters SET is_active = 0 WHERE id = ?').run(ANNA);
    assert.equal(getMasterDay(db, ANNA, THU).status, 'master_inactive');
    assert.deepEqual(times({ masterId: ANNA, date: THU, durationMin: 90, cleanupMin: 15 }), []);
  });
});

describe('записи и брони', () => {
  it('визит с уборкой не должен задевать следующую запись', () => {
    addBooking(ANNA, TUE, '12:00', 45, 15);
    const slots = times({ masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15 });
    assert.ok(slots.includes('10:00'), '10:00–11:30, уборка до 11:45 — до записи в 12:00');
    assert.ok(!slots.includes('10:30'), '10:30–12:00 заканчивается впритык, но уборка до 12:15 задевает запись');
  });

  it('стык не пересечение: уборка до 12:00 — слот 12:00 свободен', () => {
    addBooking(ANNA, TUE, '10:15', 90, 15); // до 11:45, уборка до 12:00
    assert.ok(times({ masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15 }).includes('12:00'));
  });

  it('отмененные записи время не занимают, завершенные и неявки — занимают', () => {
    addBooking(ANNA, TUE, '10:00', 90, 15, 'cancelled_by_client');
    assert.equal(times({ masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15 })[0], '10:00');
    addBooking(ANNA, TUE, '14:00', 90, 15, 'no_show');
    assert.ok(!times({ masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15 }).includes('14:00'));
  });

  it('перенос: переносимая запись не мешает сама себе', () => {
    const id = addBooking(ANNA, TUE, '10:00', 90, 15);
    assert.ok(!times({ masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15 }).includes('10:30'));
    assert.ok(times({ masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15, excludeBookingId: id }).includes('10:30'));
  });

  it('чужая действующая бронь занимает время, своя и истекшая — нет', () => {
    const now = new Date(at(TUE, '08:00'));
    addHold(OTHER_CLIENT, ANNA, TUE, '10:00', 90, 15, new Date(now.getTime() + 5 * 60_000));
    const base = { masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15, now };
    assert.ok(!times({ ...base, viewerId: CLIENT }).includes('10:00'), 'чужая бронь');
    assert.ok(times({ ...base, viewerId: OTHER_CLIENT }).includes('10:00'), 'своя бронь');
    assert.ok(times({ ...base, viewerId: CLIENT, now: new Date(now.getTime() + 10 * 60_000) }).includes('10:00'), 'бронь истекла');
  });
});

describe('визит из нескольких услуг', () => {
  it('длительность — сумма услуг, уборка — наибольшая; дизайн добавляет 30 минут', () => {
    assert.deepEqual(getVisitTiming(db, [MANICURE_PLAIN, PEDICURE]), { durationMin: 135, cleanupMin: 15 });
    assert.deepEqual(getVisitTiming(db, [EXTENSION, DESIGN]), { durationMin: 180, cleanupMin: 15 });
    assert.throws(() => getVisitTiming(db, [999]), /не найдены/);
  });

  it('сценарий 10: визит 2 ч 15 мин в конце дня — последний слот 15:30', () => {
    const slots = times({ masterId: ANNA, date: TUE, ...getVisitTiming(db, [MANICURE_PLAIN, PEDICURE]) });
    assert.equal(slots.at(-1), '15:30', '15:30 + 135 мин = 17:45; 16:00 + 135 = 18:15 — за сменой');
  });

  it('сценарий 2: наращивание с дизайном делает только Анна', () => {
    assert.deepEqual(findMastersForServices(db, [EXTENSION, DESIGN]), [ANNA]);
    assert.deepEqual(findMastersForServices(db, [MANICURE]), [ANNA, ELENA]);
  });
});

describe('ограничения клиента (шаг 6)', () => {
  it('клиенту — не раньше чем через 2 часа, администратору — любое время', () => {
    const now = new Date(at(TUE, '10:10'));
    const q = { masterId: ANNA, date: TUE, durationMin: 90, cleanupMin: 15, now };
    assert.equal(times({ ...q, audience: 'client' })[0], '12:30', '10:10 + 2 часа = 12:10');
    assert.equal(times({ ...q, audience: 'admin' })[0], '10:00');
  });

  it('горизонт 90 дней, считая сегодняшний', () => {
    const now = new Date(at(TUE, '09:00'));
    const q = { masterId: ANNA, durationMin: 90, cleanupMin: 15, now, audience: 'client' as const };
    // 22.09 + 89 дней = 20.12 (воскресенье), поэтому берем ближайшие рабочие дни Анны вокруг границы.
    assert.ok(times({ ...q, date: '2026-12-19' }).length > 0, 'суббота 19.12 — внутри горизонта');
    assert.deepEqual(times({ ...q, date: '2026-12-23' }), [], 'среда 23.12 — за горизонтом');
    assert.ok(times({ ...q, date: '2026-12-23', audience: 'admin' }).length > 0, 'администратору можно');
  });
});

describe('«Любой свободный мастер»', () => {
  it('слоты мастеров объединяются, у слота — список свободных мастеров', () => {
    addBooking(ELENA, THU, '10:00', 90, 15);
    const slots = getSlotsAnyMaster(db, { serviceIds: [MANICURE], date: THU, now: EARLY, audience: 'admin' });
    const byTime = new Map(slots.map((s) => [s.time, s.masterIds]));
    assert.deepEqual(byTime.get('10:00'), [ANNA], 'Елена занята');
    assert.deepEqual(byTime.get('14:00'), [ANNA, ELENA]);
    assert.deepEqual(byTime.get('13:00'), [ELENA], 'у Анны обед');
    assert.deepEqual(byTime.get('17:30'), [ELENA], 'Анна заканчивает в 18:00');
    assert.ok(slots.every((s, i) => i === 0 || slots[i - 1]!.startsAt < s.startsAt), 'по возрастанию времени');
  });
});
