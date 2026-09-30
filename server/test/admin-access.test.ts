// Раздел администратора закрыт на сервере, а не только в интерфейсе:
//   * страницы /admin отдает только администратору: гостю — 302 на общую форму входа,
//     клиенту и мастеру — 403 и страница «Этот раздел только для администраторов» (src/web/admin-pages.ts);
//   * /api/admin/* отвечают клиенту и мастеру 403: одна проверка requireAdmin на весь раздел (api/guards.ts, app.ts),
//     и тест перебирает все маршруты раздела — новый эндпоинт без защиты его уронит;
//   * роли пользователя — список `roles`, и ни одно поле API не позволяет назначить себе роль.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createRouter } from '../src/app.js';
import { SERVER_ROOT } from '../src/config.js';
import { type Client, PASSWORDS, startApi, type TestApi } from './helpers/api.js';

let api: TestApi;
let admin: Client;
let client: Client;
let master: Client;
let guest: Client;

const PAGES = ['/admin', '/admin/', '/admin/services', '/admin/services/form', '/admin/masters', '/admin/masters/form'];
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
    assert.equal((await guest.get('/admin/services/form?id=5')).headers.get('location'), '/login.html?next=%2Fadmin%2Fservices%2Fform%3Fid%3D5');
    assert.equal((await guest.get('/admin/masters/form?id=a(b')).headers.get('location'), '/login.html?next=%2Fadmin%2Fmasters%2Fform');
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
    for (const [page, title] of [['/admin', 'Записи'], ['/admin/', 'Записи'], ['/admin/services', 'Услуги'], ['/admin/masters', 'Мастера'],
      ['/admin/services/form?id=1', 'Услуга'], ['/admin/masters/form', 'Мастер']]) {
      const res = await admin.get(page!);
      assert.equal(res.status, 200, page);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.ok(html(res.body).includes(`>${title}</h1>`), page);
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

describe('одна проверка на весь /api/admin', () => {
  // Все маршруты раздела — из того же маршрутизатора, что у сервера: новый эндпоинт попадет сюда сам.
  const ADMIN_ROUTES = createRouter({ secureCookies: false }).list().filter((r) => r.path.startsWith('/api/admin/'));
  const PARAMS: Record<string, string> = { id: '1', noteId: '1', date: '2026-10-01', a: '1', b: '2' };
  const url = (path: string) => path.replace(/:(\w+)/g, (_, key: string) => PARAMS[key] ?? '1');
  const call = (who: Client, method: string, path: string) =>
    who.request(method, url(path), method === 'GET' || method === 'DELETE' ? undefined : {});
  const counts = () => Object.fromEntries(
    ['users', 'bookings', 'services', 'service_categories', 'masters', 'time_blocks', 'studio_day_overrides', 'client_notes', 'work_photos', 'settings']
      .map((t) => [t, (api.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
  );

  it('маршрутов раздела много, и проверки роли администратора в самих обработчиках нет', () => {
    assert.ok(ADMIN_ROUTES.length >= 40, `нашлось ${ADMIN_ROUTES.length}`);
    const apiDir = path.join(SERVER_ROOT, 'src', 'api');
    for (const file of readdirSync(apiDir).filter((f) => f.endsWith('.ts') && f !== 'guards.ts')) {
      const source = readFileSync(path.join(apiDir, file), 'utf8');
      assert.ok(!source.includes("requireRole(ctx, 'admin')") && !source.includes('requireAdmin('), `${file}: роль проверяется в обработчике`);
    }
  });

  it('каждый маршрут /api/admin/*: клиенту и мастеру — 403, гостю — 401, данные не меняются', async () => {
    const before = counts();
    const settings = api.db.prepare('SELECT * FROM settings').get();
    for (const { method, path } of ADMIN_ROUTES) {
      assert.equal((await call(client, method, path)).status, 403, `клиент: ${method} ${path}`);
      assert.equal((await call(master, method, path)).status, 403, `мастер: ${method} ${path}`);
      assert.equal((await call(guest, method, path)).status, 401, `гость: ${method} ${path}`);
    }
    assert.deepEqual(counts(), before);
    assert.deepEqual(api.db.prepare('SELECT * FROM settings').get(), settings);
  });

  it('проверка стоит до поиска маршрута: несуществующий адрес раздела клиенту — 403, а не 404', async () => {
    assert.equal((await client.get('/api/admin/new-endpoint')).status, 403);
    assert.equal((await client.request('PATCH', '/api/admin/bookings', {})).status, 403);
    assert.equal((await admin.get('/api/admin/new-endpoint')).status, 404);
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
