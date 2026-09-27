// Записи: создание, свои записи, карточка записи, перенос, отмена, итог визита (паспорт, функции 6–8 клиента,
// функции 5–7 администратора). Обработчики только разбирают запрос и собирают ответ: создают и меняют записи
// функции booking/booking-service.ts — одни и те же для клиента, мастера и администратора, права ролей — там же.
import { cancelBooking, createBooking, rescheduleBooking, setVisitResult } from '../booking/booking-service.js';
import { readVisitItems } from '../booking/visit.js';
import { forbidden, notFound } from '../http/errors.js';
import { pathId, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { addDays, zonedTimeToUtc } from '../lib/studio-time.js';
import { readSettings } from '../studio/settings.js';
import { requireRole, requireUser } from './guards.js';
import { BOOKING_STATUSES, bookingView, bookingViews } from './views.js';

const MAX_TEXT = 500;

export function bookingRoutes(router: Router): void {
  // Создать запись (BOOK-04, A-02). Поля clientId, newClient и isOverbooking читаются у всех ролей,
  // а что из них разрешено — решает createBooking: клиент записывает только себя по своей брони,
  // администратор — за клиента, в том числе поверх занятого времени, мастер — 403.
  router.post('/api/bookings', (ctx): Result => {
    const user = requireUser(ctx);
    const input = Input.body(ctx.body);
    const masterId = input.id('masterId');
    const startsAt = input.instant('startsAt');
    const items = readVisitItems(input);
    const comment = input.string('comment', { optional: true, nullable: true, max: MAX_TEXT }) ?? null;
    const isAnyMaster = input.bool('isAnyMaster', { optional: true }) ?? false;
    const clientId = input.id('clientId', { optional: true });
    const newClient = input.object('newClient', (c) => ({ name: c.string('name', { max: 100 }), phone: c.phone('phone') }), { optional: true });
    const isOverbooking = input.bool('isOverbooking', { optional: true }) ?? false;
    if (input.has('clientId') && input.has('newClient')) input.fail('newClient', 'Укажите либо clientId, либо newClient');
    input.done();

    const id = createBooking(ctx.db, user, { masterId, startsAt, items, comment, isAnyMaster, clientId, newClient, isOverbooking }, ctx.now);
    return { status: 201, body: { booking: bookingView(ctx.db, id, { viewer: user.role, now: ctx.now }) } };
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

  // Перенос той же записи (сценарий 5, CAB-04, A-04) — rescheduleBooking. isOverbooking действует только у администратора.
  router.post('/api/bookings/:id/reschedule', (ctx): Result => {
    const user = requireUser(ctx);
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const startsAt = input.instant('startsAt');
    const masterId = input.id('masterId', { optional: true });
    const reason = input.string('reason', { optional: true, nullable: true, max: MAX_TEXT }) ?? null;
    const version = input.int('version', { optional: true, min: 1 });
    const isOverbooking = input.bool('isOverbooking', { optional: true }) ?? false;
    input.done();
    rescheduleBooking(ctx.db, user, id, { startsAt, masterId, reason, version, isOverbooking }, ctx.now);
    return { status: 200, body: { booking: bookingView(ctx.db, id, { viewer: user.role, now: ctx.now, withEvents: true }) } };
  });

  // Отмена (CAB-05, A-05) — cancelBooking.
  router.post('/api/bookings/:id/cancel', (ctx): Result => {
    const user = requireUser(ctx);
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const reason = input.string('reason', { optional: true, nullable: true, max: MAX_TEXT }) ?? null;
    const by = input.oneOf('by', ['client', 'studio'] as const, { optional: true });
    const version = input.int('version', { optional: true, min: 1 });
    input.done();
    cancelBooking(ctx.db, user, id, { reason, by, version }, ctx.now);
    return { status: 200, body: { booking: bookingView(ctx.db, id, { viewer: user.role, now: ctx.now, withEvents: true }) } };
  });

  // «Визит завершен» и «Клиент не пришел» (A-03, A-06) — setVisitResult.
  router.post('/api/bookings/:id/status', (ctx): Result => {
    const user = requireUser(ctx);
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const status = input.oneOf('status', ['completed', 'no_show'] as const);
    const reason = input.string('reason', { optional: true, nullable: true, max: MAX_TEXT }) ?? null;
    const version = input.int('version', { optional: true, min: 1 });
    input.done();
    setVisitResult(ctx.db, user, id, { status, reason, version }, ctx.now);
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
