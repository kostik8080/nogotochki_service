// Страница «Записи» администратора (A-01): список записей на день с фильтрами и действия с чужой записью
// глазами клиента. Правила отмены, переноса, блокировок и наложения проверяют api.test.ts, api-extended.test.ts
// и overlap.test.ts — здесь только то, что видит администратор в списке дня и клиент в своем кабинете.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { at, type Client, nextWeekday, PASSWORDS, startApi, type TestApi, TZ } from './helpers/api.js';

let api: TestApi;
let admin: Client;
let client: Client;

/** Мария Кузнецова из тестовых данных: ее записями проверяется вид кабинета. Номер — из базы, а не из порядка вставки. */
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

/**
 * Запись Марии к Анне на четверг не раньше чем через minDays дней. У каждой проверки свой четверг:
 * маникюр занимает 90 минут и еще 15 минут уборки, и на одном дне записи накладывались бы друг на друга.
 */
async function newBooking(minDays: number, time = '11:00'): Promise<{ id: number; startsAt: string; version: number }> {
  const date = nextWeekday(4, minDays);
  const startsAt = at(date, time);
  const res = await admin.post('/api/bookings', {
    masterId: ANNA, startsAt, services: [{ serviceId: MANICURE }], clientId: maria,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.booking.id, startsAt, version: res.body.booking.version };
}

const dayOf = (isoUtc: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(isoUtc));

describe('список записей на день', () => {
  it('фильтры по дате, мастеру и статусу; в ответе часовой пояс студии', async () => {
    const booking = await newBooking(21);
    const date = dayOf(booking.startsAt);

    const day = await admin.get(`/api/admin/bookings?dateFrom=${date}&dateTo=${date}&limit=500`);
    assert.equal(day.status, 200);
    assert.equal(day.body.timezone, TZ, 'интерфейс переводит время в пояс студии сам');
    const ids = (day.body.bookings as { id: number }[]).map((b) => b.id);
    assert.ok(ids.includes(booking.id));

    // Фильтр по мастеру — тот же список без чужих записей
    const byMaster = await admin.get(`/api/admin/bookings?dateFrom=${date}&dateTo=${date}&masterId=${ANNA}`);
    assert.ok((byMaster.body.bookings as { master: { id: number } }[]).every((b) => b.master.id === ANNA));
    assert.ok((byMaster.body.bookings as { id: number }[]).some((b) => b.id === booking.id));

    // Другой мастер — этой записи нет
    const other = await admin.get(`/api/admin/bookings?dateFrom=${date}&dateTo=${date}&masterId=2`);
    assert.ok(!(other.body.bookings as { id: number }[]).some((b) => b.id === booking.id));

    // В списке дня администратор видит контакты клиента и время уборки — они нужны строке списка
    const row = (day.body.bookings as any[]).find((b) => b.id === booking.id);
    assert.equal(typeof row.client.phone, 'string');
    assert.ok(row.busyUntil >= row.endsAt);
    assert.equal(row.isOverbooking, false);
  });
});

describe('что видит клиент после действий администратора', () => {
  it('отмена: строка остается со статусом и причиной, время свободно, у клиента запись видна отмененной', async () => {
    const booking = await newBooking(28);
    const date = dayOf(booking.startsAt);

    const cancelled = await admin.post(`/api/bookings/${booking.id}/cancel`, {
      by: 'studio', reason: 'Заболел мастер', version: booking.version,
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    // В списке дня строка осталась — с пометкой отмены и причиной
    const day = await admin.get(`/api/admin/bookings?dateFrom=${date}&dateTo=${date}&limit=500`);
    const row = (day.body.bookings as any[]).find((b) => b.id === booking.id);
    assert.equal(row.status, 'cancelled_by_studio');
    assert.equal(row.cancellation.by, 'studio');
    assert.equal(row.cancellation.reason, 'Заболел мастер');

    // Время освободилось: тот же слот снова предлагается клиенту
    const slots = await client.get(`/api/masters/${ANNA}/slots?date=${date}&services=${MANICURE}`);
    assert.ok((slots.body.slots as { startsAt: string }[]).some((s) => s.startsAt === booking.startsAt),
      'после отмены время снова свободно');

    // В кабинете клиента запись не исчезла: она в списке со статусом отмены и сообщением студии
    const mine = (await client.get('/api/bookings')).body.bookings as any[];
    const own = mine.find((b) => b.id === booking.id);
    assert.ok(own, 'отмененная запись осталась в кабинете клиента');
    assert.equal(own.status, 'cancelled_by_studio');
    assert.equal(own.cancellation.reason, 'Заболел мастер');
    assert.equal(own.studioChange.type, 'cancelled', 'клиент увидит сообщение «студия отменила запись»');
    // Отмененной записи нет среди предстоящих, но она есть в истории
    assert.ok(!(await client.get('/api/bookings?period=upcoming')).body.bookings.some((b: { id: number }) => b.id === booking.id));
    assert.ok((await client.get('/api/bookings?period=past')).body.bookings.some((b: { id: number }) => b.id === booking.id));
  });

  it('отмена «по просьбе клиента»: статус «Отменена клиентом», но сообщение в кабинете — от студии', async () => {
    const booking = await newBooking(49);
    const res = await admin.post(`/api/bookings/${booking.id}/cancel`, { by: 'client', reason: 'Позвонила, просит отменить', version: booking.version });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const own = ((await client.get('/api/bookings')).body.bookings as any[]).find((b) => b.id === booking.id);
    assert.equal(own.status, 'cancelled_by_client', 'в истории — отмена клиентом');
    // Баннер ставится по актору события, а отменял администратор: клиент прочтет «Студия отменила запись».
    // Так и задумано — отмену внес сотрудник, — но текст в кабинете один на оба случая.
    assert.equal(own.studioChange.type, 'cancelled');
  });

  it('перенос: та же запись с новым временем, вторая не появляется, у клиента одно сообщение', async () => {
    const booking = await newBooking(35);
    const newStart = at(dayOf(booking.startsAt), '15:00');
    const before = (await client.get('/api/bookings')).body.bookings.length;

    const moved = await admin.post(`/api/bookings/${booking.id}/reschedule`, {
      startsAt: newStart, reason: 'Мастер просит сдвинуть', version: booking.version,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.booking.id, booking.id, 'запись та же');
    assert.equal(moved.body.booking.startsAt, newStart);
    assert.equal(moved.body.booking.status, 'active', 'перенос не отменяет запись');

    const mine = (await client.get('/api/bookings')).body.bookings as any[];
    assert.equal(mine.length, before, 'новая запись не создана');
    const own = mine.find((b) => b.id === booking.id);
    assert.equal(own.startsAt, newStart);
    // Одно сообщение студии, а не два («отменена» + «создана»): клиент видит один перенос
    assert.equal(own.studioChange.type, 'rescheduled');

    // Кто, откуда и куда перенес — в истории записи
    const events = (await admin.get(`/api/bookings/${booking.id}`)).body.booking.events as any[];
    const event = events.filter((e) => e.type === 'rescheduled').at(-1);
    assert.equal(event.oldStartsAt, booking.startsAt);
    assert.equal(event.newStartsAt, newStart);
    assert.equal(event.reason, 'Мастер просит сдвинуть');
    assert.equal(event.actor.role, 'admin');
  });

  it('наложение: только по подтверждению, у клиента запись обычная; будущий визит отметить нельзя', async () => {
    // Наложение: вторая запись на то же время того же мастера — только с подтверждением
    const booking = await newBooking(42);
    const second = {
      masterId: ANNA, startsAt: booking.startsAt, services: [{ serviceId: MANICURE }], clientId: maria,
    };
    const refused = await admin.post('/api/bookings', second);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'SLOT_TAKEN', 'без подтверждения проверка занятости срабатывает');

    const confirmed = await admin.post('/api/bookings', { ...second, isOverbooking: true });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.booking.isOverbooking, true);

    // Обе записи в списке дня стоят на одно время — администратор видит два визита
    const date = dayOf(booking.startsAt);
    const day = (await admin.get(`/api/admin/bookings?dateFrom=${date}&dateTo=${date}&limit=500`)).body.bookings as any[];
    const together = day.filter((b) => b.startsAt === booking.startsAt && b.status === 'active');
    assert.equal(together.length, 2);

    // Клиенту отметка наложения не видна, запись — обычная
    const own = ((await client.get('/api/bookings')).body.bookings as any[]).find((b) => b.id === confirmed.body.booking.id);
    assert.equal(own.isOverbooking, undefined);
    assert.equal(own.status, 'active');

    // Итог визита — только у начавшегося: поэтому кнопок «Визит завершен» и «Неявка» у будущей записи нет
    const early = await admin.post(`/api/bookings/${booking.id}/status`, { status: 'completed', version: 1 });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'VISIT_NOT_STARTED');
  });
});
