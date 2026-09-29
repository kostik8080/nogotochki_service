// Раздел администратора закрыт на сервере, а не только в интерфейсе:
//   * страницы /admin отдает только администратору: гостю — 302 на общую форму входа,
//     клиенту и мастеру — 403 и страница «Этот раздел только для администраторов» (src/web/admin-pages.ts);
//   * /api/admin/* отвечают клиенту и мастеру 403 (api/guards.ts, requireRole);
//   * роли пользователя — список `roles`, и ни одно поле API не позволяет назначить себе роль.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Client, PASSWORDS, startApi, type TestApi } from './helpers/api.js';

let api: TestApi;
let admin: Client;
let client: Client;
let master: Client;
let guest: Client;

const PAGES = ['/admin', '/admin/', '/admin/services', '/admin/masters'];
const DENIED = 'Этот раздел только для администраторов';

before(async () => {
  api = await startApi();
  admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
  client = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
  master = await api.client().login('anna@example.com', PASSWORDS.masterPassword);
  guest = api.client();
});
after(() => api.close());

const html = (body: unknown) => (Buffer.isBuffer(body) ? body.toString('utf8') : String(body));

describe('роли — список', () => {
  it('GET /api/auth/me и вход отдают roles списком', async () => {
    assert.deepEqual((await admin.get('/api/auth/me')).body.user.roles, ['admin']);
    assert.deepEqual((await client.get('/api/auth/me')).body.user.roles, ['client']);
    assert.deepEqual((await master.get('/api/auth/me')).body.user.roles, ['master']);
    const login = await api.client().post('/api/auth/login', { login: 'maria@example.com', password: PASSWORDS.clientPassword });
    assert.deepEqual(login.body.user.roles, ['client']);
  });

  it('роль нельзя получить через API: поля role и roles отклоняются', async () => {
    const register = await api.client().post('/api/auth/register', {
      name: 'Тест', email: 'roles@example.com', password: 'password-1', pdConsent: true, roles: ['admin'],
    });
    assert.equal(register.status, 400);
    assert.equal((await client.patch('/api/profile', { roles: ['admin'] })).status, 400);
    assert.deepEqual((await client.get('/api/auth/me')).body.user.roles, ['client']);
    assert.equal((await client.get('/admin')).status, 403);
  });
});

describe('страницы /admin', () => {
  it('гостя ведут на общую форму входа с возвратом в раздел', async () => {
    const res = await guest.request('GET', '/admin/services', undefined, {});
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login.html?next=%2Fadmin%2Fservices');
    assert.equal((await guest.get('/admin')).headers.get('location'), '/login.html?next=%2Fadmin');
  });

  for (const [who, get] of [['клиенту', () => client], ['мастеру', () => master]] as const) {
    it(`${who} — 403 и страница «${DENIED}», в том числе на несуществующий адрес раздела`, async () => {
      for (const page of [...PAGES, '/admin/unknown']) {
        const res = await get().get(page);
        assert.equal(res.status, 403, page);
        assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.ok(html(res.body).includes(DENIED), page);
      }
    });
  }

  it('администратору — страницы раздела; неизвестный адрес — 404', async () => {
    for (const [page, title] of [['/admin', 'Записи'], ['/admin/', 'Записи'], ['/admin/services', 'Услуги'], ['/admin/masters', 'Мастера']]) {
      const res = await admin.get(page!);
      assert.equal(res.status, 200, page);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.ok(html(res.body).includes(`<h1 class="admin__title">${title}</h1>`), page);
    }
    assert.equal((await admin.get('/admin/unknown')).status, 404);
    assert.equal((await admin.get('/admin/bookings.html')).status, 404);
  });

  it('после выхода раздел снова закрыт', async () => {
    const session = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
    assert.equal((await session.get('/admin')).status, 200);
    await session.post('/api/auth/logout');
    assert.equal((await session.get('/admin')).status, 302);
  });
});

describe('/api/admin/*', () => {
  const ENDPOINTS = ['/api/admin/bookings', '/api/admin/services', '/api/admin/masters', '/api/admin/clients'];

  it('клиенту и мастеру — 403, администратору — 200, гостю — 401', async () => {
    for (const path of ENDPOINTS) {
      assert.equal((await client.get(path)).status, 403, path);
      assert.equal((await master.get(path)).status, 403, path);
      assert.equal((await admin.get(path)).status, 200, path);
      assert.equal((await guest.get(path)).status, 401, path);
    }
  });

  it('клиент не меняет услуги и мастеров', async () => {
    assert.equal((await client.patch('/api/admin/services/1', { isActive: false })).status, 403);
    assert.equal((await client.patch('/api/admin/masters/1', { level: 'top_master' })).status, 403);
  });
});
