// Ограничение частоты запросов ко входу и регистрации (паспорт, раздел «Риски»: подбор паролей
// и спам-регистрации). В остальных тестах лимитер выключен, поэтому здесь приложение поднимается
// с rateLimit: true — и на каждый счетчик свое, иначе один тест выбирал бы лимит другого:
// счетчики общие на приложение, а окно у входа — минута, у регистрации — час.
//
// Запросы, которыми выбирается лимит, намеренно негодные (без пароля, без согласия): так проверяется,
// что счетчик растет на каждом запросе, а не только на неудачной попытке пароля — иначе лимит
// обходился бы чередованием запросов. Заодно тесты не тратят время на argon2id.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { PASSWORDS, startApi, type TestApi } from './helpers/api.js';

/** Лимиты заданы в src/app.ts. */
const LOGIN_PER_MINUTE = 20;
const REGISTER_PER_HOUR = 10;
/** Неверных паролей до закрытия входа в учетную запись и на сколько минут (src/api/auth.ts). */
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

async function withApi(run: (api: TestApi) => Promise<void>): Promise<void> {
  const api = await startApi({ rateLimit: true });
  try {
    await run(api);
  } finally {
    api.close();
  }
}

describe('ограничение частоты', () => {
  it(`вход: ${LOGIN_PER_MINUTE} запросов в минуту с одного адреса, дальше 429 с Retry-After`, async () => {
    await withApi(async (api) => {
      const attacker = api.client();
      // Негодное тело: лимит считается до разбора данных, поэтому эти запросы тоже идут в счет.
      for (let i = 1; i <= LOGIN_PER_MINUTE; i++) {
        const res = await attacker.post('/api/auth/login', { login: `nobody-${i}@example.com` });
        assert.equal(res.status, 400, `запрос ${i} должен дойти до проверки данных, а не до лимита`);
      }
      const blocked = await attacker.post('/api/auth/login', { login: 'nobody@example.com' });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, 'TOO_MANY_REQUESTS');
      const retryAfter = Number(blocked.headers.get('retry-after'));
      assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After ${retryAfter} должен быть в пределах минуты`);

      // Лимит на адрес, а не на учетную запись: под ним и правильный пароль не проходит.
      const honest = await api.client().post('/api/auth/login', { login: 'maria@example.com', password: PASSWORDS.clientPassword });
      assert.equal(honest.status, 429, 'лимит считается по адресу, а новая cookie его не обходит');
    });
  });

  it(`вход: ${MAX_FAILED_LOGINS} неверных паролей закрывают учетную запись на ${LOCK_MINUTES} минут`, async () => {
    await withApi(async (api) => {
      const attacker = api.client();
      for (let i = 1; i <= MAX_FAILED_LOGINS; i++) {
        const res = await attacker.post('/api/auth/login', { login: 'maria@example.com', password: `wrong-password-${i}` });
        assert.equal(res.status, 401);
        assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      }
      // Теперь не проходит и верный пароль — именно это отличает блокировку от лимита по адресу.
      const right = await attacker.post('/api/auth/login', { login: 'maria@example.com', password: PASSWORDS.clientPassword });
      assert.equal(right.status, 429);
      assert.equal(right.body.error.code, 'LOGIN_LOCKED');
      assert.equal(Number(right.headers.get('retry-after')), LOCK_MINUTES * 60);

      // Закрыта одна учетная запись, а не вход вообще: администратор входит как обычно.
      const admin = await api.client().post('/api/auth/login', { login: 'admin@example.com', password: PASSWORDS.adminPassword });
      assert.equal(admin.status, 200, 'блокировка не должна задевать другие учетные записи');
    });
  });

  it(`регистрация: ${REGISTER_PER_HOUR} в час с одного адреса, дальше 429`, async () => {
    await withApi(async (api) => {
      const spammer = api.client();
      for (let i = 1; i <= REGISTER_PER_HOUR; i++) {
        // Без pdConsent — 400: важно, что запрос все равно засчитан.
        const res = await spammer.post('/api/auth/register', { name: `Спам ${i}`, email: `spam-${i}@example.com`, password: 'password-1234' });
        assert.equal(res.status, 400, `запрос ${i} должен дойти до проверки данных, а не до лимита`);
      }
      const blocked = await spammer.post('/api/auth/register', {
        name: 'Спам', email: 'spam-last@example.com', password: randomBytes(12).toString('base64url'), pdConsent: true,
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, 'TOO_MANY_REQUESTS');
      const retryAfter = Number(blocked.headers.get('retry-after'));
      assert.ok(retryAfter > 0 && retryAfter <= 3600, `Retry-After ${retryAfter} должен быть в пределах часа`);
      // Ни одна из этих попыток не создала пользователя.
      assert.equal((api.db.prepare("SELECT count(*) AS n FROM users WHERE email LIKE 'spam-%'").get() as { n: number }).n, 0);
    });
  });

  it('счетчик у входа и у регистрации свой: выбранный лимит входа не закрывает регистрацию', async () => {
    await withApi(async (api) => {
      const visitor = api.client();
      for (let i = 1; i <= LOGIN_PER_MINUTE + 1; i++) await visitor.post('/api/auth/login', { login: `nobody-${i}@example.com` });
      assert.equal((await visitor.post('/api/auth/login', { login: 'nobody@example.com' })).status, 429);

      const registered = await visitor.post('/api/auth/register', {
        name: 'Новая клиентка', email: 'after-login-limit@example.com',
        password: randomBytes(12).toString('base64url'), pdConsent: true,
      });
      assert.equal(registered.status, 201, 'лимит входа не должен мешать регистрации');
    });
  });
});
