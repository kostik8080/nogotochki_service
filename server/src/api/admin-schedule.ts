// Расписание (паспорт, функция 4 администратора): блокировки времени мастера (обед, личное время, выходной,
// отпуск, больничный), изменения смены мастера на дату (A-20) и особые дни студии (A-20d).
// Каждое изменение возвращает действующие записи, которые оно задевает; с dryRun: true изменение
// не сохраняется — только показывает эти записи.
// Доступ: весь /api/admin/* закрывает одна проверка requireAdmin (api/guards.ts), ее вызывает app.ts до поиска
// маршрута. В обработчиках роль не проверяется; пользователя они берут через requireUser.
import { applyOrPreview, bookingsOutsideWorkingHours, bookingsOverlapping } from '../booking/affected.js';
import { BLOCK_TYPES, insertTimeBlock } from '../booking/schedule-changes.js';
import type { Db } from '../db/connection.js';
import { badRequest, notFound } from '../http/errors.js';
import { pathId, type Context, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { addDays, zonedDate, zonedTimeToUtc } from '../lib/studio-time.js';
import { readSettings } from '../studio/settings.js';
import { requireUser } from './guards.js';
import { bookingViews } from './views.js';


/** Самая длинная блокировка — год, самый длинный период выборки — тоже: защита от опечатки в годе. */
const MAX_RANGE_DAYS = 366;

const dayStart = (db: Db, date: string) => new Date(zonedTimeToUtc(date, '00:00', readSettings(db).timezone)).toISOString();
const today = (ctx: Context) => zonedDate(ctx.now.getTime(), readSettings(ctx.db).timezone);

/** Период из строки запроса: from и to — даты студии включительно, по умолчанию сегодня … +horizon. */
function readRange(ctx: Context, input: Input): { from: string; to: string } {
  const from = input.date('from', { optional: true }) ?? today(ctx);
  const to = input.date('to', { optional: true }) ?? addDays(from, readSettings(ctx.db).booking_horizon_days - 1);
  if (input.valid && to < from) input.fail('to', 'Конец периода раньше начала');
  if (input.valid && to > addDays(from, MAX_RANGE_DAYS)) input.fail('to', `Период не длиннее ${MAX_RANGE_DAYS} дней`);
  return { from, to };
}

/** Дата из пути (/…/days/2026-09-29): неверная дата — 400. */
function pathDate(ctx: Context): string {
  const input = Input.body({ date: ctx.params.date });
  const date = input.date('date');
  input.done();
  return date;
}

function requireMaster(db: Db, id: number): void {
  if (!db.prepare('SELECT 1 FROM masters WHERE id = ?').get(id)) throw notFound('Мастер не найден');
}

/** Время по часам: смена или часы работы — конец позже начала. */
function readHours(input: Input, open: boolean, startKey: string, endKey: string): { start: string | null; end: string | null } {
  if (!open) {
    const start = input.string(startKey, { optional: true, nullable: true });
    const end = input.string(endKey, { optional: true, nullable: true });
    if (start || end) input.fail(startKey, 'У нерабочего дня часов нет');
    return { start: null, end: null };
  }
  const start = input.time(startKey);
  const end = input.time(endKey);
  if (input.valid && end <= start) input.fail(endKey, 'Конец должен быть позже начала');
  return { start, end };
}

export function adminScheduleRoutes(router: Router): void {
  // Особые дни студии для календаря клиента: закрытые дни и сокращенные часы с причиной (BOOK-03).
  router.get('/api/studio/days', (ctx): Result => {
    const input = Input.query(ctx.query);
    const { from, to } = readRange(ctx, input);
    input.done();
    const rows = ctx.db.prepare(`
      SELECT work_date, is_open, open_time, close_time, reason FROM studio_day_overrides WHERE work_date BETWEEN ? AND ? ORDER BY work_date
    `).all(from, to) as { work_date: string; is_open: number; open_time: string | null; close_time: string | null; reason: string }[];
    return {
      status: 200,
      body: { days: rows.map((d) => ({ date: d.work_date, isOpen: d.is_open === 1, open: d.open_time, close: d.close_time, reason: d.reason })) },
    };
  });

  // --- Блокировки времени ---

  router.get('/api/admin/time-blocks', (ctx): Result => {
    const input = Input.query(ctx.query);
    const masterId = input.id('masterId', { optional: true });
    const { from, to } = readRange(ctx, input);
    input.done();
    const rows = ctx.db.prepare(`
      SELECT t.id, t.master_id, t.block_type, t.starts_at, t.ends_at, t.comment, t.created_by, u.name AS creator_name, t.created_at
      FROM time_blocks t JOIN users u ON u.id = t.created_by
      WHERE t.starts_at < @to AND t.ends_at > @from AND (@master IS NULL OR t.master_id = @master)
      ORDER BY t.starts_at, t.master_id
    `).all({ from: dayStart(ctx.db, from), to: dayStart(ctx.db, addDays(to, 1)), master: masterId ?? null }) as {
      id: number; master_id: number; block_type: string; starts_at: string; ends_at: string; comment: string | null;
      created_by: number; creator_name: string; created_at: string;
    }[];
    return {
      status: 200,
      body: {
        timeBlocks: rows.map((t) => ({
          id: t.id, masterId: t.master_id, type: t.block_type, startsAt: t.starts_at, endsAt: t.ends_at, comment: t.comment,
          createdBy: { id: t.created_by, name: t.creator_name }, createdAt: t.created_at,
        })),
      },
    };
  });

  // Новая блокировка (сценарий 8: отпуск Елены). Слоты мастера на это время пропадают сразу; записи,
  // которые попали под блокировку, база не трогает — они приходят в ответе, администратор разбирает их сам.
  router.post('/api/admin/time-blocks', (ctx): Result => {
    const user = requireUser(ctx);
    const input = Input.body(ctx.body);
    const masterId = input.id('masterId');
    const type = input.oneOf('type', BLOCK_TYPES);
    const startsAt = input.instant('startsAt');
    const endsAt = input.instant('endsAt');
    const comment = input.string('comment', { optional: true, nullable: true, max: 500 }) ?? null;
    const dryRun = input.bool('dryRun', { optional: true }) ?? false;
    if (input.valid && endsAt <= startsAt) input.fail('endsAt', 'Конец блокировки должен быть позже начала');
    if (input.valid && Date.parse(endsAt) - Date.parse(startsAt) > MAX_RANGE_DAYS * 86_400_000) input.fail('endsAt', 'Блокировка не длиннее года');
    if (type === 'other' && !comment) input.fail('comment', 'Для типа «другое» нужно пояснение');
    input.done();

    const result = applyOrPreview(ctx.db, dryRun, () => {
      requireMaster(ctx.db, masterId);
      const id = insertTimeBlock(ctx.db, {
        masterId, type, startsAt, endsAt, comment, createdBy: user.id, createdAt: ctx.now.toISOString(),
      });
      return { id, affected: bookingsOverlapping(ctx.db, masterId, startsAt, endsAt) };
    });
    return {
      status: dryRun ? 200 : 201,
      body: {
        timeBlock: dryRun ? null : { id: result.id, masterId, type, startsAt, endsAt, comment },
        affectedBookings: bookingViews(ctx.db, result.affected, { viewer: 'admin', now: ctx.now }),
      },
    };
  });

  // Блокировку можно удалить: это рабочий график, а не история посещений (раздел 5.17).
  router.delete('/api/admin/time-blocks/:id', (ctx): Result => {
    const deleted = ctx.db.prepare('DELETE FROM time_blocks WHERE id = ?').run(pathId(ctx)).changes;
    if (deleted === 0) throw notFound('Блокировка не найдена');
    return { status: 204 };
  });

  // --- Смена мастера на дату (A-20): рабочий день вне графика или выходной ---

  router.get('/api/admin/masters/:id/days', (ctx): Result => {
    const masterId = pathId(ctx);
    const input = Input.query(ctx.query);
    const { from, to } = readRange(ctx, input);
    input.done();
    requireMaster(ctx.db, masterId);
    const rows = ctx.db.prepare(`
      SELECT work_date, is_working, start_time, end_time FROM master_day_overrides
      WHERE master_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date
    `).all(masterId, from, to) as { work_date: string; is_working: number; start_time: string | null; end_time: string | null }[];
    return {
      status: 200,
      body: { days: rows.map((d) => ({ date: d.work_date, isWorking: d.is_working === 1, start: d.start_time, end: d.end_time })) },
    };
  });

  router.put('/api/admin/masters/:id/days/:date', (ctx): Result => {
    const user = requireUser(ctx);
    const masterId = pathId(ctx);
    const date = pathDate(ctx);
    const input = Input.body(ctx.body);
    const isWorking = input.bool('isWorking');
    const { start, end } = readHours(input, isWorking !== false, 'start', 'end');
    const dryRun = input.bool('dryRun', { optional: true }) ?? false;
    input.done();

    const affected = applyOrPreview(ctx.db, dryRun, () => {
      requireMaster(ctx.db, masterId);
      ctx.db.prepare('DELETE FROM master_day_overrides WHERE master_id = ? AND work_date = ?').run(masterId, date);
      ctx.db.prepare(`
        INSERT INTO master_day_overrides (master_id, work_date, is_working, start_time, end_time, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(masterId, date, isWorking ? 1 : 0, start, end, user.id, ctx.now.toISOString());
      return bookingsOutsideWorkingHours(ctx.db, { masterId, from: dayStart(ctx.db, date), to: dayStart(ctx.db, addDays(date, 1)) });
    });
    return {
      status: 200,
      body: {
        day: { date, isWorking, start, end },
        affectedBookings: bookingViews(ctx.db, affected, { viewer: 'admin', now: ctx.now }),
      },
    };
  });

  // Убрать изменение: день снова считается по недельному графику.
  router.delete('/api/admin/masters/:id/days/:date', (ctx): Result => {
    const masterId = pathId(ctx);
    const date = pathDate(ctx);
    const affected = applyOrPreview(ctx.db, false, () => {
      const deleted = ctx.db.prepare('DELETE FROM master_day_overrides WHERE master_id = ? AND work_date = ?').run(masterId, date).changes;
      if (deleted === 0) throw notFound('Изменения графика на эту дату нет');
      return bookingsOutsideWorkingHours(ctx.db, { masterId, from: dayStart(ctx.db, date), to: dayStart(ctx.db, addDays(date, 1)) });
    });
    return { status: 200, body: { affectedBookings: bookingViews(ctx.db, affected, { viewer: 'admin', now: ctx.now }) } };
  });

  // --- Особые дни студии (A-20d): праздник, санитарный день, сокращенный или дополнительный рабочий день ---

  router.get('/api/admin/studio-days', (ctx): Result => {
    const input = Input.query(ctx.query);
    const { from, to } = readRange(ctx, input);
    input.done();
    const rows = ctx.db.prepare(`
      SELECT d.work_date, d.is_open, d.open_time, d.close_time, d.reason, d.created_by, u.name AS creator_name, d.created_at
      FROM studio_day_overrides d JOIN users u ON u.id = d.created_by
      WHERE d.work_date BETWEEN ? AND ? ORDER BY d.work_date
    `).all(from, to) as {
      work_date: string; is_open: number; open_time: string | null; close_time: string | null; reason: string;
      created_by: number; creator_name: string; created_at: string;
    }[];
    return {
      status: 200,
      body: {
        days: rows.map((d) => ({
          date: d.work_date, isOpen: d.is_open === 1, open: d.open_time, close: d.close_time, reason: d.reason,
          createdBy: { id: d.created_by, name: d.creator_name }, createdAt: d.created_at,
        })),
      },
    };
  });

  // Особый день действует сразу на всех мастеров (сценарий 14: санитарный день). В ответе — записи всех
  // мастеров на эту дату, которые в новый режим не помещаются.
  router.put('/api/admin/studio-days/:date', (ctx): Result => {
    const user = requireUser(ctx);
    const date = pathDate(ctx);
    const input = Input.body(ctx.body);
    const isOpen = input.bool('isOpen');
    const { start: open, end: close } = readHours(input, isOpen !== false, 'open', 'close');
    const reason = input.string('reason', { max: 200 });
    const dryRun = input.bool('dryRun', { optional: true }) ?? false;
    input.done();
    if (date < today(ctx)) throw badRequest('DATE_IN_PAST', 'Прошедший день изменить нельзя');

    const affected = applyOrPreview(ctx.db, dryRun, () => {
      ctx.db.prepare('DELETE FROM studio_day_overrides WHERE work_date = ?').run(date);
      ctx.db.prepare(`
        INSERT INTO studio_day_overrides (work_date, is_open, open_time, close_time, reason, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(date, isOpen ? 1 : 0, open, close, reason, user.id, ctx.now.toISOString());
      return bookingsOutsideWorkingHours(ctx.db, { from: dayStart(ctx.db, date), to: dayStart(ctx.db, addDays(date, 1)) });
    });
    return {
      status: 200,
      body: {
        day: { date, isOpen, open, close, reason },
        affectedBookings: bookingViews(ctx.db, affected, { viewer: 'admin', now: ctx.now }),
      },
    };
  });

  router.delete('/api/admin/studio-days/:date', (ctx): Result => {
    const date = pathDate(ctx);
    const affected = applyOrPreview(ctx.db, false, () => {
      const deleted = ctx.db.prepare('DELETE FROM studio_day_overrides WHERE work_date = ?').run(date).changes;
      if (deleted === 0) throw notFound('Особого дня на эту дату нет');
      return bookingsOutsideWorkingHours(ctx.db, { from: dayStart(ctx.db, date), to: dayStart(ctx.db, addDays(date, 1)) });
    });
    return { status: 200, body: { affectedBookings: bookingViews(ctx.db, affected, { viewer: 'admin', now: ctx.now }) } };
  });
}
