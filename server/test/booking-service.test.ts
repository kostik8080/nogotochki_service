// Одна функция на действие с записью для всех ролей (booking/booking-service.ts):
//   * в коде приложения нет второго места, которое вставляет запись или меняет ее время и статус;
//   * клиент, мастер и администратор проходят через одни и те же функции, права различаются внутри них;
//   * удаление аккаунта отменяет записи той же функцией, что и кнопка «Отменить».
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { insertBookingRows } from '../src/booking/booking-service.js';
import { SERVER_ROOT } from '../src/config.js';
import { openDatabase, transaction } from '../src/db/connection.js';
import { at, nextWeekday, PASSWORDS, startApi, type TestApi } from './helpers/api.js';

const SERVICE_FILE = path.join('src', 'booking', 'booking-service.ts');

/** Все .ts приложения: src/ и scripts/. Тестовые данные (src/db/seed) входят — они тоже обязаны писать через сервис. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return file.endsWith('.ts') ? [file] : [];
  });
}

describe('единственный путь записи в базу', () => {
  it('записи, их состав и история пишутся только в booking-service.ts', () => {
    const writes = [
      /INSERT INTO (bookings|booking_items|booking_events)\b/,
      /UPDATE (bookings SET [^`'"]*\b(status|master_id|starts_at|ends_at|busy_until|price_level)\b|booking_items\b)/,
      /insert\(\s*'(bookings|booking_items|booking_events)'/,
    ];
    const offenders: string[] = [];
    for (const file of [...sourceFiles(path.join(SERVER_ROOT, 'src')), ...sourceFiles(path.join(SERVER_ROOT, 'scripts'))]) {
      const relative = path.relative(SERVER_ROOT, file);
      if (relative === SERVICE_FILE) continue;
      const text = readFileSync(file, 'utf8');
      for (const pattern of writes) {
        const m = pattern.exec(text);
        if (m) offenders.push(`${relative}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [], 'запись в bookings, booking_items или booking_events мимо booking-service.ts');
  });
});

describe('одни функции для всех ролей', () => {
  let api: TestApi;
  before(async () => {
    api = await startApi();
  });
  after(() => api.close());

  it('мастер проходит через те же функции и получает отказ от них, а не от маршрута', async () => {
    const master = await api.client().login('anna@example.com', PASSWORDS.masterPassword);
    const id = (api.db.prepare("SELECT id FROM bookings WHERE status = 'active' ORDER BY id LIMIT 1").get() as { id: number }).id;
    const date = nextWeekday(3, 9);
    const calls = [
      await master.post('/api/bookings', { masterId: 2, startsAt: at(date, '12:00'), services: [{ serviceId: 12 }] }),
      await master.post(`/api/bookings/${id}/reschedule`, { startsAt: at(date, '15:00') }),
      await master.post(`/api/bookings/${id}/cancel`, {}),
    ];
    for (const res of calls) {
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'MASTER_NO_BOOKING_RIGHTS');
    }
    const status = await master.post(`/api/bookings/${id}/status`, { status: 'completed' });
    assert.equal(status.status, 403);
  });

  it('удаление аккаунта отменяет записи той же функцией: событие, версия, и даже позднее чем за сутки', async () => {
    const c = api.client();
    await c.post('/api/auth/register', { name: 'Уходит', email: 'leaving@example.com', password: 'password-1234', pdConsent: true });
    const clientId = (await c.get('/api/auth/me')).body.user.id;
    const admin = await api.client().login('admin@example.com', PASSWORDS.adminPassword);
    // Запись через 5 часов: сама клиентка ее уже не отменила бы (правило 24 часов).
    const soon = new Date(Math.ceil((Date.now() + 5 * 3600_000) / 3600_000) * 3600_000).toISOString();
    const adminId = (api.db.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").get() as { id: number }).id;
    const bookingId = insertBookingRows(api.db, {
      clientId, masterId: 2, priceLevel: 'master', startsAt: soon, cleanupMin: 0,
      lines: [{ serviceId: 12, name: 'Ламинирование бровей', unitPriceKop: 180_000, quantity: 1, durationMin: 60 }],
      createdBy: adminId, createdAt: new Date().toISOString(),
    });
    assert.equal((await c.post(`/api/bookings/${bookingId}/cancel`, {})).body.error.code, 'CHANGE_DEADLINE_PASSED');

    assert.equal((await c.delete('/api/profile', { password: 'password-1234' })).status, 204);
    const booking = (await admin.get(`/api/bookings/${bookingId}`)).body.booking;
    assert.equal(booking.status, 'cancelled_by_client');
    assert.equal(booking.version, 2);
    const cancel = booking.events.find((e: { type: string }) => e.type === 'cancelled');
    assert.equal(cancel.reason, 'Клиент удалил аккаунт');
    assert.equal(cancel.actor.id, clientId);
  });
});

describe('вложенная транзакция', () => {
  it('ошибка внутри вложенной transaction() откатывает только ее изменения', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (v INTEGER) STRICT');
    transaction(db, () => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      assert.throws(() => transaction(db, () => {
        db.prepare('INSERT INTO t VALUES (2)').run();
        throw new Error('отказ');
      }));
      transaction(db, () => db.prepare('INSERT INTO t VALUES (3)').run());
    });
    assert.deepEqual((db.prepare('SELECT v FROM t ORDER BY v').all() as { v: number }[]).map((r) => r.v), [1, 3]);
  });
});
