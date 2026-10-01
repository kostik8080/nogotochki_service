// Вход через Яндекс в один клик: POST /api/auth/yandex. Приложение в Яндексе еще не зарегистрировано,
// поэтому профиль подставляет заглушка (src/auth/yandex.ts) — тест проверяет нашу часть входа:
// поиск по e-mail, привязку к существующему аккаунту, роль client, свою сессию и «Забыли пароль?»
// у аккаунта без пароля.
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { fetchYandexProfile, stubYandexLogin } from '../src/auth/yandex.js';
import type { Db } from '../src/db/connection.js';
import { PASSWORDS, startApi, type TestApi } from './helpers/api.js';

/** Короткая запись для «сколько строк»: node:sqlite возвращает строку как unknown. */
const count = (db: Db, sql: string, ...params: (string | number)[]) =>
  (db.prepare(sql).get(...params) as { n: number }).n;

const NEW_EMAIL = 'yandex-new@example.com';

let api: TestApi;
let withMaria: TestApi;
let withAdmin: TestApi;

before(async () => {
  // Три приложения: у каждого своя заглушка с одним профилем — один «аккаунт Яндекса» на сервис.
  api = await startApi({ yandexLogin: stubYandexLogin({ email: NEW_EMAIL, name: 'Яна Тестовая' }) });
  withMaria = await startApi({ yandexLogin: stubYandexLogin({ email: 'maria@example.com', name: 'Мария из Яндекса' }) });
  withAdmin = await startApi({ yandexLogin: stubYandexLogin({ email: 'admin@example.com', name: 'Админ из Яндекса' }) });
});
after(() => {
  api.close();
  withMaria.close();
  withAdmin.close();
});

it('без заглушки и без приложения в Яндексе вход отвечает «пока не подключен», аккаунт не создается', async () => {
  // Настоящий Яндекс передается явно: по настройкам (YANDEX_LOGIN_STUB в server/.env) у разработчика
  // может быть включена заглушка, а тест проверяет поведение сервера без подключенного Яндекса.
  const plain = await startApi({ yandexLogin: fetchYandexProfile });
  try {
    const res = await plain.client().post('/api/auth/yandex');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'YANDEX_LOGIN_UNAVAILABLE');
    assert.equal(count(plain.db, 'SELECT count(*) AS n FROM users WHERE provider IS NOT NULL'), 0);
  } finally {
    plain.close();
  }
});

it('новый e-mail: создается аккаунт клиента без пароля, сессия своя, роль только client', async () => {
  const client = api.client();
  const res = await client.post('/api/auth/yandex');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.registered, true);
  assert.equal(res.body.provider, 'yandex');
  assert.deepEqual(res.body.user.roles, ['client']);
  assert.equal(res.body.user.email, NEW_EMAIL);
  assert.equal(res.body.user.emailVerified, true);
  assert.equal(res.body.user.hasPassword, false);
  assert.equal(res.body.user.provider, 'yandex');

  // Сессия — наша: cookie HttpOnly, в базе только хеш токена, токена Яндекса нигде нет.
  const cookie = res.headers.getSetCookie().join(' ');
  assert.match(cookie, /nogotochki_session=.+HttpOnly/i);
  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, res.body.user.id);

  const row = api.db.prepare('SELECT role, password_hash, provider, provider_id, pd_consent_version FROM users WHERE email = ?').get(NEW_EMAIL) as
    { role: string; password_hash: string | null; provider: string; provider_id: string; pd_consent_version: string | null };
  assert.equal(row.role, 'client');
  assert.equal(row.password_hash, null);
  assert.equal(row.provider, 'yandex');
  assert.equal(row.provider_id, `stub-${NEW_EMAIL}`);
  assert.ok(row.pd_consent_version, 'записана редакция политики, на которую дано согласие');

  // Второй вход тем же профилем: второго аккаунта нет, ответ 200 вместо 201.
  const again = await api.client().post('/api/auth/yandex');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.registered, false);
  assert.equal(again.body.user.id, res.body.user.id);
  assert.equal(count(api.db, 'SELECT count(*) AS n FROM users WHERE email = ?', NEW_EMAIL), 1);
});

it('e-mail уже есть у клиентки: внешний вход привязывается к ее аккаунту, пароль продолжает работать', async () => {
  const before = withMaria.db.prepare("SELECT id, name, password_hash FROM users WHERE email = 'maria@example.com'").get() as
    { id: number; name: string; password_hash: string };
  const bookings = count(withMaria.db, 'SELECT count(*) AS n FROM bookings WHERE client_id = ?', before.id);

  const res = await withMaria.client().post('/api/auth/yandex');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.registered, false);
  assert.equal(res.body.user.id, before.id, 'второй клиент с тем же адресом не создается');
  assert.equal(count(withMaria.db, "SELECT count(*) AS n FROM users WHERE email = 'maria@example.com'"), 1);

  const after = withMaria.db.prepare('SELECT name, password_hash, provider FROM users WHERE id = ?').get(before.id) as
    { name: string; password_hash: string; provider: string };
  assert.equal(after.provider, 'yandex');
  assert.equal(after.password_hash, before.password_hash, 'пароль остался: входить можно и так, и так');
  assert.equal(after.name, before.name, 'имя из Яндекса не перетирает имя в студии');
  assert.equal(count(withMaria.db, 'SELECT count(*) AS n FROM bookings WHERE client_id = ?', before.id), bookings);
  // Прежний вход по паролю не сломался.
  await withMaria.client().login('maria@example.com', PASSWORDS.clientPassword);
});

