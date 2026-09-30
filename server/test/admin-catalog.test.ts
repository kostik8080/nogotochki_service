// Услуги и мастера в разделе администратора (A-23, A-24, A-19, A-22):
//   * администратор видит все строки, включая отключенные, клиент при записи — только включенные;
//   * «Удалить» решает сервер: без ссылок — удаляет строку, с записями — только отключает и объясняет почему;
//   * запись хранит название, цену и длительность на момент оформления: правка прайса ее не меняет;
//   * формы проверяются на сервере: пустое название, цена и длительность не больше нуля — 400;
//   * клиентский выбор мастера учитывает, какие услуги отмечены у мастера.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Client, PASSWORDS, startApi, type TestApi } from './helpers/api.js';

let api: TestApi;
let admin: Client;
let client: Client;

const one = (sql: string, ...args: (string | number)[]) => ({ ...api.db.prepare(sql).get(...args) }) as Record<string, number>;

before(async () => {
  api = await startApi();
  admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
  client = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
});
after(() => api.close());

/** Новая услуга без записей: категория и мастер — из тестовых данных. */
async function newService(name: string, extra: Record<string, unknown> = {}) {
  const res = await admin.post('/api/admin/services', {
    categoryId: 1, kind: 'main', name, durationMin: 30, cleanupMin: 10, priceMasterKop: 100000, priceTopKop: 120000,
    masterIds: [1], ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.service as { id: number };
}

describe('запись хранит цену и длительность на момент оформления', () => {
  it('правка цены, длительности и названия услуги не меняет созданные записи', async () => {
    const item = one(`SELECT booking_id, service_id, unit_price_kop, price_kop, duration_min FROM booking_items ORDER BY id LIMIT 1`);
    const before = (await admin.get(`/api/bookings/${item.booking_id}`)).body.booking;

    const patch = await admin.patch(`/api/admin/services/${item.service_id}`, {
      priceMasterKop: 9_900_00, priceTopKop: 9_900_00, durationMin: 200,
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const after = (await admin.get(`/api/bookings/${item.booking_id}`)).body.booking;
    assert.deepEqual(after.items, before.items);
    assert.equal(after.totalPriceKop, before.totalPriceKop);
    assert.equal(after.durationMin, before.durationMin);
    assert.deepEqual(
      one('SELECT unit_price_kop, price_kop, duration_min FROM booking_items WHERE booking_id = ? AND service_id = ?', item.booking_id!, item.service_id!),
      { unit_price_kop: item.unit_price_kop, price_kop: item.price_kop, duration_min: item.duration_min },
    );
  });
});

describe('удаление услуги решает сервер', () => {
  it('услугу с записями только отключает и объясняет почему; клиент ее больше не видит, администратор видит', async () => {
    const { service_id: id, n } = one(`
      SELECT service_id, count(DISTINCT booking_id) AS n FROM booking_items GROUP BY service_id ORDER BY n DESC LIMIT 1`);
    const res = await admin.delete(`/api/admin/services/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'deactivated');
    assert.match(res.body.message, /есть записи/);
    assert.equal(res.body.bookingsCount, n);
    assert.equal(res.body.service.isActive, false);

    assert.equal(one('SELECT count(*) AS n FROM services WHERE id = ?', id!).n, 1, 'строка услуги осталась');
    const adminList = (await admin.get('/api/admin/services')).body.services;
    assert.equal(adminList.find((s: { id: number }) => s.id === id)?.isActive, false);
    const catalog = (await client.get('/api/services')).body.categories.flatMap((c: { services: { id: number }[] }) => c.services);
    assert.ok(!catalog.some((s: { id: number }) => s.id === id), 'клиент не видит отключенную услугу');
    const masters = await client.get(`/api/masters?services=${id}`);
    assert.equal(masters.status, 400, 'записаться на отключенную услугу нельзя');
    assert.equal(masters.body.error.code, 'SERVICE_INACTIVE');

    // Включить обратно — обычный PATCH
    assert.equal((await admin.patch(`/api/admin/services/${id}`, { isActive: true })).body.service.isActive, true);
  });

  it('услугу без записей удаляет вместе с отметками мастеров', async () => {
    const { id } = await newService('Услуга для удаления');
    assert.equal(one('SELECT count(*) AS n FROM master_services WHERE service_id = ?', id).n, 1);
    const res = await admin.delete(`/api/admin/services/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'deleted');
    assert.equal(one('SELECT count(*) AS n FROM services WHERE id = ?', id).n, 0);
    assert.equal(one('SELECT count(*) AS n FROM master_services WHERE service_id = ?', id).n, 0);
    assert.equal((await admin.delete(`/api/admin/services/${id}`)).status, 404);
  });
});

describe('удаление мастера решает сервер', () => {
  it('мастера с записями только отключает, объясняет почему и показывает предстоящие записи', async () => {
    const { master_id: id } = one('SELECT master_id FROM bookings GROUP BY master_id ORDER BY count(*) DESC LIMIT 1');
    const res = await admin.delete(`/api/admin/masters/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'deactivated');
    assert.match(res.body.message, /отключен, а не удален/);
    assert.equal(res.body.master.isActive, false);
    assert.ok(Array.isArray(res.body.upcomingBookings));
    assert.equal(one('SELECT count(*) AS n FROM masters WHERE id = ?', id!).n, 1);

    const forClient = (await client.get('/api/masters')).body.masters;
    assert.ok(!forClient.some((m: { id: number }) => m.id === id), 'клиент не видит отключенного мастера');
    assert.equal((await client.get(`/api/masters/${id}`)).status, 404);
    const forAdmin = (await admin.get('/api/admin/masters')).body.masters;
    assert.equal(forAdmin.find((m: { id: number }) => m.id === id)?.isActive, false, 'администратор видит отключенного');

    assert.equal((await admin.patch(`/api/admin/masters/${id}`, { isActive: true })).body.master.isActive, true);
  });

  it('мастера без записей удаляет вместе с услугами и графиком', async () => {
    const created = await admin.post('/api/admin/masters', {
      name: 'Мастер для удаления', serviceIds: [1, 2],
      schedule: { validFrom: '2027-01-05', days: [{ weekday: 2, start: '10:00', end: '18:00' }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.master.id as number;
    const res = await admin.delete(`/api/admin/masters/${id}`);
    assert.equal(res.body.result, 'deleted');
    for (const table of ['masters', 'master_services', 'master_weekly_hours']) {
      const column = table === 'masters' ? 'id' : 'master_id';
      assert.equal(one(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`, id).n, 0, table);
    }
  });
});

describe('формы проверяются на сервере', () => {
  const base = { categoryId: 1, kind: 'main', name: 'Проверка', durationMin: 30, priceMasterKop: 100000, priceTopKop: 100000 };
  const fields = (res: { body: { error: { details?: { fields?: { field: string }[] } } } }) =>
    (res.body.error.details?.fields ?? []).map((f) => f.field);

  for (const [what, body, field] of [
    ['пустое название', { ...base, name: '   ' }, 'name'],
    ['цена у мастера 0', { ...base, priceMasterKop: 0 }, 'priceMasterKop'],
    ['цена у топ-мастера 0', { ...base, priceMasterKop: 0, priceTopKop: 0 }, 'priceTopKop'],
    ['отрицательная цена', { ...base, priceMasterKop: -100 }, 'priceMasterKop'],
    ['длительность 0', { ...base, durationMin: 0 }, 'durationMin'],
    ['отрицательная длительность', { ...base, durationMin: -30 }, 'durationMin'],
  ] as const) {
    it(`новая услуга: ${what} — 400`, async () => {
      const res = await admin.post('/api/admin/services', body);
      assert.equal(res.status, 400);
      assert.ok(fields(res).includes(field), JSON.stringify(res.body));
    });
  }

  it('изменение услуги: цена 0, длительность 0 и пустое название — 400, услуга не меняется', async () => {
    const { id } = await newService('Проверка изменения');
    for (const [body, field] of [[{ priceMasterKop: 0 }, 'priceMasterKop'], [{ durationMin: 0 }, 'durationMin'], [{ name: '' }, 'name']] as const) {
      const res = await admin.patch(`/api/admin/services/${id}`, body);
      assert.equal(res.status, 400);
      assert.ok(fields(res).includes(field), JSON.stringify(res.body));
    }
    assert.deepEqual(one('SELECT name, price_master_kop, duration_min FROM services WHERE id = ?', id),
      { name: 'Проверка изменения', price_master_kop: 100000, duration_min: 30 });
  });

  it('мастер: пустое имя — 400', async () => {
    assert.equal((await admin.post('/api/admin/masters', { name: ' ' })).status, 400);
    assert.equal((await admin.patch('/api/admin/masters/1', { name: '' })).status, 400);
  });
});

describe('выбор мастера клиентом учитывает услуги мастера', () => {
  it('мастер без отмеченной услуги не предлагается, с отмеченной — предлагается', async () => {
    const { id } = await newService('Только у одного мастера', { masterIds: [] });
    const ids = async () => ((await client.get(`/api/masters?services=${id}`)).body.masters as { id: number }[]).map((m) => m.id);
    assert.deepEqual(await ids(), []);

    const master = (await admin.get('/api/admin/masters')).body.masters.find((m: { isActive: boolean }) => m.isActive);
    await admin.patch(`/api/admin/masters/${master.id}`, { serviceIds: [...master.serviceIds, id] });
    assert.deepEqual(await ids(), [master.id]);

    await admin.patch(`/api/admin/masters/${master.id}`, { serviceIds: master.serviceIds });
    assert.deepEqual(await ids(), []);
  });
});
