// Роль «Мастер»: учетную запись заводит администратор, мастер видит свое расписание только для чтения —
// рабочие дни, записи с именем клиента и полем «Важно», блокировки. Контактов клиентов и чужих записей не видит,
// менять записи не может.
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { at, nextWeekday, PASSWORDS, startApi, type TestApi } from './helpers/api.js';

let api: TestApi;
before(async () => {
  api = await startApi();
});
after(() => api.close());

it('администратор заводит учетную запись мастеру; мастер видит только свое расписание и ничего не меняет', async () => {
  const admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
  const date = nextWeekday(3, 9);
  // Запись к Марине, чтобы в ее расписании было что показать.
  const mariaId = (api.db.prepare("SELECT id FROM users WHERE email = 'maria@example.com'").get() as { id: number }).id;
  const booking = await admin.post('/api/bookings', { masterId: 2, startsAt: at(date, '12:00'), services: [{ serviceId: 12 }], clientId: mariaId, comment: 'Мягкий состав' });
  assert.equal(booking.status, 201);

  const account = await admin.post('/api/admin/masters/2/account', { email: 'marina@example.com', password: 'marina-pass-1' });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  assert.equal(account.body.master.account.email, 'marina@example.com');
  assert.equal((await admin.post('/api/admin/masters/2/account', { email: 'other@example.com', password: 'marina-pass-1' })).body.error.code, 'MASTER_HAS_ACCOUNT');

  const marina = await api.client().login('marina@example.com', 'marina-pass-1');
  const res = await marina.get(`/api/master/schedule?from=${date}&to=${date}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.master.name, 'Марина Орлова');
  const day = res.body.days[0];
  assert.equal(day.status, 'open');
  const b = day.bookings.find((x: { id: number }) => x.id === booking.body.booking.id);
  assert.equal(b.client.name, 'Мария Кузнецова');
  assert.equal(b.client.importantNote, 'Предпочитает короткую форму ногтей');
  assert.equal(b.comment, 'Мягкий состав');
  assert.deepEqual(b.services, [{ name: 'Ламинирование бровей', quantity: 1, durationMin: 60 }]);
  assert.doesNotMatch(JSON.stringify(res.body), /\+7911|maria@example\.com|price/i); // контактов и цен нет

  // Только чтение: записи мастер не создает и не меняет, раздел администратора и клиента закрыт.
  assert.equal((await marina.post(`/api/bookings/${b.id}/cancel`, {})).status, 403);
  assert.equal((await marina.get('/api/admin/bookings')).status, 403);
  assert.equal((await marina.get('/api/bookings')).status, 403);
  assert.equal((await marina.get(`/api/master/schedule?from=${date}&to=2027-12-31`)).status, 400); // больше месяца

  // Анна (учетная запись из тестовых данных) видит свое расписание, а не расписание Марины.
  const anna = await api.client().login('anna@example.com', PASSWORDS.masterPassword);
  const annaDay = (await anna.get(`/api/master/schedule?from=${date}&to=${date}`)).body;
  assert.equal(annaDay.master.name, 'Анна Ковалева');
  assert.ok(!annaDay.days[0].bookings.some((x: { id: number }) => x.id === b.id));

  // Клиенту и гостю раздел мастера закрыт.
  const client = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
  assert.equal((await client.get('/api/master/schedule')).status, 403);
  assert.equal((await api.client().get('/api/master/schedule')).status, 401);

  // Карточка записи: три проверки — вход, роль, владение объектом.
  // Мастер открывает запись своего расписания: состав, комментарий, имя клиента и «Важно».
  const card = await marina.get(`/api/bookings/${b.id}`);
  assert.equal(card.status, 200, JSON.stringify(card.body));
  assert.equal(card.body.booking.client.name, 'Мария Кузнецова');
  assert.equal(card.body.booking.client.importantNote, 'Предпочитает короткую форму ногтей');
  assert.equal(card.body.booking.comment, 'Мягкий состав');
  assert.equal(card.body.booking.isOverbooking, false);
  // Ни цен, ни контактов, ни истории изменений мастеру не видно.
  assert.equal(card.body.booking.totalPriceKop, undefined);
  assert.equal(card.body.booking.priceLevel, undefined);
  assert.equal(card.body.booking.items[0].priceKop, undefined);
  assert.equal(card.body.booking.client.phone, undefined);
  assert.equal(card.body.booking.events, undefined);
  assert.doesNotMatch(JSON.stringify(card.body), /\+7911|maria@example\.com|PriceKop/);

  // Чужая запись из расписания другого мастера мастеру не видна, хотя роль подходит.
  const annaBooking = (api.db.prepare("SELECT id FROM bookings WHERE master_id = 1 AND status = 'active' ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined);
  assert.ok(annaBooking, 'в тестовых данных нет активной записи к Анне');
  const foreign = await marina.get(`/api/bookings/${annaBooking.id}`);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error.message, 'Эта запись не из вашего расписания');

  // Та же запись: администратору видна целиком, клиентке — как своя, гостю — 401.
  assert.equal((await admin.get(`/api/bookings/${b.id}`)).body.booking.client.phone, '+79112223344');
  assert.ok((await client.get(`/api/bookings/${b.id}`)).body.booking.totalPriceKop > 0);
  assert.equal((await api.client().get(`/api/bookings/${b.id}`)).status, 401);
});
