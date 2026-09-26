// Тесты API через настоящий HTTP: база в памяти со всеми миграциями и тестовыми данными (dev-seed),
// сервер на свободном порту. Даты считаются от сегодняшнего дня, как и тестовые данные.
// Тесты идут по порядку и продолжают друг друга: запись, созданная в одном, переносится в следующем.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { cleanupExpired } from '../src/booking/cleanup.js';
import type { Db } from '../src/db/connection.js';
import { zonedTime } from '../src/lib/studio-time.js';
import { at, type Client, nextWeekday, PASSWORDS, startApi, type TestApi, today, TZ } from './helpers/api.js';

const ANNA = 1;
const MARINA = 2;
const MANICURE = 1;
const DESIGN = 3;
const EXTENSION = 8;
const LAMINATION = 12;

let api: TestApi;
let db: Db;
const localTimes = (slots: { startsAt: string }[]) => slots.map((s) => zonedTime(Date.parse(s.startsAt), TZ));

// Четверг и среда через полторы недели: там нет сценарных записей из тестовых данных.
const THU = nextWeekday(4, 9);
const WED = nextWeekday(3, 9);

let anon: Client;
let maria: Client;
let ivan: Client;
let admin: Client;
/** Новый клиент API — как отдельный браузер без входа. */
const fresh = () => api.client();

before(async () => {
  api = await startApi();
  db = api.db;
  [anon, maria, ivan, admin] = [fresh(), fresh(), fresh(), fresh()];
  await maria.login('maria@example.com', PASSWORDS.clientPassword);
  await admin.login('admin@example.com', PASSWORDS.adminPassword);
});

after(() => api.close());