it('e-mail сотрудника: внешний вход прав администратора не дает', async () => {
  const res = await withAdmin.client().post('/api/auth/yandex');
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'STAFF_PASSWORD_LOGIN_ONLY');
  const row = withAdmin.db.prepare("SELECT role, provider FROM users WHERE email = 'admin@example.com'").get() as
    { role: string; provider: string | null };
  assert.equal(row.role, 'admin');
  assert.equal(row.provider, null);
  // Роль через внешний вход не выдается и на уровне базы: provider бывает только у клиента.
  assert.throws(() => withAdmin.db.prepare("UPDATE users SET provider = 'yandex', provider_id = 'x' WHERE email = 'admin@example.com'").run());
});

it('«Забыли пароль?» у аккаунта без пароля: письма нет, сервис объясняет, что вход через Яндекс', async () => {
  const stub = await startApi({ yandexLogin: stubYandexLogin({ email: NEW_EMAIL, name: 'Яна Тестовая' }) });
  try {
    assert.equal((await stub.client().post('/api/auth/yandex')).status, 201);
    stub.mailer.sent.length = 0;

    const res = await stub.client().post('/api/auth/password-reset/request', { login: NEW_EMAIL });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.provider, 'yandex');
    assert.match(res.body.message, /Войти через Яндекс/);
    assert.equal(stub.mailer.sent.length, 0, 'письмо для сброса пароля не отправляется');
    assert.equal(count(stub.db, "SELECT count(*) AS n FROM auth_codes WHERE purpose = 'reset_password'"), 0);

    // У аккаунта с паролем ответ прежний: одинаковый, есть такой аккаунт или нет.
    const usual = await stub.client().post('/api/auth/password-reset/request', { login: 'maria@example.com' });
    assert.equal(usual.status, 202);
    assert.equal(usual.body.provider, undefined);
    assert.equal(stub.mailer.sent.length, 1);
  } finally {
    stub.close();
  }
});

it('аккаунт с внешним входом: смена пароля объясняет, что пароля нет, а удаление доступно без пароля', async () => {
  const stub = await startApi({ yandexLogin: stubYandexLogin({ email: NEW_EMAIL, name: 'Яна Тестовая' }) });
  try {
    const client = stub.client();
    const login = await client.post('/api/auth/yandex');
    assert.equal(login.status, 201);

    const change = await client.post('/api/profile/password', { currentPassword: 'что-нибудь', newPassword: 'new-password-1' });
    assert.equal(change.status, 403);
    assert.equal(change.body.error.code, 'EXTERNAL_LOGIN_ONLY');

    const removed = await client.delete('/api/profile');
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    const row = stub.db.prepare('SELECT name, email, provider, provider_id, deleted_at FROM users WHERE id = ?').get(login.body.user.id) as
      { name: string; email: string | null; provider: string | null; provider_id: string | null; deleted_at: string | null };
    assert.equal(row.email, null);
    assert.equal(row.provider, null, 'после удаления аккаунт нельзя снова открыть тем же входом Яндекса');
    assert.equal(row.provider_id, null);
    assert.ok(row.deleted_at);

    // Повторный вход тем же профилем создает новый пустой аккаунт, а не поднимает удаленный.
    const again = await stub.client().post('/api/auth/yandex');
    assert.equal(again.status, 201);
    assert.notEqual(again.body.user.id, login.body.user.id);
  } finally {
    stub.close();
  }
});

it('регистрация по телефону не считает аккаунт с внешним входом карточкой из студии', async () => {
  const stub = await startApi({ yandexLogin: stubYandexLogin({ email: NEW_EMAIL, name: 'Яна Тестовая' }) });
  try {
    const client = stub.client();
    assert.equal((await client.post('/api/auth/yandex')).status, 201);
    // Администратор внес номер в аккаунт (как при звонке), пароля у аккаунта по-прежнему нет.
    stub.db.prepare("UPDATE users SET phone = '+79990001122' WHERE email = ?").run(NEW_EMAIL);

    const res = await stub.client().post('/api/auth/register', {
      name: 'Чужой человек', phone: '+79990001122', password: 'other-password-1', pdConsent: true, marketingConsent: false,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'PHONE_TAKEN');
    assert.equal((stub.db.prepare('SELECT password_hash FROM users WHERE email = ?').get(NEW_EMAIL) as { password_hash: string | null }).password_hash, null);
  } finally {
    stub.close();
  }
});
