// Тесты второй части API: восстановление пароля, профиль и удаление аккаунта, статусы визита, баннер
// «изменено студией», расписание (блокировки, смены, особые дни), клиентская база, фото, настройки.
// Письма не отправляются, а складываются в память (MemoryMailer). SMS в сервисе нет: телефон и сброс пароля
// без e-mail подтверждает администратор кодом, который он диктует по телефону.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { insertBookingRows } from '../src/booking/booking-service.js';
import type { Db } from '../src/db/connection.js';
import { at, type Client, nextWeekday, PASSWORDS, startApi, type TestApi } from './helpers/api.js';

const ANNA = 1;
const MARINA = 2;
const LAMINATION = 12;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

let api: TestApi;
let db: Db;
let admin: Client;
const fresh = () => api.client();
const FRI = nextWeekday(5, 9);
const WED = nextWeekday(3, 9);

before(async () => {
  api = await startApi();
  db = api.db;
  admin = await fresh().login('admin@example.com', PASSWORDS.adminPassword);
});
after(() => api.close());

/** Новый клиент с паролем и открытой сессией. */
async function register(email: string, extra: Record<string, unknown> = {}): Promise<Client> {
  const c = fresh();
  const res = await c.post('/api/auth/register', { name: 'Тест', email, password: 'password-1234', pdConsent: true, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return c;
}

/** Запись клиента к Марине через бронь, как в интерфейсе. */
async function book(client: Client, date: string, time: string): Promise<number> {
  const startsAt = at(date, time);
  const hold = await client.post('/api/holds', { masterId: MARINA, startsAt, services: [{ serviceId: LAMINATION }] });
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
  const res = await client.post('/api/bookings', { masterId: MARINA, startsAt, services: [{ serviceId: LAMINATION }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.booking.id;
}

/** Прошедшая действующая запись: через API в прошлое не записаться, поэтому — функцией записи строк сервиса. */
function pastBooking(clientEmail: string, daysAgo: number): number {
  const clientId = (db.prepare('SELECT id FROM users WHERE email = ?').get(clientEmail) as { id: number }).id;
  const start = new Date(Math.floor(Date.now() / 3600_000) * 3600_000 - daysAgo * 86_400_000 - 7 * 3600_000);
  return insertBookingRows(db, {
    clientId, masterId: MARINA, priceLevel: 'master', startsAt: start.toISOString(), cleanupMin: 0,
    lines: [{ serviceId: LAMINATION, name: 'Ламинирование бровей', unitPriceKop: 180_000, quantity: 1, durationMin: 60 }],
    createdBy: clientId, createdAt: start.toISOString(),
  });
}

describe('восстановление пароля', () => {
  it('ссылка на e-mail задает новый пароль и закрывает старые сессии; ссылка одноразовая', async () => {
    const other = await register('reset@example.com');
    const res = await fresh().post('/api/auth/password-reset/request', { login: 'Reset@Example.com' });
    assert.equal(res.status, 202);
    const mail = api.mailer.sent.at(-1)!;
    assert.equal(mail.to, 'reset@example.com');
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    assert.match(mail.text, /^[\s\S]*https:\/\/nogotochki\.test\/reset-password\?token=/);

    assert.equal((await fresh().post('/api/auth/password-reset/confirm', { token, password: 'new-password-1' })).status, 204);
    assert.equal((await other.get('/api/auth/me')).status, 401);
    await fresh().login('reset@example.com', 'new-password-1');
    const again = await fresh().post('/api/auth/password-reset/confirm', { token, password: 'another-password' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'INVALID_CODE');
  });

  it('на чужой адрес ответ тот же, письма нет; повторный запрос в течение минуты не шлет второе письмо', async () => {
    const before = api.mailer.sent.length;
    assert.equal((await fresh().post('/api/auth/password-reset/request', { login: 'nobody@example.com' })).status, 202);
    assert.equal(api.mailer.sent.length, before);
    await register('resend@example.com');
    await fresh().post('/api/auth/password-reset/request', { login: 'resend@example.com' });
    await fresh().post('/api/auth/password-reset/request', { login: 'resend@example.com' });
    assert.equal(api.mailer.sent.length, before + 1);
  });

  it('без e-mail в аккаунте код для сброса выдает администратор; после трех неверных попыток код не действует', async () => {
    const c = await register('x@example.com', { phone: '+79001112233' });
    // Аккаунт только с телефоном: e-mail убираем напрямую, как у клиента, зарегистрированного по номеру.
    db.prepare("UPDATE users SET email = NULL WHERE email = 'x@example.com'").run();
    const mails = api.mailer.sent.length;
    const req = await fresh().post('/api/auth/password-reset/request', { login: '+7 900 111-22-33' });
    assert.equal(req.status, 202);
    assert.match(req.body.message, /позвоните в студию/);
    assert.equal(api.mailer.sent.length, mails); // письма некуда отправить

    const userId = (await c.get('/api/auth/me')).body.user.id;
    assert.equal((await fresh().login('maria@example.com', PASSWORDS.clientPassword).then((m) => m.post(`/api/admin/users/${userId}/password-reset-code`))).status, 403);
    const issued = await admin.post(`/api/admin/users/${userId}/password-reset-code`);
    assert.equal(issued.status, 201);
    assert.equal(issued.body.login, '+79001112233');
    const code = issued.body.code as string;
    const wrong = code === '000000' ? '111111' : '000000';
    const first = await fresh().post('/api/auth/password-reset/confirm', { login: '+79001112233', code: wrong, password: 'new-password-1' });
    assert.equal(first.status, 400);
    assert.equal(first.body.error.details.attemptsLeft, 2);
    await fresh().post('/api/auth/password-reset/confirm', { login: '+79001112233', code: wrong, password: 'new-password-1' });
    await fresh().post('/api/auth/password-reset/confirm', { login: '+79001112233', code: wrong, password: 'new-password-1' });
    const right = await fresh().post('/api/auth/password-reset/confirm', { login: '+79001112233', code, password: 'new-password-1' });
    assert.equal(right.status, 400);

    // Новый код от администратора работает, старые сессии закрываются.
    const again = await admin.post(`/api/admin/users/${userId}/password-reset-code`);
    const ok = await fresh().post('/api/auth/password-reset/confirm', { login: '+79001112233', code: again.body.code, password: 'new-password-1' });
    assert.equal(ok.status, 204);
    assert.equal((await c.get('/api/auth/me')).status, 401);
    await fresh().login('+79001112233', 'new-password-1');
  });
});

describe('профиль', () => {
  it('имя, смена пароля: другие сессии закрываются, текущая остается', async () => {
    const c = await register('profile@example.com');
    const other = await fresh().login('profile@example.com', 'password-1234');
    assert.equal((await c.patch('/api/profile', { name: 'Новое имя', marketingConsent: true })).body.user.marketingConsent, true);
    const wrong = await c.post('/api/profile/password', { currentPassword: 'nope', newPassword: 'changed-pass-1' });
    assert.equal(wrong.status, 403);
    assert.equal((await c.post('/api/profile/password', { currentPassword: 'password-1234', newPassword: 'changed-pass-1' })).status, 204);
    assert.equal((await c.get('/api/auth/me')).body.user.name, 'Новое имя');
    assert.equal((await other.get('/api/auth/me')).status, 401);
  });

  it('новый e-mail записывается только после кода; занятый адрес — 409', async () => {
    const c = await register('old-mail@example.com');
    assert.equal((await c.post('/api/profile/email', { email: 'maria@example.com' })).status, 409);
    const sent = await c.post('/api/profile/email', { email: 'New-Mail@example.com' });
    assert.equal(sent.status, 202);
    assert.equal((await c.post('/api/profile/email', { email: 'new-mail@example.com' })).status, 429);
    const code = /(\d{6})/.exec(api.mailer.sent.at(-1)!.text)![1]!;
    assert.equal((await c.get('/api/auth/me')).body.user.email, 'old-mail@example.com');
    const bad = await c.post('/api/profile/email/confirm', { code: code === '999999' ? '000000' : '999999' });
    assert.equal(bad.status, 400);
    const ok = await c.post('/api/profile/email/confirm', { code });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, 'new-mail@example.com');
    assert.equal(ok.body.user.emailVerified, true);
  });

  it('новый телефон подтверждает администратор: клиент запрашивает, администратор диктует код', async () => {
    const c = await register('phone@example.com');
    const userId = (await c.get('/api/auth/me')).body.user.id;
    assert.equal((await admin.post(`/api/admin/users/${userId}/phone-code`)).body.error.code, 'NO_PENDING_REQUEST');
    assert.equal((await c.post('/api/profile/phone', { phone: '+79035556677' })).status, 409); // Ольга, записанная по звонку
    const requested = await c.post('/api/profile/phone', { phone: '8 912 000-11-22' });
    assert.equal(requested.status, 202);
    assert.equal(requested.body.delivery, 'studio');
    assert.equal((await c.get('/api/auth/me')).body.user.phone, null); // до подтверждения номер не меняется

    const card = await admin.get(`/api/admin/clients/${userId}`);
    assert.equal(card.body.client.pendingPhoneConfirmation.phone, '+79120001122');
    const issued = await admin.post(`/api/admin/users/${userId}/phone-code`);
    assert.equal(issued.body.phone, '+79120001122');
    assert.equal(issued.body.purpose, 'change_phone');
    const code = issued.body.code as string;
    const ok = await c.post('/api/profile/phone/confirm', { code });
    assert.equal(ok.body.user.phone, '+79120001122');
    assert.equal(ok.body.user.phoneVerified, true);
  });

  it('удаление аккаунта обезличивает клиента и отменяет предстоящие записи', async () => {
    const c = await register('delete-me@example.com', { phone: '+79005554433' });
    const bookingId = await book(c, WED, '11:00');
    assert.equal((await c.delete('/api/profile', { password: 'wrong' })).status, 403);
    assert.equal((await c.delete('/api/profile', { password: 'password-1234' })).status, 204);
    assert.equal(c.cookie, null);

    const user = db.prepare("SELECT name, phone, email, password_hash, deleted_at FROM users WHERE id = (SELECT client_id FROM bookings WHERE id = ?)")
      .get(bookingId) as { name: string; phone: null; email: null; password_hash: null; deleted_at: string };
    assert.deepEqual({ ...user, deleted_at: typeof user.deleted_at }, { name: 'Удаленный клиент', phone: null, email: null, password_hash: null, deleted_at: 'string' });
    const booking = (await admin.get(`/api/bookings/${bookingId}`)).body.booking;
    assert.equal(booking.status, 'cancelled_by_client');
    assert.equal(booking.client.name, 'Удаленный клиент');
    assert.equal((await fresh().post('/api/auth/login', { login: 'delete-me@example.com', password: 'password-1234' })).status, 401);
    // Освободившийся номер можно зарегистрировать заново.
    await register('reborn@example.com', { phone: '+79005554433' });
  });

  it('администратор аккаунт через профиль не удаляет — 403', async () => {
    assert.equal((await admin.delete('/api/profile', { password: PASSWORDS.adminPassword })).status, 403);
  });
});

describe('статусы визита и баннер «изменено студией»', () => {
  it('«Завершена» и «Клиент не пришел» — только для начавшегося визита, с историей', async () => {
    const future = await book(await register('status@example.com'), WED, '15:00');
    const early = await admin.post(`/api/bookings/${future}/status`, { status: 'completed' });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'VISIT_NOT_STARTED');

    const past = pastBooking('status@example.com', 2);
    const done = await admin.post(`/api/bookings/${past}/status`, { status: 'completed' });
    assert.equal(done.status, 200);
    assert.equal(done.body.booking.status, 'completed');
    const fixed = await admin.post(`/api/bookings/${past}/status`, { status: 'no_show', reason: 'Ошибочная отметка' });
    assert.equal(fixed.body.booking.status, 'no_show');
    assert.deepEqual(fixed.body.booking.events.map((e: { newStatus: string }) => e.newStatus), ['completed', 'no_show']);
    const client = await fresh().login('status@example.com', 'password-1234');
    assert.equal((await client.post(`/api/bookings/${past}/status`, { status: 'completed' })).status, 403);
  });

  it('отмена студией показывает клиенту баннер, пока он его не закроет', async () => {
    const client = await register('banner@example.com');
    const id = await book(client, WED, '17:00');
    assert.equal((await admin.post(`/api/bookings/${id}/cancel`, { reason: 'Мастер заболела' })).status, 200);
    const list = await client.get('/api/bookings');
    assert.equal(list.body.bookings[0].studioChange.type, 'cancelled');
    const ack = await client.post(`/api/bookings/${id}/acknowledge`);
    assert.equal(ack.status, 200);
    assert.equal(ack.body.booking.studioChange, null);
  });
});

describe('расписание: блокировки, смены мастера, особые дни студии', () => {
  it('сценарий 8: блокировка убирает слоты и возвращает задетые записи; dryRun ничего не сохраняет', async () => {
    const bookingId = await book(await register('vacation@example.com'), FRI, '11:00');
    const body = { masterId: MARINA, type: 'vacation', startsAt: at(FRI, '00:00'), endsAt: at(FRI, '23:59'), comment: 'Отпуск' };
    const preview = await admin.post('/api/admin/time-blocks', { ...body, dryRun: true });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.affectedBookings.map((b: { id: number }) => b.id), [bookingId]);
    assert.ok((await fresh().get(`/api/masters/${MARINA}/slots?date=${FRI}&services=${LAMINATION}`)).body.slots.length > 0);

    const created = await admin.post('/api/admin/time-blocks', body);
    assert.equal(created.status, 201);
    assert.equal(created.body.affectedBookings[0].client.email, 'vacation@example.com');
    assert.deepEqual((await fresh().get(`/api/masters/${MARINA}/slots?date=${FRI}&services=${LAMINATION}`)).body.slots, []);
    assert.equal((await admin.delete(`/api/admin/time-blocks/${created.body.timeBlock.id}`)).status, 204);

    const other = await admin.post('/api/admin/time-blocks', { ...body, type: 'other', comment: null });
    assert.equal(other.status, 400);
  });

  it('смена мастера на дату: выходной в рабочий день и отмена изменения', async () => {
    const date = nextWeekday(3, 20);
    const off = await admin.put(`/api/admin/masters/${ANNA}/days/${date}`, { isWorking: false });
    assert.equal(off.status, 200);
    assert.equal((await fresh().get(`/api/masters/${ANNA}/slots?date=${date}&services=1`)).body.day.status, 'master_off');
    assert.equal((await admin.delete(`/api/admin/masters/${ANNA}/days/${date}`)).status, 200);
    assert.equal((await fresh().get(`/api/masters/${ANNA}/slots?date=${date}&services=1`)).body.day.status, 'open');
    assert.equal((await admin.put(`/api/admin/masters/${ANNA}/days/${date}`, { isWorking: true, start: '12:00', end: '11:00' })).status, 400);
  });

  it('особый день студии закрывает запись для всех мастеров и виден клиентам с причиной', async () => {
    const date = nextWeekday(6, 25);
    const res = await admin.put(`/api/admin/studio-days/${date}`, { isOpen: false, reason: 'Ремонт' });
    assert.equal(res.status, 200);
    const slots = await fresh().get(`/api/masters/${MARINA}/slots?date=${date}&services=${LAMINATION}`);
    assert.deepEqual(slots.body.day, { status: 'studio_closed', reason: 'Ремонт' });
    const days = await fresh().get(`/api/studio/days?from=${date}&to=${date}`);
    assert.deepEqual(days.body.days, [{ date, isOpen: false, open: null, close: null, reason: 'Ремонт' }]);
    assert.equal((await admin.put('/api/admin/studio-days/2020-01-01', { isOpen: false, reason: 'Прошлое' })).status, 400);
    assert.equal((await fresh().put(`/api/admin/studio-days/${date}`, { isOpen: false, reason: 'x' })).status, 401);
  });

  it('смену мастера нельзя открыть, когда студия в этот день не работает', async () => {
    // Закрытый особый день: смену открыть нельзя, выходной поставить можно.
    const closed = nextWeekday(4, 30);
    assert.equal((await admin.put(`/api/admin/studio-days/${closed}`, { isOpen: false, reason: 'Санитарный день' })).status, 200);
    const denied = await admin.put(`/api/admin/masters/${ANNA}/days/${closed}`, { isWorking: true, start: '10:00', end: '16:00' });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error.code, 'STUDIO_CLOSED');
    assert.match(denied.body.error.message, /Санитарный день/);
    assert.deepEqual((await admin.get(`/api/admin/masters/${ANNA}/days?from=${closed}&to=${closed}`)).body.days, []);
    assert.equal((await admin.put(`/api/admin/masters/${ANNA}/days/${closed}`, { isWorking: false })).status, 200);

    // Воскресенье: студия закрыта по режиму работы, особого дня нет.
    const sunday = nextWeekday(7, 20);
    const sundayDenied = await admin.put(`/api/admin/masters/${ANNA}/days/${sunday}`, { isWorking: true, start: '10:00', end: '16:00' });
    assert.equal(sundayDenied.status, 400);
    assert.equal(sundayDenied.body.error.code, 'STUDIO_CLOSED');

    // Рабочий день студии: смена открывается как раньше.
    const open = nextWeekday(3, 30);
    assert.equal((await admin.put(`/api/admin/masters/${ANNA}/days/${open}`, { isWorking: true, start: '10:00', end: '16:00' })).status, 200);
    assert.equal((await admin.delete(`/api/admin/masters/${ANNA}/days/${open}`)).status, 200);
  });
});

describe('клиентская база', () => {
  it('поиск по имени без учета регистра кириллицы и по цифрам телефона; метка «Новый»', async () => {
    const byName = await admin.get('/api/admin/clients?search=' + encodeURIComponent('мария'));
    assert.deepEqual(byName.body.clients.map((c: { name: string }) => c.name), ['Мария Кузнецова']);
    const byPhone = await admin.get('/api/admin/clients?search=903%20555');
    assert.equal(byPhone.body.clients[0].name, 'Ольга Белова');
    assert.deepEqual(byPhone.body.clients[0].tags, ['new']);
    assert.equal((await fresh().login('maria@example.com', PASSWORDS.clientPassword).then((c) => c.get('/api/admin/clients'))).status, 403);
  });

  it('карточка клиента: статистика, история с фото, заметки', async () => {
    const mariaId = (db.prepare("SELECT id FROM users WHERE email = 'maria@example.com'").get() as { id: number }).id;
    const card = (await admin.get(`/api/admin/clients/${mariaId}`)).body.client;
    assert.equal(card.stats.visits, 2);
    assert.equal(card.stats.noShows, 1);
    assert.equal(card.stats.cancellations, 2);
    assert.equal(card.profile.importantNote, 'Предпочитает короткую форму ногтей');
    assert.ok(card.bookings.some((b: { photoCount: number }) => b.photoCount === 1));
    assert.equal(card.notes[0].master.name, 'Анна Ковалева');
  });

  it('новый клиент, поля карточки, черный список с причиной и заметки', async () => {
    const created = await admin.post('/api/admin/clients', { name: 'Вера', phone: '+79007778899' });
    assert.equal(created.status, 201);
    const id = created.body.client.id;
    assert.equal(created.body.client.hasAccount, false);
    assert.equal((await admin.post('/api/admin/clients', { name: 'Дубль', phone: '+79007778899' })).status, 409);

    const patched = await admin.patch(`/api/admin/clients/${id}`, { birthDate: '1990-04-01', importantNote: 'Любит френч' });
    assert.equal(patched.body.client.profile.birthDate, '1990-04-01');
    assert.equal((await admin.put(`/api/admin/clients/${id}/blacklist`, {})).status, 400);
    const listed = await admin.put(`/api/admin/clients/${id}/blacklist`, { reason: 'Три неявки подряд' });
    assert.equal(listed.body.client.blacklist.reason, 'Три неявки подряд');
    assert.equal((await admin.get('/api/admin/clients?filter=blacklist')).body.clients[0].id, id);
    assert.equal((await admin.delete(`/api/admin/clients/${id}/blacklist`)).body.client.blacklist, null);

    const note = await admin.post(`/api/admin/clients/${id}/notes`, { text: 'Просила напомнить о коррекции', masterId: MARINA });
    assert.equal(note.status, 201);
    assert.equal(note.body.note.master.id, MARINA);
    assert.equal((await admin.delete(`/api/admin/clients/${id}/notes/${note.body.note.id}`)).status, 204);
  });

  it('закрытый доступ: сессии закрываются, вход — 403, после открытия — снова можно', async () => {
    const c = await register('blocked@example.com');
    const id = (await c.get('/api/auth/me')).body.user.id;
    assert.equal((await admin.put(`/api/admin/users/${id}/block`)).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401);
    const login = await fresh().post('/api/auth/login', { login: 'blocked@example.com', password: 'password-1234' });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'ACCOUNT_BLOCKED');
    assert.equal((await admin.delete(`/api/admin/users/${id}/block`)).status, 200);
    await fresh().login('blocked@example.com', 'password-1234');
  });
});

describe('фото работ', () => {
  let itemId: number;
  let photoId: number;

  it('загрузка к завершенному визиту; к незавершенному — 409; не картинка — 415; без входа — 401', async () => {
    const completed = db.prepare(`
      SELECT bi.id FROM booking_items bi JOIN bookings b ON b.id = bi.booking_id WHERE b.status = 'completed' ORDER BY bi.id LIMIT 1
    `).get() as { id: number };
    const active = db.prepare(`
      SELECT bi.id FROM booking_items bi JOIN bookings b ON b.id = bi.booking_id WHERE b.status = 'active' ORDER BY bi.id LIMIT 1
    `).get() as { id: number };
    itemId = completed.id;

    const png = { 'Content-Type': 'image/png' };
    assert.equal((await fresh().request('POST', `/api/admin/photos?bookingItemId=${itemId}`, PNG, png)).status, 401);
    assert.equal((await admin.request('POST', `/api/admin/photos?bookingItemId=${active.id}`, PNG, png)).status, 409);
    assert.equal((await admin.request('POST', `/api/admin/photos?bookingItemId=${itemId}`, Buffer.from('<html>'), png)).status, 415);
    assert.equal((await admin.request('POST', `/api/admin/photos?bookingItemId=${itemId}`, PNG, { 'Content-Type': 'text/html' })).status, 415);

    const res = await admin.request('POST', `/api/admin/photos?bookingItemId=${itemId}&title=${encodeURIComponent('Нюд')}`, PNG, png);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    photoId = res.body.photo.id;
    assert.equal(res.body.photo.isPublished, false);
  });

  it('без согласия клиента фото с визита не публикуется; с согласием — попадает в галерею', async () => {
    const denied = await admin.patch(`/api/admin/photos/${photoId}`, { isPublished: true });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, 'CONSENT_REQUIRED');
    assert.equal((await fresh().get(`/api/photos/${photoId}/file`)).status, 404);
    assert.equal((await admin.get(`/api/photos/${photoId}/file`)).status, 200);

    const published = await admin.patch(`/api/admin/photos/${photoId}`, { publishConsent: true, isPublished: true });
    assert.equal(published.status, 200);
    const gallery = await fresh().get('/api/gallery');
    assert.ok(gallery.body.photos.some((p: { id: number; title: string }) => p.id === photoId && p.title === 'Нюд'));
    const file = await fresh().get(`/api/photos/${photoId}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.ok((file.body as Buffer).equals(PNG));

    // Отзыв согласия снимает фото с публикации.
    const withdrawn = await admin.patch(`/api/admin/photos/${photoId}`, { publishConsent: false });
    assert.equal(withdrawn.body.photo.isPublished, false);
  });

  it('удаление фото удаляет и файл', async () => {
    const row = db.prepare('SELECT file_path FROM work_photos WHERE id = ?').get(photoId) as { file_path: string };
    const file = path.join(api.uploadsDir, row.file_path);
    assert.ok(existsSync(file));
    assert.equal((await admin.delete(`/api/admin/photos/${photoId}`)).status, 204);
    assert.ok(!existsSync(file));
  });
});

describe('настройки студии', () => {
  it('администратор меняет контакты и правила записи; неверные значения — 400; клиенту — 403', async () => {
    const res = await admin.patch('/api/admin/settings', { phone: '+7 (999) 000-00-01', slotHoldMin: 15, vkUrl: 'https://vk.com/nogotochki' });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.phone, '+79990000001');
    assert.equal(res.body.settings.slotHoldMin, 15);
    assert.equal((await fresh().get('/api/studio')).body.rules.slotHoldMin, 15);

    const bad = await admin.patch('/api/admin/settings', { timezone: 'Mars/Olympus', vkUrl: 'javascript:alert(1)' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.error.details.fields.map((f: { field: string }) => f.field).sort(), ['timezone', 'vkUrl']);
    const maria = await fresh().login('maria@example.com', PASSWORDS.clientPassword);
    assert.equal((await maria.get('/api/admin/settings')).status, 403);
  });

  it('режим работы по дням недели: dryRun показывает записи, которые не помещаются', async () => {
    const res = await admin.put('/api/admin/studio-hours', {
      days: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: '10:00', close: '12:00' })), dryRun: true,
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.affectedBookings.length > 0);
    assert.equal(res.body.settings.hours[0].close, '20:00'); // не сохранено
  });
});