describe('регистрация, вход и выход', () => {
  it('регистрирует клиента и сразу открывает сессию; хеш пароля не возвращается', async () => {
    const res = await ivan.post('/api/auth/register', {
      name: 'Иван Петров', phone: '8 (916) 555-12-34', email: 'Ivan@Example.com', password: 'ivan-password-1', pdConsent: true,
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.user, {
      id: res.body.user.id, role: 'client', name: 'Иван Петров', phone: '+79165551234', email: 'ivan@example.com',
      phoneVerified: false, emailVerified: false, marketingConsent: false,
    });
    assert.ok(ivan.cookie);
    const row = db.prepare('SELECT password_hash, pd_consent_version FROM users WHERE id = ?').get(res.body.user.id) as { password_hash: string; pd_consent_version: string };
    assert.match(row.password_hash, /^\$argon2id\$/);
    assert.equal(row.pd_consent_version, '2026-09-01');
    assert.equal((await ivan.get('/api/auth/me')).body.user.email, 'ivan@example.com');
  });

  it('отклоняет занятый e-mail и телефон зарегистрированного клиента — 409', async () => {
    const email = await anon.post('/api/auth/register', { name: 'Иван', email: 'ivan@example.com', password: 'password-123', pdConsent: true });
    assert.equal(email.status, 409);
    assert.equal(email.body.error.code, 'EMAIL_TAKEN');
    const phone = await anon.post('/api/auth/register', { name: 'Мария', phone: '+79112223344', password: 'password-123', pdConsent: true });
    assert.equal(phone.status, 409);
    assert.equal(phone.body.error.code, 'PHONE_TAKEN');
  });

  it('проверяет данные до обращения к базе — 400 со списком всех ошибок', async () => {
    const res = await anon.post('/api/auth/register', { name: ' ', email: 'not-an-email', password: 'short', pdConsent: false, extra: 1 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(res.body.error.details.fields.map((f: { field: string }) => f.field).sort(), ['email', 'extra', 'name', 'password', 'pdConsent']);
    assert.equal((await anon.post('/api/auth/login', '{"login":')).status, 400);
    assert.equal((await anon.request('POST', '/api/auth/login', 'login=a', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  });

  it('неверный пароль — 401, после пяти подряд вход временно закрыт — 429', async () => {
    const victim = fresh();
    await victim.post('/api/auth/register', { name: 'Жертва', email: 'victim@example.com', password: 'right-password', pdConsent: true });
    for (let i = 0; i < 5; i++) {
      const res = await anon.post('/api/auth/login', { login: 'victim@example.com', password: 'wrong-password' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    }
    const locked = await anon.post('/api/auth/login', { login: 'victim@example.com', password: 'right-password' });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
  });

  it('пробелы по краям пароля — часть пароля и при регистрации, и при входе', async () => {
    const password = '  spaced password  ';
    assert.equal((await fresh().post('/api/auth/register', { name: 'Пробел', email: 'space@example.com', password, pdConsent: true })).status, 201);
    assert.equal((await fresh().post('/api/auth/login', { login: 'space@example.com', password })).status, 200);
    assert.equal((await anon.post('/api/auth/login', { login: 'space@example.com', password: password.trim() })).status, 401);
  });

  it('в режиме технических работ клиент не создаст бронь — 503 с телефоном студии', async () => {
    db.prepare('UPDATE settings SET is_maintenance = 1').run();
    try {
      const res = await maria.post('/api/holds', { masterId: MARINA, startsAt: at(WED, '12:00'), services: [{ serviceId: LAMINATION }] });
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'MAINTENANCE');
    } finally {
      db.prepare('UPDATE settings SET is_maintenance = 0').run();
    }
  });

  it('выход закрывает сессию: дальше — 401', async () => {
    const temp = fresh();
    await temp.login('+7 911 222-33-44', PASSWORDS.clientPassword); // Мария по телефону
    const cookie = temp.cookie;
    assert.equal((await temp.post('/api/auth/logout')).status, 204);
    assert.equal(temp.cookie, null);
    temp.cookie = cookie; // старая cookie больше не действует
    const me = await temp.get('/api/auth/me');
    assert.equal(me.status, 401);
    assert.equal(me.body.error.code, 'UNAUTHORIZED');
  });
});

describe('услуги, мастера и свободное время', () => {
  it('каталог отдает цены в копейках', async () => {
    const res = await anon.get('/api/services');
    assert.equal(res.status, 200);
    const manicure = res.body.categories.flatMap((c: { services: unknown[] }) => c.services).find((s: { id: number }) => s.id === MANICURE);
    assert.equal(manicure.priceMasterKop, 180_000);
    assert.equal(manicure.priceTopKop, 220_000);
    assert.deepEqual(res.body.incompatibilities[0].serviceIds, [MANICURE, EXTENSION]);
  });

  it('сценарий 2: наращивание с дизайном делает только Анна, 3400 ₽ и 180 минут', async () => {
    const res = await anon.get(`/api/masters?services=${EXTENSION},${DESIGN}:2`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.masters.map((m: { id: number }) => m.id), [ANNA]);
    assert.deepEqual(res.body.masters[0].visit, { durationMin: 180, priceKop: 340_000 });
  });

  it('сценарий 10: несовместимые услуги — 400 с объяснением', async () => {
    const res = await anon.get(`/api/masters?services=${MANICURE},${EXTENSION}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'SERVICES_INCOMPATIBLE');
    assert.match(res.body.error.message, /одних и тех же ногтях/);
  });

  it('сценарий 1: у Анны в четверг нет слотов на обеде и позже 16:30; время — в UTC', async () => {
    const res = await anon.get(`/api/masters/${ANNA}/slots?date=${THU}&services=${MANICURE}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.timezone, TZ);
    assert.equal(res.body.priceKop, 180_000);
    assert.deepEqual(localTimes(res.body.slots),
      ['10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30']);
    assert.match(res.body.slots[0].startsAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
  });

  it('«Любой свободный мастер»: в каждом слоте — свободные мастера', async () => {
    const res = await anon.get(`/api/slots?date=${THU}&services=${MANICURE}`);
    assert.equal(res.status, 200);
    const ten = res.body.slots.find((s: { startsAt: string }) => s.startsAt === at(THU, '10:00'));
    assert.ok(ten.masterIds.includes(ANNA));
    assert.ok(res.body.masters.some((m: { id: number; priceKop: number }) => m.id === ANNA && m.priceKop === 180_000));
  });

  it('неверная дата и неизвестный мастер — 400 и 404', async () => {
    assert.equal((await anon.get(`/api/masters/${ANNA}/slots?date=2026-02-30&services=1`)).status, 400);
    assert.equal((await anon.get(`/api/masters/999/slots?date=${THU}&services=1`)).status, 404);
  });
});

describe('бронь, запись, перенос и отмена', () => {
  let bookingId: number;
  const noon = at(WED, '12:00');

  it('бронь нужна после входа — 401', async () => {
    const res = await anon.post('/api/holds', { masterId: MARINA, startsAt: noon, services: [{ serviceId: LAMINATION }] });
    assert.equal(res.status, 401);
  });

  it('время принимается только в UTC — смещение пояса отклоняется', async () => {
    const res = await maria.post('/api/holds', { masterId: MARINA, startsAt: `${WED}T12:00:00+03:00`, services: [{ serviceId: LAMINATION }] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details.fields[0].field, 'startsAt');
  });

  it('сценарий 4: бронь закрепляет время на 10 минут, второй клиент получает 409 и другие слоты', async () => {
    const hold = await maria.post('/api/holds', { masterId: MARINA, startsAt: noon, services: [{ serviceId: LAMINATION }] });
    assert.equal(hold.status, 201, JSON.stringify(hold.body));
    assert.equal(hold.body.hold.priceKop, 180_000);
    assert.ok(hold.body.hold.secondsLeft > 590 && hold.body.hold.secondsLeft <= 600);

    const slots = await ivan.get(`/api/masters/${MARINA}/slots?date=${WED}&services=${LAMINATION}`);
    assert.ok(!slots.body.slots.some((s: { startsAt: string }) => s.startsAt === noon));

    const second = await ivan.post('/api/holds', { masterId: MARINA, startsAt: noon, services: [{ serviceId: LAMINATION }] });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'SLOT_TAKEN');
    assert.ok(second.body.error.details.alternatives.length > 0);
  });

  it('без брони клиент запись не создаст — 409', async () => {
    const res = await ivan.post('/api/bookings', { masterId: MARINA, startsAt: at(WED, '16:00'), services: [{ serviceId: LAMINATION }] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'HOLD_NOT_FOUND');
  });

  it('запись создается на удержанное время, цена фиксируется в копейках, бронь снимается', async () => {
    const res = await maria.post('/api/bookings', {
      masterId: MARINA, startsAt: noon, services: [{ serviceId: LAMINATION }], comment: 'Хочу естественную форму',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const b = res.body.booking;
    bookingId = b.id;
    assert.equal(b.status, 'active');
    assert.equal(b.startsAt, noon);
    assert.equal(b.endsAt, at(WED, '13:00'));
    assert.equal(b.totalPriceKop, 180_000);
    assert.deepEqual(b.items, [{ serviceId: LAMINATION, name: 'Ламинирование бровей', quantity: 1, unitPriceKop: 180_000, priceKop: 180_000, durationMin: 60 }]);
    // Клиент не видит служебных полей и контактов: только администратор.
    assert.equal(b.client, undefined);
    assert.equal(b.busyUntil, undefined);
    assert.equal((await maria.get('/api/holds/current')).body.hold, null);
  });

  it('свои записи видны, чужие — 403, без входа — 401', async () => {
    const mine = await maria.get('/api/bookings?period=upcoming');
    assert.ok(mine.body.bookings.some((b: { id: number }) => b.id === bookingId));
    assert.equal((await ivan.get(`/api/bookings/${bookingId}`)).status, 403);
    assert.equal((await anon.get(`/api/bookings/${bookingId}`)).status, 401);
    assert.ok(!(await ivan.get('/api/bookings')).body.bookings.some((b: { id: number }) => b.id === bookingId));
  });

  it('сценарий 5: перенос меняет время той же записи и освобождает прежний слот', async () => {
    const countBookings = () => (db.prepare('SELECT count(*) AS n FROM bookings').get() as { n: number }).n;
    const before = countBookings();
    const newStart = at(WED, '17:00');
    const hold = await maria.post('/api/holds', { bookingId, startsAt: newStart });
    assert.equal(hold.status, 201, JSON.stringify(hold.body));
    assert.equal(hold.body.hold.bookingId, bookingId);

    const res = await maria.post(`/api/bookings/${bookingId}/reschedule`, { startsAt: newStart, reason: 'Не успеваю' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.booking.id, bookingId);
    assert.equal(res.body.booking.startsAt, newStart);
    assert.equal(res.body.booking.version, 2);
    assert.equal(countBookings(), before); // новая запись не создана

    const slots = await ivan.get(`/api/masters/${MARINA}/slots?date=${WED}&services=${LAMINATION}`);
    assert.ok(slots.body.slots.some((s: { startsAt: string }) => s.startsAt === noon));
  });

  it('отмена клиентом с причиной; время освобождается, повторная отмена — 409', async () => {
    const res = await maria.post(`/api/bookings/${bookingId}/cancel`, { reason: 'Изменились планы' });
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.status, 'cancelled_by_client');
    assert.equal(res.body.booking.cancellation.reason, 'Изменились планы');
    assert.equal(res.body.booking.cancellation.by, 'client');
    const again = await maria.post(`/api/bookings/${bookingId}/cancel`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'BOOKING_NOT_ACTIVE');
  });

  it('сценарий 12: истекшая бронь не дает записаться, уборка удаляет ее', async () => {
    const start = at(WED, '14:00');
    const hold = await ivan.post('/api/holds', { masterId: MARINA, startsAt: start, services: [{ serviceId: LAMINATION }] });
    assert.equal(hold.status, 201);
    const past = new Date(Date.now() - 60_000);
    db.prepare('UPDATE slot_holds SET created_at = ?, expires_at = ? WHERE id = ?')
      .run(new Date(past.getTime() - 600_000).toISOString(), past.toISOString(), hold.body.hold.id);

    const res = await ivan.post('/api/bookings', { masterId: MARINA, startsAt: start, services: [{ serviceId: LAMINATION }] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'HOLD_EXPIRED');
    assert.equal((await ivan.get('/api/holds/current')).body.hold, null);
    assert.equal(cleanupExpired(db, new Date()).holds, 1);
  });

  it('сценарий 6: позднее чем за сутки клиент не отменит — 403, администратор отменит от имени студии', async () => {
    // Запись через 5 часов вставляется напрямую: через API клиент так близко не запишется (2 часа — минимум, а слоты зависят от дня недели).
    const mariaId = (db.prepare("SELECT id FROM users WHERE email = 'maria@example.com'").get() as { id: number }).id;
    const start = new Date(Math.ceil((Date.now() + 5 * 3600_000) / 3600_000) * 3600_000);
    const end = new Date(start.getTime() + 20 * 60_000);
    const id = Number(db.prepare(`
      INSERT INTO bookings (client_id, master_id, starts_at, ends_at, busy_until, price_level, created_by)
      VALUES (?, ?, ?, ?, ?, 'master', ?)
    `).run(mariaId, MARINA, start.toISOString(), end.toISOString(), end.toISOString(), mariaId).lastInsertRowid);

    const res = await maria.post(`/api/bookings/${id}/cancel`, { reason: 'Заболела' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CHANGE_DEADLINE_PASSED');
    assert.match(res.body.error.message, /\+7/);

    const byAdmin = await admin.post(`/api/bookings/${id}/cancel`, { reason: 'Клиентка заболела, позвонила в студию' });
    assert.equal(byAdmin.status, 200);
    assert.equal(byAdmin.body.booking.status, 'cancelled_by_studio');
  });
});

describe('раздел администратора', () => {
  it('клиенту — 403, без входа — 401', async () => {
    assert.equal((await maria.get('/api/admin/bookings')).status, 403);
    assert.equal((await anon.get('/api/admin/bookings')).status, 401);
    assert.equal((await maria.post('/api/admin/services', {})).status, 403);
  });

  it('все записи с фильтрами; администратор видит контакты клиента', async () => {
    const res = await admin.get(`/api/admin/bookings?masterId=${ANNA}&status=active`);
    assert.equal(res.status, 200);
    assert.ok(res.body.total > 0);
    assert.ok(res.body.bookings.every((b: { master: { id: number }; status: string }) => b.master.id === ANNA && b.status === 'active'));
    assert.ok(res.body.bookings.some((b: { client: { phone: string } }) => b.client.phone === '+79035556677'));
    const bad = await admin.get('/api/admin/bookings?dateFrom=2026-10-10&dateTo=2026-10-01');
    assert.equal(bad.status, 400);
  });

  it('запись за нового клиента по телефону без брони (A-02) и конфликт версий (A-S1)', async () => {
    const start = at(THU, '14:00');
    const res = await admin.post('/api/bookings', {
      masterId: ANNA, startsAt: start, services: [{ serviceId: MANICURE }], newClient: { name: 'Светлана', phone: '+79260001122' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.booking.client.name, 'Светлана');
    const id = res.body.booking.id;

    const moved = await admin.post(`/api/bookings/${id}/reschedule`, { startsAt: at(THU, '15:00'), version: 1 });
    assert.equal(moved.status, 200);
    const stale = await admin.post(`/api/bookings/${id}/reschedule`, { startsAt: at(THU, '16:00'), version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.equal(moved.body.booking.events[0].type, 'rescheduled');
  });

  it('услуги: создание с ценами в копейках, проверки и отключение', async () => {
    const created = await admin.post('/api/admin/services', {
      categoryId: 4, kind: 'main', name: 'Архитектура бровей', durationMin: 45, cleanupMin: 10,
      priceMasterKop: 150_050, priceTopKop: 190_000, masterIds: [MARINA],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.service.priceMasterKop, 150_050);
    const id = created.body.service.id;

    const wrongPrice = await admin.post('/api/admin/services', {
      categoryId: 4, kind: 'main', name: 'Другая услуга', durationMin: 45, priceMasterKop: 200_000, priceTopKop: 100_000,
    });
    assert.equal(wrongPrice.status, 400);
    const duplicate = await admin.post('/api/admin/services', {
      categoryId: 4, kind: 'main', name: 'архитектура бровей', durationMin: 45, priceMasterKop: 1, priceTopKop: 1,
    });
    assert.equal(duplicate.status, 409); // регистр кириллицы тоже не важен
    assert.equal(duplicate.body.error.code, 'SERVICE_NAME_TAKEN');

    assert.equal((await admin.patch(`/api/admin/services/${id}`, { isActive: false })).status, 200);
    const catalog = await anon.get('/api/services');
    assert.ok(!catalog.body.categories.flatMap((c: { services: { id: number }[] }) => c.services).some((s: { id: number }) => s.id === id));
  });

  it('мастера: новый мастер с графиком и услугами появляется в выдаче слотов', async () => {
    const created = await admin.post('/api/admin/masters', {
      name: 'Ольга Новикова', level: 'top_master', serviceIds: [LAMINATION],
      schedule: { validFrom: today, days: [{ weekday: 3, start: '10:00', end: '16:00' }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.master.id;
    const slots = await anon.get(`/api/masters/${id}/slots?date=${WED}&services=${LAMINATION}`);
    assert.equal(slots.body.priceKop, 210_000); // цена топ-мастера
    assert.equal(localTimes(slots.body.slots)[0], '10:00');
  });

  it('сценарий 14: новый график с даты показывает записи, которые в него не попадают', async () => {
    // У Анны есть запись в четверг (создана выше). С этого четверга она работает только по средам.
    const res = await admin.put(`/api/admin/masters/${ANNA}/schedule`, {
      validFrom: THU, days: [{ weekday: 3, start: '10:00', end: '18:00' }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.affectedBookings.length > 0);
    assert.ok(res.body.affectedBookings.every((b: { startsAt: string }) => b.startsAt >= at(THU, '00:00')));
    const slots = await anon.get(`/api/masters/${ANNA}/slots?date=${THU}&services=${MANICURE}`);
    assert.equal(slots.body.day.status, 'master_off');
    assert.deepEqual(slots.body.slots, []);
  });
});
