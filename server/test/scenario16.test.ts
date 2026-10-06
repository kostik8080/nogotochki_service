// Сценарий 16 паспорта: клиентку записали по телефону, через неделю она регистрируется на сайте с тем же номером.
// Второй клиент не создается: после подтверждения номера кодом к существующей карточке добавляется пароль,
// и прежняя запись сразу видна в кабинете. Без кода привязки нет. SMS в сервисе нет: код приходит на e-mail
// из карточки клиентки, а если его там нет — код выдает администратор, убедившись по звонку, что это она.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PASSWORDS, startApi, type TestApi } from './helpers/api.js';

const OLGA_PHONE = '+79035556677';
const registration = { name: 'Ольга Белова', phone: '8 (903) 555-66-77', email: 'olga@example.com', password: 'olga-password-1', pdConsent: true };

/** Вернуть карточку Ольги к исходному виду: записана студией, пароля и кодов нет. */
function resetOlga(api: TestApi): void {
  api.db.prepare("UPDATE users SET password_hash = NULL, email = NULL, phone_verified_at = NULL WHERE phone = ?").run(OLGA_PHONE);
  api.db.prepare("DELETE FROM auth_codes WHERE purpose = 'verify_phone'").run();
}

function olga(api: TestApi): { id: number; bookings: number } {
  const row = api.db.prepare('SELECT id FROM users WHERE phone = ?').get(OLGA_PHONE) as { id: number };
  const n = (api.db.prepare('SELECT count(*) AS n FROM bookings WHERE client_id = ?').get(row.id) as { n: number }).n;
  return { id: row.id, bookings: n };
}

describe('сценарий 16: код на e-mail из карточки', () => {
  let api: TestApi;
  before(async () => {
    api = await startApi();
  });
  after(() => api.close());

  it('регистрация на номер из карточки требует код, с кодом пароль добавляется к той же карточке', async () => {
    // Администратор записал в карточку Ольги ее e-mail, когда она звонила.
    api.db.prepare('UPDATE users SET email = ? WHERE phone = ?').run('olga.card@example.com', OLGA_PHONE);
    const before = olga(api);
    assert.equal(before.bookings, 1); // запись на маникюр, созданная администратором по звонку
    const users = (api.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;

    const c = api.client();
    const first = await c.post('/api/auth/register', registration);
    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'phone_verification_required');
    assert.equal(first.body.delivery, 'email');
    assert.equal(first.body.sentTo, 'o***@example.com');
    assert.equal(c.cookie, null); // сессии нет: без кода доступа к записям нет
    const mail = api.mailer.sent.at(-1)!;
    assert.equal(mail.to, 'olga.card@example.com'); // на адрес из карточки, а не на тот, что ввели при регистрации
    const code = /(\d{6})/.exec(mail.text)![1]!;

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
    const res = await admin.post(`/api/admin/users/${olga(api).id}/phone-code`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NO_PENDING_REQUEST');
  });
  it('повтор в ту же минуту не обещает письма, которого не отправляли', async () => {
    resetOlga(api);
    api.db.prepare('UPDATE users SET email = ? WHERE phone = ?').run('olga.card@example.com', OLGA_PHONE);
    const c = api.client();

    const first = await c.post('/api/auth/register', registration);
    assert.equal(first.status, 202);
    assert.equal(first.body.sent, true);
    assert.equal(first.body.retryAfterSec, undefined);
    assert.match(first.body.message, /Мы отправили код/);
    const letters = api.mailer.sent.length;

    // Второй запрос в ту же минуту: нового кода нет, письма нет — и ответ об этом говорит прямо.
    const again = await c.post('/api/auth/register', registration);
    assert.equal(again.status, 202);
    assert.equal(again.body.delivery, 'email');
    assert.equal(again.body.sent, false);
    assert.ok(again.body.retryAfterSec > 0 && again.body.retryAfterSec <= 60, 'нет времени до следующего кода');
    assert.doesNotMatch(again.body.message, /Мы отправили код/);
    assert.match(again.body.message, /Если письмо .* не пришло, запросите новый код/);
    assert.equal(api.mailer.sent.length, letters, 'письмо ушло второй раз');

    // Прежний код продолжает работать: человеку есть что вводить.
    const code = /(\d{6})/.exec(api.mailer.sent.at(-1)!.text)![1]!;
    const done = await c.post('/api/auth/register', { ...registration, code });
    assert.equal(done.status, 201, JSON.stringify(done.body));
  });

  it('e-mail в карточке появился после первой попытки — письмо уходит, как только пройдет минута', async () => {
    resetOlga(api);
    const c = api.client();
    // E-mail в карточке еще нет: код создается как отметка запроса, письма нет и ответ его не обещает.
    const studio = await c.post('/api/auth/register', registration);
    assert.equal(studio.body.delivery, 'studio');
    assert.equal(studio.body.sent, undefined);
    assert.doesNotMatch(studio.body.message, /отправили код на e-mail/);

    // Администратор внес e-mail, человек повторяет сразу: письма еще нет, и ответ об этом говорит.
    api.db.prepare('UPDATE users SET email = ? WHERE phone = ?').run('olga.card@example.com', OLGA_PHONE);
    const tooSoon = await c.post('/api/auth/register', registration);
    assert.equal(tooSoon.body.delivery, 'email');
    assert.equal(tooSoon.body.sent, false);
    assert.ok(tooSoon.body.retryAfterSec > 0);
  });

});

describe('сценарий 16: в карточке нет e-mail — код выдает администратор', () => {
  let api: TestApi;
  before(async () => {
    api = await startApi();
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
    assert.equal((await client.post(`/api/admin/users/${olga(api).id}/phone-code`)).status, 403);

    const admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
    const issued = await admin.post(`/api/admin/users/${olga(api).id}/phone-code`);
    assert.equal(issued.status, 201);
    assert.equal(issued.body.phone, OLGA_PHONE);
    assert.equal(issued.body.purpose, 'link_account');
    assert.match(issued.body.code, /^\d{6}$/);

    const done = await c.post('/api/auth/register', { ...registration, code: issued.body.code });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.user.id, olga(api).id);
    assert.equal((await c.get('/api/bookings')).body.bookings.length, 1);
  });
});
