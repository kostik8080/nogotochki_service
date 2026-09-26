// Записи: создание, свои записи, карточка записи, перенос и отмена (паспорт, функции 6–8 клиента,
// функции 5–7 администратора). Записи никогда не удаляются: отмена — это событие в журнале и смена статуса.
import { checkSlot, slotTaken } from '../booking/availability.js';
import { loadBooking, pricesAtLevel } from '../booking/existing.js';
import { readVisitItems, requireMasterForVisit, resolveVisit, unitPrice } from '../booking/visit.js';
import { type Db, transaction } from '../db/connection.js';
import { badRequest, conflict, databaseErrorCode, forbidden, notFound } from '../http/errors.js';
import { pathId, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { addDays, zonedTimeToUtc } from '../lib/studio-time.js';
import { readSettings } from '../studio/settings.js';
import { requireChangeableBooking, requireNotMaintenance, requireRole } from './guards.js';
import { BOOKING_STATUSES, bookingView, bookingViews, type HoldRow } from './views.js';

const MAX_TEXT = 500;

export function bookingRoutes(router: Router): void {
  // Создать запись на удержанное время (BOOK-04, A-02). Клиенту нужна его действующая бронь с тем же
  // мастером и временем (раздел 8, шаг 2). Администратор может записать без брони — по звонку, за клиента
  // из базы (clientId) или за нового клиента без учетной записи (newClient: имя и телефон, сценарий 16).
  router.post('/api/bookings', (ctx): Result => {
    const user = requireRole(ctx, 'client', 'admin');
    const input = Input.body(ctx.body);
    const masterId = input.id('masterId');
    const startsAt = input.instant('startsAt');
    const items = readVisitItems(input);
    const comment = input.string('comment', { optional: true, nullable: true, max: MAX_TEXT }) ?? null;
    const isAnyMaster = input.bool('isAnyMaster', { optional: true }) ?? false;
    const clientId = input.id('clientId', { optional: true });
    const newClient = input.object('newClient', (c) => ({ name: c.string('name', { max: 100 }), phone: c.phone('phone') }), { optional: true });
    if (user.role === 'client' && (input.has('clientId') || input.has('newClient'))) {
      throw forbidden('Клиент записывает только себя');
    }
    if (user.role === 'admin' && !input.has('clientId') && !input.has('newClient')) input.fail('clientId', 'Укажите клиента или нового клиента');
    if (input.has('clientId') && input.has('newClient')) input.fail('newClient', 'Укажите либо clientId, либо newClient');
    input.done();
    requireNotMaintenance(ctx, user);

    const now = ctx.now;
    try {
      const bookingId = transaction(ctx.db, () => {
        const visit = resolveVisit(ctx.db, items);
        const master = requireMasterForVisit(ctx.db, masterId, visit.serviceIds);
        const endsAt = new Date(Date.parse(startsAt) + visit.durationMin * 60_000).toISOString();
        const busyUntil = new Date(Date.parse(endsAt) + visit.cleanupMin * 60_000).toISOString();

        const client = user.role === 'client' ? user.id : resolveClient(ctx.db, clientId, newClient, now);

        // Бронь пользователя. У клиента она обязательна и должна совпадать с тем, что он подтверждает.
        const hold = ctx.db.prepare('SELECT * FROM slot_holds WHERE owner_id = ?').get(user.id) as unknown as HoldRow | undefined;
        const holdMatches = hold !== undefined && hold.booking_id === null && hold.master_id === masterId
          && hold.starts_at === startsAt && hold.ends_at === endsAt && hold.busy_until === busyUntil;
        if (user.role === 'client') {
          if (!hold) throw conflict('HOLD_NOT_FOUND', 'Время не закреплено за вами. Выберите время заново');
          if (hold.expires_at <= now.toISOString()) {
            throw conflict('HOLD_EXPIRED', 'Время брони истекло. Проверьте, свободно ли еще это время');
          }
          if (!holdMatches) throw conflict('HOLD_MISMATCH', 'Бронь не совпадает с выбранными мастером, временем или услугами. Выберите время заново');
        }

        // Повторная проверка в той же транзакции: с момента брони администратор мог добавить блокировку
        // или изменить график (раздел 10.3). Ограничения клиента — 2 часа до визита и горизонт — проверены
        // при создании брони, а бронь гарантирует время, поэтому здесь они не повторяются.
        const check = checkSlot(ctx.db, {
          masterId, startsAt, durationMin: visit.durationMin, cleanupMin: visit.cleanupMin, now, audience: 'admin', viewerId: user.id,
        });
        if (!check.available) throw slotTaken(startsAt, check.slots.map((s) => ({ masterId, startsAt: s.startsAt, endsAt: s.endsAt })));

        // Своя бронь снимается до вставки: триггер записи учитывает любые действующие брони (раздел 8).
        ctx.db.prepare('DELETE FROM slot_holds WHERE owner_id = ?').run(user.id);
        const id = Number(ctx.db.prepare(`
          INSERT INTO bookings (client_id, master_id, is_any_master, starts_at, ends_at, busy_until, price_level, comment,
                                created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(client, masterId, isAnyMaster ? 1 : 0, startsAt, endsAt, busyUntil, master.level, comment,
          user.id, now.toISOString(), now.toISOString()).lastInsertRowid);
        // Название, цена и длительность копируются: смена прайса не меняет созданную запись (сценарий 7).
        const insertItem = ctx.db.prepare(`
          INSERT INTO booking_items (booking_id, service_id, position, service_name, unit_price_kop, quantity, price_kop, duration_min)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        visit.lines.forEach((line, i) => {
          const unit = unitPrice(line, master.level);
          insertItem.run(id, line.serviceId, i + 1, line.name, unit, line.quantity, unit * line.quantity, line.durationMin);
        });
        return id;
      });
      return { status: 201, body: { booking: bookingView(ctx.db, bookingId, { viewer: user.role, now }) } };
    } catch (error) {
      if (databaseErrorCode(error) === 'SLOT_TAKEN') throw slotTaken(startsAt, []);
      throw error;
    }
  });

  // Свои записи клиента (CAB-01, CAB-02): предстоящие — сверху по времени, затем прошедшие и отмененные — от новых к старым.
  // Администратор смотрит все записи в /api/admin/bookings.
  router.get('/api/bookings', (ctx): Result => {
    const user = requireRole(ctx, 'client');
    const input = Input.query(ctx.query);
    const status = input.oneOf('status', BOOKING_STATUSES, { optional: true });
    const period = input.oneOf('period', ['upcoming', 'past'] as const, { optional: true });
    input.done();

    const now = ctx.now.toISOString();
    const rows = ctx.db.prepare(`
      SELECT id, (status = 'active' AND starts_at >= @now) AS upcoming FROM bookings
      WHERE client_id = @client AND (@status IS NULL OR status = @status)
      ORDER BY upcoming DESC,
               CASE WHEN status = 'active' AND starts_at >= @now THEN starts_at END ASC,
               starts_at DESC
    `).all({ client: user.id, status: status ?? null, now }) as { id: number; upcoming: number }[];
    const ids = rows.filter((r) => !period || (period === 'upcoming') === (r.upcoming === 1)).map((r) => r.id);
    return { status: 200, body: { bookings: bookingViews(ctx.db, ids, { viewer: user.role, now: ctx.now }) } };
  });

  // Карточка записи (CAB-03, A-03). Клиент видит только свою запись, администратор — любую и с историей изменений.
  router.get('/api/bookings/:id', (ctx): Result => {
    const user = requireRole(ctx, 'client', 'admin');
    const id = pathId(ctx);
    const row = ctx.db.prepare('SELECT client_id FROM bookings WHERE id = ?').get(id) as { client_id: number } | undefined;
    if (!row) throw notFound('Запись не найдена');
    if (user.role !== 'admin' && row.client_id !== user.id) throw forbidden('Это чужая запись');
    return { status: 200, body: { booking: bookingView(ctx.db, id, { viewer: user.role, now: ctx.now, withEvents: true }) } };
  });

  // Перенос (сценарий 5, CAB-04, A-04): меняется время и, возможно, мастер той же записи — новая не создается.
  // Клиенту нужна бронь на перенос (POST /api/holds с bookingId). Цена пересчитывается только
  // у мастера другого уровня, старая и новая суммы остаются в истории (сценарий 11).
  router.post('/api/bookings/:id/reschedule', (ctx): Result => {
    const user = requireRole(ctx, 'client', 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const startsAt = input.instant('startsAt');
    const masterIdInput = input.id('masterId', { optional: true });
    const reason = input.string('reason', { optional: true, nullable: true, max: MAX_TEXT }) ?? null;
    const version = input.int('version', { optional: true, min: 1 });
    input.done();

    const now = ctx.now;
    try {
      transaction(ctx.db, () => {
        const booking = loadBooking(ctx.db, id);
        if (!booking) throw notFound('Запись не найдена');
        requireChangeableBooking(ctx, user, booking);
        checkVersion(booking.version, version);

        const masterId = masterIdInput ?? booking.master_id;
        if (masterId === booking.master_id && startsAt === booking.starts_at) {
          throw badRequest('NOTHING_TO_CHANGE', 'Новое время совпадает с текущим');
        }
        const master = requireMasterForVisit(ctx.db, masterId, booking.serviceIds);
        const endsAt = new Date(Date.parse(startsAt) + booking.durationMin * 60_000).toISOString();
        const busyUntil = new Date(Date.parse(endsAt) + booking.cleanupMin * 60_000).toISOString();

        const hold = ctx.db.prepare('SELECT * FROM slot_holds WHERE owner_id = ?').get(user.id) as unknown as HoldRow | undefined;
        if (user.role === 'client') {
          if (!hold || hold.booking_id !== id) throw conflict('HOLD_NOT_FOUND', 'Новое время не закреплено за вами. Выберите время заново');
          if (hold.expires_at <= now.toISOString()) throw conflict('HOLD_EXPIRED', 'Время брони истекло. Проверьте, свободно ли еще это время');
          if (hold.master_id !== masterId || hold.starts_at !== startsAt) {
            throw conflict('HOLD_MISMATCH', 'Бронь не совпадает с выбранными мастером и временем. Выберите время заново');
          }
        }

        const check = checkSlot(ctx.db, {
          masterId, startsAt, durationMin: booking.durationMin, cleanupMin: booking.cleanupMin, now,
          audience: 'admin', viewerId: user.id, excludeBookingId: id,
        });
        if (!check.available) throw slotTaken(startsAt, check.slots.map((s) => ({ masterId, startsAt: s.startsAt, endsAt: s.endsAt })));

        ctx.db.prepare('DELETE FROM slot_holds WHERE owner_id = ?').run(user.id);
        const prices = pricesAtLevel(booking, master.level);
        if (prices.changed) {
          const updateItem = ctx.db.prepare('UPDATE booking_items SET unit_price_kop = ?, price_kop = ? WHERE booking_id = ? AND service_id = ?');
          booking.items.forEach((item, i) => {
            const unit = prices.units[i]!;
            updateItem.run(unit, unit * item.quantity, id, item.service_id);
          });
        }
        ctx.db.prepare(`
          INSERT INTO booking_events (booking_id, event_type, actor_id, old_master_id, new_master_id, old_starts_at, new_starts_at,
                                      old_total_price_kop, new_total_price_kop, reason, created_at)
          VALUES (?, 'rescheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, user.id, booking.master_id, masterId, booking.starts_at, startsAt,
          prices.changed ? booking.totalKop : null, prices.changed ? prices.totalKop : null, reason, now.toISOString());
        // Условие по версии — защита от одновременного редактирования двумя сотрудниками (раздел 9, экран A-S1).
        const updated = ctx.db.prepare(`
          UPDATE bookings SET master_id = ?, starts_at = ?, ends_at = ?, busy_until = ?, price_level = ?,
                              version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(masterId, startsAt, endsAt, busyUntil, master.level, now.toISOString(), id, booking.version);
        if (updated.changes !== 1) throw versionConflict();
      });
    } catch (error) {
      if (databaseErrorCode(error) === 'SLOT_TAKEN') throw slotTaken(startsAt, []);
      throw error;
    }
    return { status: 200, body: { booking: bookingView(ctx.db, id, { viewer: user.role, now, withEvents: true }) } };
  });

  // Отмена (CAB-05, A-05). Клиент — не позднее чем за 24 часа, со статусом «Отменена клиентом».
  // Администратор выбирает, кто отменил: by = client или studio (по умолчанию studio).
  // Сначала событие отмены, потом статус — иначе триггер 10.7 отклонит смену статуса.
  router.post('/api/bookings/:id/cancel', (ctx): Result => {
    const user = requireRole(ctx, 'client', 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const reason = input.string('reason', { optional: true, nullable: true, max: MAX_TEXT }) ?? null;
    const by = input.oneOf('by', ['client', 'studio'] as const, { optional: true });
    const version = input.int('version', { optional: true, min: 1 });
    if (user.role === 'client' && by === 'studio') input.fail('by', 'Клиент отменяет запись от своего имени');
    input.done();

    const now = ctx.now.toISOString();
    transaction(ctx.db, () => {
      const booking = ctx.db.prepare('SELECT client_id, status, starts_at, version FROM bookings WHERE id = ?').get(id) as
        { client_id: number; status: string; starts_at: string; version: number } | undefined;
      if (!booking) throw notFound('Запись не найдена');
      requireChangeableBooking(ctx, user, booking);
      checkVersion(booking.version, version);

      const newStatus = user.role === 'client' || by === 'client' ? 'cancelled_by_client' : 'cancelled_by_studio';
      ctx.db.prepare(`
        INSERT INTO booking_events (booking_id, event_type, actor_id, old_status, new_status, reason, created_at)
        VALUES (?, 'cancelled', ?, 'active', ?, ?, ?)
      `).run(id, user.id, newStatus, reason, now);
      const updated = ctx.db.prepare(`
        UPDATE bookings SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?
      `).run(newStatus, now, id, booking.version);
      if (updated.changes !== 1) throw versionConflict();
      // Бронь на перенос этой записи больше не нужна: время освобождается сразу.
      ctx.db.prepare('DELETE FROM slot_holds WHERE booking_id = ?').run(id);
    });
    return { status: 200, body: { booking: bookingView(ctx.db, id, { viewer: user.role, now: ctx.now, withEvents: true }) } };
  });

  // «Визит завершен» и «Клиент не пришел» (A-03, A-06; паспорт, функция 7 администратора) — только для визита,
  // который уже начался. Ошибочную отметку можно исправить: завершена ↔ не пришел. Каждая смена — в истории.
  router.post('/api/bookings/:id/status', (ctx): Result => {
    const user = requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const status = input.oneOf('status', ['completed', 'no_show'] as const);
    const reason = input.string('reason', { optional: true, nullable: true, max: MAX_TEXT }) ?? null;
    const version = input.int('version', { optional: true, min: 1 });
    input.done();

    const now = ctx.now.toISOString();
    transaction(ctx.db, () => {
      const booking = ctx.db.prepare('SELECT status, starts_at, version FROM bookings WHERE id = ?').get(id) as
        { status: string; starts_at: string; version: number } | undefined;
      if (!booking) throw notFound('Запись не найдена');
      checkVersion(booking.version, version);
      if (booking.status === 'cancelled_by_client' || booking.status === 'cancelled_by_studio') {
        throw conflict('BOOKING_NOT_ACTIVE', 'Запись отменена: отметить визит нельзя');
      }
      if (booking.status === status) throw badRequest('NOTHING_TO_CHANGE', 'У записи уже этот статус');
      if (booking.starts_at > now) throw conflict('VISIT_NOT_STARTED', 'Отметить визит можно, когда он уже начался');

      ctx.db.prepare(`
        INSERT INTO booking_events (booking_id, event_type, actor_id, old_status, new_status, reason, created_at)
        VALUES (?, 'status_changed', ?, ?, ?, ?, ?)
      `).run(id, user.id, booking.status, status, reason, now);
      const updated = ctx.db.prepare('UPDATE bookings SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
        .run(status, now, id, booking.version);
      if (updated.changes !== 1) throw versionConflict();
    });
    return { status: 200, body: { booking: bookingView(ctx.db, id, { viewer: user.role, now: ctx.now, withEvents: true }) } };
  });

  // Клиент закрыл баннер «Запись отменена или перенесена студией» (CAB-01): баннер больше не показывается.
  // Версия записи не растет: это не изменение записи, и сотрудник, который ее редактирует, не получит конфликт.
  router.post('/api/bookings/:id/acknowledge', (ctx): Result => {
    const user = requireRole(ctx, 'client');
    const id = pathId(ctx);
    Input.body(ctx.body).done();
    const row = ctx.db.prepare('SELECT client_id FROM bookings WHERE id = ?').get(id) as { client_id: number } | undefined;
    if (!row) throw notFound('Запись не найдена');
    if (row.client_id !== user.id) throw forbidden('Это чужая запись');
    ctx.db.prepare('UPDATE bookings SET client_acknowledged_at = ? WHERE id = ?').run(ctx.now.toISOString(), id);
    return { status: 200, body: { booking: bookingView(ctx.db, id, { viewer: user.role, now: ctx.now }) } };
  });

  // Все записи студии для администратора (A-01, функция 5): фильтры по датам студии, мастеру, услуге, статусу и клиенту.
  router.get('/api/admin/bookings', (ctx): Result => {
    const user = requireRole(ctx, 'admin');
    const input = Input.query(ctx.query);
    const dateFrom = input.date('dateFrom', { optional: true });
    const dateTo = input.date('dateTo', { optional: true });
    const masterId = input.id('masterId', { optional: true });
    const serviceId = input.id('serviceId', { optional: true });
    const clientId = input.id('clientId', { optional: true });
    const status = input.oneOf('status', BOOKING_STATUSES, { optional: true });
    const limit = input.int('limit', { optional: true, min: 1, max: 500 }) ?? 100;
    const offset = input.int('offset', { optional: true, min: 0 }) ?? 0;
    if (dateFrom && dateTo && dateTo < dateFrom) input.fail('dateTo', 'Конец периода раньше начала');
    input.done();

    // Даты — по календарю студии: границы дня переводятся в UTC (раздел 2.1).
    const { timezone } = readSettings(ctx.db);
    const where = `
      WHERE (@from IS NULL OR starts_at >= @from) AND (@to IS NULL OR starts_at < @to)
        AND (@master IS NULL OR master_id = @master) AND (@client IS NULL OR client_id = @client)
        AND (@status IS NULL OR status = @status)
        AND (@service IS NULL OR id IN (SELECT booking_id FROM booking_items WHERE service_id = @service))`;
    const params = {
      from: dateFrom ? new Date(zonedTimeToUtc(dateFrom, '00:00', timezone)).toISOString() : null,
      to: dateTo ? new Date(zonedTimeToUtc(addDays(dateTo, 1), '00:00', timezone)).toISOString() : null,
      master: masterId ?? null, client: clientId ?? null, status: status ?? null, service: serviceId ?? null,
    };
    const { total } = ctx.db.prepare(`SELECT count(*) AS total FROM bookings ${where}`).get(params) as { total: number };
    const ids = (ctx.db.prepare(`SELECT id FROM bookings ${where} ORDER BY starts_at, master_id LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as { id: number }[]).map((r) => r.id);
    return {
      status: 200,
      body: { timezone, total, limit, offset, bookings: bookingViews(ctx.db, ids, { viewer: user.role, now: ctx.now }) },
    };
  });
}

/** Клиент, за которого записывает администратор: из базы или новый, по имени и телефону. */
function resolveClient(db: Db, clientId: number | undefined, newClient: { name: string; phone: string } | undefined, now: Date): number {
  if (clientId !== undefined) {
    const client = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client' AND deleted_at IS NULL").get(clientId);
    if (!client) throw badRequest('CLIENT_NOT_FOUND', 'Клиент не найден', { clientId });
    return clientId;
  }
  const existing = db.prepare('SELECT id, role FROM users WHERE phone = ?').get(newClient!.phone) as { id: number; role: string } | undefined;
  if (existing) {
    throw conflict('PHONE_TAKEN', 'Клиент с этим телефоном уже есть в базе — выберите его', existing.role === 'client' ? { clientId: existing.id } : undefined);
  }
  return Number(db.prepare(`
    INSERT INTO users (role, name, phone, created_at, updated_at) VALUES ('client', ?, ?, ?, ?)
  `).run(newClient!.name, newClient!.phone, now.toISOString(), now.toISOString()).lastInsertRowid);
}

const versionConflict = () =>
  conflict('VERSION_CONFLICT', 'Запись изменена другим сотрудником. Обновите данные и повторите');

/** Если интерфейс передал версию, которую видел пользователь, она должна совпадать с текущей (A-S1). */
function checkVersion(current: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== current) throw versionConflict();
}
