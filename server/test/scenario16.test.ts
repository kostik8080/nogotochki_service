// Сценарий 16 паспорта: клиентку записали по телефону, через неделю она регистрируется на сайте с тем же номером.
// Второй клиент не создается: после подтверждения номера кодом к существующей карточке добавляется пароль,
// и прежняя запись сразу видна в кабинете. Без кода привязки нет. Пока SMS-шлюз не подключен,
// код выдает администратор, убедившись по звонку, что это сама клиентка.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PASSWORDS, startApi, type TestApi } from './helpers/api.js';

const OLGA_PHONE = '+79035556677';
const registration = { name: 'Ольга Белова', phone: '8 (903) 555-66-77', email: 'olga@example.com', password: 'olga-password-1', pdConsent: true };

function olga(api: TestApi): { id: number; bookings: number } {
  const row = api.db.prepare('SELECT id FROM users WHERE phone = ?').get(OLGA_PHONE) as { id: number };
  const n = (api.db.prepare('SELECT count(*) AS n FROM bookings WHERE client_id = ?').get(row.id) as { n: number }).n;
  return { id: row.id, bookings: n };
}

describe('сценарий 16 с SMS-шлюзом', () => {
  let api: TestApi;
  before(async () => {
    api = await startApi();
  });
  after(() => api.close());

  it('регистрация на номер из карточки требует код, с кодом пароль добавляется к той же карточке', async () => {
    const before = olga(api);
    assert.equal(before.bookings, 1); // запись на маникюр, созданная администратором по звонку
    const users = (api.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;

    const c = api.client();
    const first = await c.post('/api/auth/register', registration);
    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'phone_verification_required');
    assert.equal(first.body.delivery, 'sms');
    assert.equal(c.cookie, null); // сессии нет: без кода доступа к записям нет
    const sms = api.sms.sent.at(-1)!;
    assert.equal(sms.phone, OLGA_PHONE);
    const code = /(\d{6})/.exec(sms.text)![1]!;

    const wrong = await c.post('/api/auth/register', { ...registration, code: code === '000000' ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.details.attemptsLeft, 2);

    const done = await c.post('/api/auth/register', { ...registration, code });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.linkedExistingClient, true);
    assert.equal(done.body.user.id, before.id); // та же карточка, второго клиента нет
    assert.equal(done.body.user.phoneVerified, true);
    assert.equal((api.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n, users);

    const mine = await c.get('/api/bookings');
    assert.equal(mine.body.bookings.length, 1); // запись, сделанная по звонку, сразу в кабинете
    await api.client().login('olga@example.com', 'olga-password-1');
  });

  it('после привязки номер занят как обычно, а код для нее администратору больше не выдается', async () => {
    assert.equal((await api.client().post('/api/auth/register', registration)).status, 409);
    const admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
    const res = await admin.post(`/api/admin/clients/${olga(api).id}/phone-code`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CLIENT_HAS_ACCOUNT');
  });
});

describe('сценарий 16 без SMS-шлюза: код выдает администратор', () => {
  let api: TestApi;
  before(async () => {
    api = await startApi({ sms: false });
  });
  after(() => api.close());

  it('клиентка звонит в студию, администратор диктует код, регистрация завершается', async () => {
    const c = api.client();
    const first = await c.post('/api/auth/register', registration);
    assert.equal(first.status, 202);
    assert.equal(first.body.delivery, 'studio');
    assert.match(first.body.message, /Позвоните в студию/);

    // Без кода — никак: угадать нельзя, код еще не выдан.
    const guess = await c.post('/api/auth/register', { ...registration, code: '123456' });
    assert.equal(guess.status, 400);

    const client = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
    assert.equal((await client.post(`/api/admin/clients/${olga(api).id}/phone-code`)).status, 403);

    const admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
    const issued = await admin.post(`/api/admin/clients/${olga(api).id}/phone-code`);
    assert.equal(issued.status, 201);
    assert.equal(issued.body.phone, OLGA_PHONE);
    assert.match(issued.body.code, /^\d{6}$/);

    const done = await c.post('/api/auth/register', { ...registration, code: issued.body.code });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.user.id, olga(api).id);
    assert.equal((await c.get('/api/bookings')).body.bookings.length, 1);
  });
});
