// Свое фото у мастера и у клиента (миграция 010, решение заказчика 08.10.2026).
//   * мастер загружает портрет сам, но на сайт он попадает только после одобрения администратора:
//     до решения в профиле остается прежнее фото, а заявка лежит среди обычных заявок мастера;
//   * отклонение и отзыв фото на сайт не выпускают; убрать свой портрет мастер может без одобрения;
//   * фото клиента — его персональные данные: видят сам клиент, администратор и мастер, у которого
//     есть запись этого клиента; посторонний мастер и чужой клиент получают 403;
//   * удаление аккаунта стирает фото клиента вместе с остальными его данными (152-ФЗ, сценарий 17).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Client, PASSWORDS, startApi, type TestApi } from './helpers/api.js';

let api: TestApi;
let admin: Client;
let master: Client;
let client: Client;

/** Анна Ковалева — единственная учетная запись мастера в тестовых данных. */
const ANNA = 1;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 9)]);
const png = { 'Content-Type': 'image/png' };

before(async () => {
  api = await startApi();
  admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
  master = await api.client().login('anna@example.com', PASSWORDS.masterPassword);
  client = await api.client().login('maria@example.com', PASSWORDS.clientPassword);
});
after(() => api.close());

const uploadMasterPhoto = (who: Client, body: Buffer = PNG) => who.request('POST', '/api/master/photo', body, png);

describe('фото мастера', () => {
  it('загрузка создает заявку и на сайт сразу не выпускает', async () => {
    const res = await uploadMasterPhoto(master);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.request.type, 'photo');
    assert.equal(res.body.request.status, 'pending');
    assert.equal(res.body.request.photoUrl, `/api/requests/${res.body.request.id}/photo`);

    // В публичном профиле портрета еще нет: решение за администратором
    assert.equal((await api.client().get(`/api/masters/${ANNA}`)).body.master.photoUrl, null);
    assert.equal((await api.client().get(`/api/masters/${ANNA}/photo`)).status, 404);

    // Заявка видна и мастеру, и администратору — среди обычных заявок, со счетчиком новых
    assert.ok((await master.get('/api/master/requests')).body.requests.some((r: any) => r.id === res.body.request.id));
    const forAdmin = await admin.get('/api/admin/requests?status=pending');
    assert.ok(forAdmin.body.requests.some((r: any) => r.id === res.body.request.id));
    assert.ok(forAdmin.body.pendingCount >= 1);

    // Файл заявки отдается администратору и самому мастеру, но не постороннему
    const seen = await admin.get(`/api/requests/${res.body.request.id}/photo`);
    assert.equal(seen.status, 200);
    assert.ok((seen.body as Buffer).equals(PNG));
    assert.equal((await master.get(`/api/requests/${res.body.request.id}/photo`)).status, 200);
    assert.equal((await client.get(`/api/requests/${res.body.request.id}/photo`)).status, 403);

    // Второе фото, пока первое на рассмотрении, не принимается
    assert.equal((await uploadMasterPhoto(master)).status, 409);

    // Одобрение ставит портрет в профиль — он виден всем, в том числе гостю
    assert.equal((await admin.post(`/api/admin/requests/${res.body.request.id}/approve`, {})).status, 200);
    const profile = await api.client().get(`/api/masters/${ANNA}`);
    assert.equal(profile.body.master.photoUrl, `/api/masters/${ANNA}/photo`);
    const file = await api.client().get(`/api/masters/${ANNA}/photo`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.ok((file.body as Buffer).equals(PNG));
  });

  it('отклоненное фото на сайт не попадает, а мастер видит причину', async () => {
    const before = (await api.client().get(`/api/masters/${ANNA}`)).body.master.photoUrl;
    const created = await uploadMasterPhoto(master, JPEG);
    assert.equal(created.status, 201);
    assert.equal((await admin.post(`/api/admin/requests/${created.body.request.id}/reject`,
      { reason: 'Фото не в фокусе' })).status, 200);

    // Портрет остался прежним, а мастер видит отказ с причиной
    assert.equal((await api.client().get(`/api/masters/${ANNA}`)).body.master.photoUrl, before);
    const mine = (await master.get('/api/master/requests')).body.requests.find((r: any) => r.id === created.body.request.id);
    assert.equal(mine.status, 'rejected');
    assert.equal(mine.decision.reason, 'Фото не в фокусе');
  });

  it('отозванную заявку администратор не увидит, а свой портрет мастер снимает без одобрения', async () => {
    const created = await uploadMasterPhoto(master);
    assert.equal(created.status, 201);
    assert.equal((await master.post(`/api/master/requests/${created.body.request.id}/cancel`, {})).status, 200);
    // Файл отозванной заявки удален вместе с ней
    assert.equal((await admin.get(`/api/requests/${created.body.request.id}/photo`)).status, 404);

    assert.equal((await master.delete('/api/master/photo')).status, 204);
    assert.equal((await api.client().get(`/api/masters/${ANNA}`)).body.master.photoUrl, null);
    // Снимать нечего — 404, а не молчаливый успех
    assert.equal((await master.delete('/api/master/photo')).status, 404);
  });

  it('не изображение и чужая роль не принимаются', async () => {
    assert.equal((await master.request('POST', '/api/master/photo', Buffer.from('<html>не картинка</html>'), png)).status, 415);
    assert.equal((await client.request('POST', '/api/master/photo', PNG, png)).status, 403);
    assert.equal((await admin.request('POST', '/api/master/photo', PNG, png)).status, 403);
    assert.equal((await api.client().request('POST', '/api/master/photo', PNG, png)).status, 401);
  });
});

