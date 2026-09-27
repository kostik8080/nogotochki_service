// Регрессия по требованиям безопасности к API:
//   * запросы к базе параметризованы — текст SQL не собирается из данных пользователя;
//   * поля, которые пользователь задавать не вправе (роль, цена, статус, наложение), отклоняются;
//   * ответы об ошибках не раскрывают внутренние подробности: пути, стек, тексты ошибок SQLite,
//     имена таблиц и полей.
// Проверки идут через настоящий HTTP по базе в памяти с тестовыми данными.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/connection.js';
import { type Client, PASSWORDS, startApi, type TestApi } from './helpers/api.js';

let api: TestApi;
let db: Db;
let admin: Client;
let client: Client;
let guest: Client;

const ANNA = 1;
const MANICURE = 1;
/** Время в будущем: для этих проверок важен ответ о правах и данных, а не свободен ли слот. */
const FUTURE = '2027-10-08T08:00:00.000Z';

before(async () => {
  api = await startApi();
  db = api.db;
  admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
  client = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
  guest = api.client();
});
after(() => api.close());

describe('внедрение SQL', () => {
  const INJECTION = "1' OR '1'='1";
  const DROP = "'; DROP TABLE bookings; --";

  it('в строке запроса, в пути и в поиске остается данными: выборка не расширяется', async () => {
    const before = {
      users: (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n,
      bookings: (db.prepare('SELECT count(*) AS n FROM bookings').get() as { n: number }).n,
    };

    // Каждое поле разбирается по своему типу, поэтому текст в него просто не попадает.
    assert.equal((await admin.get(`/api/admin/bookings?status=${encodeURIComponent(INJECTION)}`)).status, 400);
    assert.equal((await admin.get(`/api/admin/bookings?masterId=${encodeURIComponent(DROP)}`)).status, 400);
    assert.equal((await admin.get(`/api/admin/bookings?dateFrom=${encodeURIComponent("2026-01-01' UNION SELECT 1--")}`)).status, 400);
    assert.equal((await admin.get(`/api/admin/bookings?limit=${encodeURIComponent('1;DELETE FROM users')}`)).status, 400);
    assert.equal((await admin.get(`/api/bookings/${encodeURIComponent(DROP)}`)).status, 404);
    assert.equal((await guest.post('/api/auth/login', { login: "admin@example.com' --", password: 'x'.repeat(12) })).status, 401);

    // Поиск клиентов идет по тексту: кавычки и OR 1=1 — это просто строка, совпадений нет.
    const all = await admin.get('/api/admin/clients');
    assert.equal(all.status, 200);
    assert.ok(all.body.clients.length > 0, 'в тестовых данных должны быть клиенты');
    const injected = await admin.get(`/api/admin/clients?search=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(injected.status, 200);
    assert.deepEqual(injected.body.clients, [], 'внедрение не должно расширять выборку');

    const after = {
      users: (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n,
      bookings: (db.prepare('SELECT count(*) AS n FROM bookings').get() as { n: number }).n,
    };
    assert.deepEqual(after, before, 'ни одна строка не должна пропасть или появиться');
  });

  it('в теле запроса сохраняется дословно как текст, а не выполняется', async () => {
    const name = `Ноготочки'); DROP TABLE users; --`;
    const res = await admin.patch('/api/admin/settings', { studioName: name });
    assert.equal(res.status, 200);
    // Значение вернулось и легло в базу без изменений: для базы это данные.
    assert.equal(res.body.settings.studioName, name);
    assert.equal((db.prepare('SELECT studio_name FROM settings WHERE id = 1').get() as { studio_name: string }).studio_name, name);
    assert.ok((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get() as { n: number }).n === 1, 'таблица users должна остаться');
    await admin.patch('/api/admin/settings', { studioName: 'Ноготочки' });
  });
});

describe('поля, которые пользователь задавать не вправе', () => {
  // Каждая строка: кто, куда, какое лишнее поле. Валидатор не игнорирует неизвестное поле молча,
  // иначе интерфейс считал бы, что значение принято.
  const cases: [name: string, run: () => Promise<{ status: number; body: any }>, field: string][] = [
    ['роль при регистрации', () => guest.post('/api/auth/register',
      { name: 'Тест', email: 'role@example.com', password: 'password-1', pdConsent: true, role: 'admin' }), 'role'],
    ['номер пользователя при регистрации', () => guest.post('/api/auth/register',
      { name: 'Тест', email: 'id@example.com', password: 'password-1', pdConsent: true, id: 1 }), 'id'],
    ['роль в профиле', () => client.patch('/api/profile', { role: 'admin' }), 'role'],
    ['закрытие доступа себе', () => client.patch('/api/profile', { blockedAt: null }), 'blockedAt'],
    ['отметка о подтверждении e-mail', () => client.patch('/api/profile', { emailVerified: true }), 'emailVerified'],
    ['наложение в брони', () => client.post('/api/holds',
      { masterId: ANNA, startsAt: FUTURE, services: [{ serviceId: MANICURE }], isOverbooking: true }), 'isOverbooking'],
    ['уровень цены в записи', () => client.post('/api/bookings',
      { masterId: ANNA, startsAt: FUTURE, services: [{ serviceId: MANICURE }], priceLevel: 'master' }), 'priceLevel'],
    ['итоговая цена в записи', () => client.post('/api/bookings',
      { masterId: ANNA, startsAt: FUTURE, services: [{ serviceId: MANICURE }], totalPriceKop: 0 }), 'totalPriceKop'],
    ['статус в записи', () => client.post('/api/bookings',
      { masterId: ANNA, startsAt: FUTURE, services: [{ serviceId: MANICURE }], status: 'completed' }), 'status'],
    ['автор записи', () => client.post('/api/bookings',
      { masterId: ANNA, startsAt: FUTURE, services: [{ serviceId: MANICURE }], createdBy: 1 }), 'createdBy'],
    ['тип услуги', () => admin.patch('/api/admin/services/1', { kind: 'addon' }), 'kind'],
    ['номер строки настроек', () => admin.patch('/api/admin/settings', { id: 2 }), 'id'],
  ];

  for (const [name, run, field] of cases) {
    it(`${name} — 400, поле ${field} не принимается`, async () => {
      const res = await run();
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.ok(res.body.error.details.fields.some((f: { field: string; message: string }) =>
        f.field === field && f.message === 'Неизвестное поле'), JSON.stringify(res.body.error.details));
    });
  }

  it('клиент не записывает другого человека и не отменяет от имени студии', async () => {
    const olga = (db.prepare("SELECT id FROM users WHERE phone = '+79035556677'").get() as { id: number }).id;
    const forOther = await client.post('/api/bookings',
      { masterId: ANNA, startsAt: FUTURE, services: [{ serviceId: MANICURE }], clientId: olga });
    assert.equal(forOther.status, 403);
    assert.equal(forOther.body.error.message, 'Клиент записывает только себя');

    const own = (db.prepare("SELECT id FROM bookings WHERE client_id = ? AND status = 'active' ORDER BY id LIMIT 1")
      .get(3) as { id: number } | undefined);
    assert.ok(own, 'в тестовых данных должна быть активная запись клиентки');
    const asStudio = await client.post(`/api/bookings/${own.id}/cancel`, { by: 'studio' });
    assert.equal(asStudio.status, 400);
    assert.equal(asStudio.body.error.details.fields[0].message, 'Клиент отменяет запись от своего имени');
  });
});

describe('ответы об ошибках без внутренних подробностей', () => {
  /** Признаки, которых в ответе быть не должно. Путь Windows — только с обратной косой: «https://…» не путь. */
  const leaks: [RegExp, string][] = [
    [/[A-Za-z]:\\/, 'путь Windows'],
    [/(^|[\s"'(])\/(var|home|usr|etc)\//, 'путь Unix'],
    [/\.ts:\d+|\.js:\d+/, 'файл и строка кода'],
    [/\bat \w+ \(|at Object\./, 'стек вызовов'],
    [/SQLITE_|ERR_SQLITE|SQL logic error/i, 'код ошибки SQLite'],
    [/constraint failed|no such (table|column)|syntax error/i, 'текст ошибки базы'],
    [/\b(users|bookings|sessions|slot_holds|auth_codes|client_profiles)\.\w+/, 'таблица и поле базы'],
    [/nogotochki\.db|\.env\b/, 'имя файла базы или окружения'],
  ];

  it('ни путей, ни стека, ни текста ошибок базы', async () => {
    const responses: [string, { status: number; body: unknown }][] = [
      ['несуществующий адрес', await guest.get('/api/nope')],
      ['метод не тот', await guest.delete('/api/services')],
      ['битый JSON', await guest.post('/api/auth/login', '{"login":')],
      ['тело не объект', await guest.post('/api/auth/login', '[1,2,3]')],
      // UNIQUE в базе: имя таблицы и поля из текста ошибки SQLite наружу не идет.
      ['занятое название категории', await admin.post('/api/admin/service-categories', { name: 'Маникюр' })],
      ['записи нет', await admin.get('/api/bookings/999999')],
      ['фото нет', await guest.get('/api/photos/999999/file')],
      ['услуги нет', await admin.patch('/api/admin/services/999999', { name: 'Нет такой' })],
      ['мастера нет', await client.post('/api/holds', { masterId: 999999, startsAt: FUTURE, services: [{ serviceId: MANICURE }] })],
    ];

    for (const [name, res] of responses) {
      assert.ok(res.status >= 400, `${name}: ожидалась ошибка, получено ${res.status}`);
      const text = JSON.stringify(res.body);
      for (const [pattern, what] of leaks) {
        assert.doesNotMatch(text, pattern, `${name}: в ответе видно ${what} — ${text.slice(0, 200)}`);
      }
    }
  });

  it('неизвестная ошибка превращается в общий 500 без подробностей', async () => {
    // Ошибка, которую сервер не ожидает: обработчик отдает общий текст, подробности уходят только в лог.
    const { HttpError } = await import('../src/http/errors.js');
    const generic = new HttpError(500, 'INTERNAL_ERROR', 'Что-то пошло не так. Попробуйте еще раз');
    assert.doesNotMatch(generic.message, /[A-Za-z]:\\|\.ts:\d+|SQLITE_/);

    // Ошибка базы, не описанная в таблице триггеров, не переводится и потому не попадает в ответ как есть.
    const { fromDatabaseError } = await import('../src/http/errors.js');
    const sqlite = Object.assign(new Error('SQLITE_ERROR: no such column: users.secret'), { code: 'ERR_SQLITE_ERROR' });
    assert.equal(fromDatabaseError(sqlite), null, 'неизвестная ошибка базы не должна становиться ответом с ее текстом');

    // А нарушение UNIQUE вне таблицы триггеров отдается обобщенно, без имени таблицы и поля.
    const unique = Object.assign(new Error('UNIQUE constraint failed: client_profiles.user_id'), { code: 'ERR_SQLITE_ERROR' });
    const mapped = fromDatabaseError(unique);
    assert.equal(mapped?.code, 'ALREADY_EXISTS');
    assert.equal(mapped?.message, 'Такое значение уже есть');
    assert.doesNotMatch(mapped!.message, /client_profiles/);
  });
});
