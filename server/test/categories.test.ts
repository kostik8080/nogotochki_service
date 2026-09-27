// Категории услуг (A-23): новая база на сервере стартует без категорий, и без них нельзя завести услугу.
// Администратор добавляет категорию, переименовывает, меняет порядок, отключает; название не повторяется
// без учета регистра, в том числе кириллицы.
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { PASSWORDS, startApi, type TestApi } from './helpers/api.js';

let api: TestApi;
before(async () => {
  api = await startApi();
});
after(() => api.close());

it('администратор ведет категории, по ним заводятся услуги, клиенту — 403', async () => {
  const admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
  const created = await admin.post('/api/admin/service-categories', { name: 'Уход за кожей рук' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.category.id;
  assert.equal(created.body.category.sortOrder, 5); // после четырех категорий тестовых данных

  assert.equal((await admin.post('/api/admin/service-categories', { name: 'уход за КОЖЕЙ рук' })).body.error.code, 'CATEGORY_NAME_TAKEN');
  assert.equal((await admin.post('/api/admin/service-categories', { name: 'маникюр' })).status, 409);

  const renamed = await admin.patch(`/api/admin/service-categories/${id}`, { name: 'Уход', sortOrder: 0 });
  assert.equal(renamed.body.category.name, 'Уход');
  const service = await admin.post('/api/admin/services', {
    categoryId: id, kind: 'main', name: 'Парафинотерапия', durationMin: 30, priceMasterKop: 90_000, priceTopKop: 110_000,
  });
  assert.equal(service.status, 201);

  const catalog = async () => (await api.client().get('/api/services')).body.categories.map((c: { name: string }) => c.name);
  assert.equal((await catalog())[0], 'Уход'); // порядок 0 — первой
  assert.equal((await admin.patch(`/api/admin/service-categories/${id}`, { isActive: false })).status, 200);
  assert.ok(!(await catalog()).includes('Уход')); // отключенная категория и ее услуги скрыты из каталога

  const maria = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
  assert.equal((await maria.post('/api/admin/service-categories', { name: 'Чужая' })).status, 403);
  assert.equal((await admin.patch('/api/admin/service-categories/999', { name: 'Нет' })).status, 404);
});