describe('фото клиента', () => {
  it('клиент ставит фото сам и видит его в своем профиле', async () => {
    const res = await client.request('POST', '/api/profile/photo', PNG, png);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const me = await client.get('/api/auth/me');
    assert.equal(me.body.user.photoUrl, `/api/clients/${me.body.user.id}/photo`);
    const file = await client.get(me.body.user.photoUrl);
    assert.equal(file.status, 200);
    assert.ok((file.body as Buffer).equals(PNG));
  });

  it('видят только свои, администратор и мастер с записью этого клиента', async () => {
    const id = (await client.get('/api/auth/me')).body.user.id;
    assert.equal((await admin.get(`/api/clients/${id}/photo`)).status, 200);
    // У Анны есть записи Марии в тестовых данных — значит фото ей видно
    assert.equal((await master.get(`/api/clients/${id}/photo`)).status, 200);
    // Чужой клиент и гость — мимо
    const other = await api.client();
    assert.equal((await other.get(`/api/clients/${id}/photo`)).status, 401);
    assert.equal((await admin.get(`/api/admin/clients/${id}`)).body.client.profile.photoUrl, `/api/clients/${id}/photo`);
  });

  it('не изображение не принимается, повторная загрузка заменяет прежнее', async () => {
    assert.equal((await client.request('POST', '/api/profile/photo', Buffer.from('просто текст'), png)).status, 415);
    assert.equal((await client.request('POST', '/api/profile/photo', JPEG, png)).status, 200);
    const id = (await client.get('/api/auth/me')).body.user.id;
    const file = await client.get(`/api/clients/${id}/photo`);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.ok((file.body as Buffer).equals(JPEG));
  });

  it('удаление фото возвращает инициалы', async () => {
    const id = (await client.get('/api/auth/me')).body.user.id;
    assert.equal((await client.delete('/api/profile/photo')).status, 204);
    assert.equal((await client.get('/api/auth/me')).body.user.photoUrl, null);
    assert.equal((await client.get(`/api/clients/${id}/photo`)).status, 404);
    assert.equal((await client.delete('/api/profile/photo')).status, 404);
  });

  it('удаление аккаунта стирает фото клиента', async () => {
    const victim = await api.client();
    const created = await victim.post('/api/auth/register', {
      name: 'Ольга Фотова', email: 'foto-delete@example.com', password: 'foto-password-1', pdConsent: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.user.id as number;
    assert.equal((await victim.request('POST', '/api/profile/photo', PNG, png)).status, 200);
    assert.equal((await admin.get(`/api/clients/${id}/photo`)).status, 200);

    assert.equal((await victim.delete('/api/profile', { password: 'foto-password-1' })).status, 204);
    // Карточки больше нет, фото тоже: у обезличенного клиента не остается ни лица, ни контактов
    assert.equal((await admin.get(`/api/clients/${id}/photo`)).status, 404);
  });
});
