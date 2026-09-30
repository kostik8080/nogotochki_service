// Уведомления клиента в кабинете (миграция 007, api/notifications.ts, notify/notifications.ts):
//   * создаются только от действий администратора с чужой записью — три события и никаких других;
//   * свои действия клиент не получает: записался, перенес или отменил сам — уведомления нет;
//   * в тексте конкретные дата и время визита, а не «ваша запись изменена»;
//   * список отдается вместе со счетчиком непрочитанных, отдельного запроса ради числа нет;
//   * уведомление ссылается на запись и чужое читать нельзя.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Client, nextWeekday, PASSWORDS, startApi, type TestApi, TZ } from './helpers/api.js';

let api: TestApi;
let admin: Client;
let client: Client;
let maria = 0;

const ANNA = 1;
const MANICURE = 1;

before(async () => {
  api = await startApi();
  admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
  client = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
  maria = (await client.get('/api/auth/me')).body.user.id;
});
after(() => api.close());

/** Уведомления Марии: список и счетчик приходят одним ответом. */
async function inbox(): Promise<{ unreadCount: number; notifications: any[] }> {
  const res = await client.get('/api/notifications');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

/** Свободное время Анны на дату: тестовые данные заняты сценарными записями, поэтому время берется из слотов. */
async function freeSlots(date: string): Promise<string[]> {
  const res = await admin.get(`/api/masters/${ANNA}/slots?date=${date}&services=${MANICURE}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
}

/** Запись Марии к Анне на четверг не раньше чем через minDays дней — у каждой проверки свой день. */
async function bookingFor(minDays: number) {
  const date = nextWeekday(4, minDays);
  const slots = await freeSlots(date);
  assert.ok(slots.length > 1, `на ${date} мало свободного времени`);
  const startsAt = slots[0]!;
  const res = await admin.post('/api/bookings', { masterId: ANNA, startsAt, services: [{ serviceId: MANICURE }], clientId: maria });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.booking.id as number, startsAt, date, version: res.body.booking.version as number, slots };
}

/** «14:00» — время визита в поясе студии, как его пишет уведомление. */
const hhmm = (instant: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));

describe('уведомление приходит только от действий администратора', () => {
  it('создание записи за клиента уведомления не создает — о визите клиент знает от студии', async () => {
    const before = (await inbox()).notifications.length;
    await bookingFor(21);
    assert.equal((await inbox()).notifications.length, before, 'новая запись — не событие для уведомления');
  });

  it('отмена администратором: текст с датой, временем и причиной, ссылка на запись', async () => {
    const booking = await bookingFor(28);
    await admin.post(`/api/bookings/${booking.id}/cancel`, { by: 'studio', reason: 'Заболел мастер', version: booking.version });

    const { notifications, unreadCount } = await inbox();
    const latest = notifications[0];
    assert.equal(latest.type, 'booking_cancelled');
    assert.equal(latest.bookingId, booking.id, 'по ссылке открывается эта запись');
    assert.equal(latest.isRead, false);
    assert.ok(unreadCount >= 1);
    // Конкретно, что отменено и когда: «Запись «Маникюр…» на четверг, 1 октября, 14:00 отменена студией. Причина: …»
    assert.match(latest.text, new RegExp(`^Запись «Маникюр с покрытием гель-лаком» на \\p{L}+, \\d{1,2} \\p{L}+, ${hhmm(booking.startsAt)} отменена студией\\.`, 'u'));
    assert.match(latest.text, /Причина: Заболел мастер\./u);
    assert.ok(!/изменена|обновлена/i.test(latest.text), 'без общих фраз');
  });

  it('перенос администратором: в тексте старое и новое время, при смене мастера — его имя', async () => {
    const booking = await bookingFor(35);
    const newStart = booking.slots.at(-1)!;
    await admin.post(`/api/bookings/${booking.id}/reschedule`, { startsAt: newStart, reason: null, version: booking.version });

    const latest = (await inbox()).notifications[0];
    assert.equal(latest.type, 'booking_rescheduled');
    assert.equal(latest.bookingId, booking.id);
    assert.match(latest.text, new RegExp(
      `на \\p{L}+, \\d{1,2} \\p{L}+, ${hhmm(booking.startsAt)} перенесена студией на \\p{L}+, \\d{1,2} \\p{L}+, ${hhmm(newStart)}\\.`, 'u'));

    // Перенос к другому мастеру: в тексте появляется, кто проведет визит
    const again = (await admin.get(`/api/bookings/${booking.id}`)).body.booking;
    const moved = await admin.post(`/api/bookings/${booking.id}/reschedule`, {
      startsAt: booking.slots[1]!, masterId: 3, reason: null, version: again.version,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.match((await inbox()).notifications[0].text, /Визит проведет .+\./u);
  });

  it('наложение: узнает тот, чье время заняли вторым визитом, а не тот, кого записали', async () => {
    const booking = await bookingFor(42);
    const beforeCount = (await inbox()).notifications.length;

    // Второй клиент на то же время — осознанное наложение администратора
    const olga = (await admin.get('/api/admin/clients?search=%D0%9E%D0%BB%D1%8C%D0%B3%D0%B0')).body.clients[0];
    const overbooked = await admin.post('/api/bookings', {
      masterId: ANNA, startsAt: booking.startsAt, services: [{ serviceId: MANICURE }], clientId: olga.id, isOverbooking: true,
    });
    assert.equal(overbooked.status, 201, JSON.stringify(overbooked.body));

    const { notifications } = await inbox();
    assert.equal(notifications.length, beforeCount + 1, 'Марию предупредили: ее время теперь делят');
    assert.equal(notifications[0].type, 'booking_overbooked');
    assert.equal(notifications[0].bookingId, booking.id, 'ссылка — на запись Марии, а не на чужую');
    assert.match(notifications[0].text, /студия назначила еще один визит: мастер .+ примет двух клиентов\. Ваша запись сохранена/u);
  });
});

describe('свои действия клиента уведомлений не создают', () => {
  it('клиент сам отменил и сам перенес — в кабинете ничего не появилось', async () => {
    // Запись создает сам клиент: бронь, затем запись
    const date = nextWeekday(4, 49);
    const slots = await freeSlots(date);
    const startsAt = slots[0]!;
    const hold = await client.post('/api/holds', { masterId: ANNA, startsAt, services: [{ serviceId: MANICURE }] });
    assert.equal(hold.status, 201, JSON.stringify(hold.body));
    const created = await client.post('/api/bookings', {
      masterId: ANNA, startsAt, services: [{ serviceId: MANICURE }], comment: null, isAnyMaster: false,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const before = (await inbox()).notifications.length;

    // Перенос клиентом: бронь на перенос, затем перенос
    const newStart = slots.at(-1)!;
    await client.post('/api/holds', { bookingId: created.body.booking.id, startsAt: newStart });
    const moved = await client.post(`/api/bookings/${created.body.booking.id}/reschedule`, {
      startsAt: newStart, reason: null, version: created.body.booking.version,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    // Отмена клиентом
    const cancelled = await client.post(`/api/bookings/${created.body.booking.id}/cancel`, {
      reason: 'Изменились планы', version: moved.body.booking.version,
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    assert.equal((await inbox()).notifications.length, before, 'о своих действиях клиент не уведомляется');
  });
});

describe('список, счетчик и права', () => {
  it('счетчик непрочитанных приходит вместе со списком и уменьшается после «прочитано»', async () => {
    const start = await inbox();
    assert.ok(start.unreadCount > 0, 'есть непрочитанные от проверок выше');
    assert.equal(start.unreadCount, start.notifications.filter((n) => !n.isRead).length);

    const read = await client.post(`/api/notifications/${start.notifications[0].id}/read`);
    assert.equal(read.status, 200);
    assert.equal(read.body.unreadCount, start.unreadCount - 1, 'счетчик возвращается сразу, отдельный запрос не нужен');

    const after = await inbox();
    assert.equal(after.unreadCount, start.unreadCount - 1);
    assert.equal(after.notifications.find((n) => n.id === start.notifications[0].id).isRead, true);

    // Повторное «прочитано» ничего не ломает и счетчик не трогает
    assert.equal((await client.post(`/api/notifications/${start.notifications[0].id}/read`)).body.unreadCount, after.unreadCount);
  });

  it('только непрочитанные — ?unread=true; новые сверху', async () => {
    const all = await inbox();
    const unread = (await client.get('/api/notifications?unread=true')).body.notifications as any[];
    assert.ok(unread.every((n) => !n.isRead));
    assert.equal(unread.length, all.unreadCount);
    const times = all.notifications.map((n) => n.createdAt);
    assert.deepEqual(times, [...times].sort().reverse(), 'новые сверху');
  });

  it('чужие уведомления не видны и не читаются; гостю и администратору раздел недоступен', async () => {
    const mine = (await inbox()).notifications[0].id;
    const other = await api.client().login('olga@example.test', PASSWORDS.clientPassword).catch(() => null);
    assert.equal(other, null, 'у Ольги нет учетной записи — проверяем на администраторе и госте');

    assert.equal((await admin.get('/api/notifications')).status, 403, 'уведомления есть только у клиента');
    assert.equal((await api.client().get('/api/notifications')).status, 401);
    assert.equal((await admin.post(`/api/notifications/${mine}/read`)).status, 403);
    assert.equal((await client.post('/api/notifications/999999/read')).status, 404);
  });
});
