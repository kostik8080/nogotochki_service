// Заявки мастера администратору (таблица master_requests, миграция 008): отпуск, отгул, больничный,
// новый график с даты и свободная просьба словами.
//
// Мастер записи не ведет — он просит, а решает администратор (паспорт, функции мастера). Поэтому:
//   мастер  — подает заявку за себя, видит свои и может отозвать ту, что еще на рассмотрении;
//   администратор — видит все заявки, одобряет или отклоняет с причиной.
//
// Одобрение применяет заявку сразу теми же функциями, которыми администратор меняет расписание руками
// (booking/schedule-changes.ts): отпуск, отгул и больничный становятся блокировкой времени, график —
// строками master_weekly_hours. Записи под изменением база не трогает: администратор видит их в ответе
// (`affectedBookings`) и разбирает сам. `dryRun: true` показывает этот список до одобрения.
import { applyOrPreview, bookingsOutsideWorkingHours, bookingsOverlapping } from '../booking/affected.js';
import { insertTimeBlock, saveWeeklySchedule, type ScheduleDay } from '../booking/schedule-changes.js';
import type { Db } from '../db/connection.js';
import { transaction } from '../db/connection.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { pathId, type Context, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { addDays, zonedDate, zonedTimeToUtc } from '../lib/studio-time.js';
import { readSettings } from '../studio/settings.js';
import { requireMasterProfile, requireRole, requireUser } from './guards.js';
import { bookingViews } from './views.js';

const TYPES = ['vacation', 'day_off', 'sick_leave', 'schedule', 'other'] as const;
type RequestType = (typeof TYPES)[number];
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

/** Заявка на период дат превращается в блокировку времени этого типа. */
const BLOCK_OF: Record<string, 'vacation' | 'day_off' | 'sick_leave'> = {
  vacation: 'vacation', day_off: 'day_off', sick_leave: 'sick_leave',
};
const isPeriod = (type: string) => type in BLOCK_OF;

interface RequestRow {
  id: number;
  master_id: number;
  master_name: string;
  created_by: number;
  type: RequestType;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  valid_from: string | null;
  payload: string | null;
  comment: string | null;
  decided_by: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  time_block_id: number | null;
  created_at: string;
}

const SELECT = `
  SELECT r.id, r.master_id, m.name AS master_name, r.created_by, r.type, r.status, r.starts_on, r.ends_on,
         r.valid_from, r.payload, r.comment, r.decided_by, d.name AS decided_by_name, r.decided_at,
         r.decision_reason, r.time_block_id, r.created_at
  FROM master_requests r
  JOIN masters m ON m.id = r.master_id
  LEFT JOIN users d ON d.id = r.decided_by`;

function requestView(r: RequestRow) {
  return {
    id: r.id,
    master: { id: r.master_id, name: r.master_name },
    type: r.type,
    status: r.status,
    // Период дат (отпуск, отгул, больничный) — календарные даты студии, включительно
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    // Новый график: с какой даты и какие дни недели
    validFrom: r.valid_from,
    days: r.payload === null ? null : (JSON.parse(r.payload) as ScheduleDay[]),
    comment: r.comment,
    decision: r.decided_by === null ? null : {
      by: { id: r.decided_by, name: r.decided_by_name },
      at: r.decided_at,
      reason: r.decision_reason,
    },
    timeBlockId: r.time_block_id,
    createdAt: r.created_at,
  };
}

const getRequest = (db: Db, id: number) => db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as RequestRow | undefined;

/** Дни нового графика: 1–7 с понедельника, без повторов, конец смены позже начала. */
function readDays(input: Input): ScheduleDay[] {
  const days = input.objects('days', (d): ScheduleDay => ({
    weekday: d.int('weekday', { min: 1, max: 7 }),
    start: d.time('start'),
    end: d.time('end'),
  }), { max: 7 });
  if (input.valid) {
    if (days.length === 0) input.fail('days', 'Выберите хотя бы один рабочий день');
    if (new Set(days.map((d) => d.weekday)).size !== days.length) input.fail('days', 'День недели повторяется');
    days.forEach((d, i) => {
      if (d.end <= d.start) input.fail(`days[${i}].end`, 'Конец смены должен быть позже начала');
    });
  }
  return days;
}

/** Границы периода заявки в UTC: с начала первого дня до начала дня после последнего. */
function periodRange(db: Db, startsOn: string, endsOn: string): { startsAt: string; endsAt: string } {
  const { timezone } = readSettings(db);
  return {
    startsAt: new Date(zonedTimeToUtc(startsOn, '00:00', timezone)).toISOString(),
    endsAt: new Date(zonedTimeToUtc(addDays(endsOn, 1), '00:00', timezone)).toISOString(),
  };
}

/** Что заденет одобрение: записи под блокировкой или записи вне нового графика. */
function affectedByRequest(db: Db, r: RequestRow): number[] {
  if (isPeriod(r.type)) {
    const { startsAt, endsAt } = periodRange(db, r.starts_on!, r.ends_on!);
    return bookingsOverlapping(db, r.master_id, startsAt, endsAt);
  }
  if (r.type === 'schedule') {
    const { timezone } = readSettings(db);
    const from = new Date(zonedTimeToUtc(r.valid_from!, '00:00', timezone)).toISOString();
    return bookingsOutsideWorkingHours(db, { masterId: r.master_id, from });
  }
  return [];
}

export function requestRoutes(router: Router): void {
  // ---------- Мастер: свои заявки ----------

  router.get('/api/master/requests', (ctx): Result => {
    const user = requireRole(ctx, 'master');
    Input.query(ctx.query).done();
    const master = requireMasterProfile(ctx, user);
    const rows = ctx.db.prepare(`${SELECT} WHERE r.master_id = ? ORDER BY r.created_at DESC, r.id DESC`)
      .all(master.id) as unknown as RequestRow[];
    return { status: 200, body: { requests: rows.map(requestView) } };
  });

  // Новая заявка. Мастер подает ее только за себя: master_id берется из его профиля, а не из запроса —
  // это же проверяет триггер master_requests_role_insert.
  router.post('/api/master/requests', (ctx): Result => {
    const user = requireRole(ctx, 'master');
    const master = requireMasterProfile(ctx, user);
    const input = Input.body(ctx.body);
    const type = input.oneOf('type', TYPES);
    const comment = input.string('comment', { optional: true, nullable: true, max: 1000 }) ?? null;
    const period = type !== undefined && isPeriod(type);
    const startsOn = period ? input.date('startsOn') : undefined;
    const endsOn = period ? input.date('endsOn') : undefined;
    const validFrom = type === 'schedule' ? input.date('validFrom') : undefined;
    const days = type === 'schedule' ? readDays(input) : undefined;
    if (input.valid && period && endsOn! < startsOn!) input.fail('endsOn', 'Последний день раньше первого');
    if (input.valid && type === 'other' && !comment) input.fail('comment', 'Опишите просьбу: администратор решает по тексту');
    input.done();

    const today = zonedDate(ctx.now.getTime(), readSettings(ctx.db).timezone);
    // Прошедшие даты менять поздно: слоты на них уже считались, а записи прошли
    if (period && startsOn! < today) throw badRequest('DATE_IN_PAST', 'Эта дата уже прошла');
    if (type === 'schedule' && validFrom! < today) throw badRequest('DATE_IN_PAST', 'Новый график может начаться не раньше сегодняшнего дня');

    const id = Number(ctx.db.prepare(`
      INSERT INTO master_requests (master_id, created_by, type, starts_on, ends_on, valid_from, payload, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(master.id, user.id, type, startsOn ?? null, endsOn ?? null, validFrom ?? null,
      days ? JSON.stringify(days) : null, comment, ctx.now.toISOString()).lastInsertRowid);
    return { status: 201, body: { request: requestView(getRequest(ctx.db, id)!) } };
  });

  // Отозвать свою заявку, пока она на рассмотрении. Решенную заявку не трогаем: это история.
  router.post('/api/master/requests/:id/cancel', (ctx): Result => {
    const user = requireRole(ctx, 'master');
    const master = requireMasterProfile(ctx, user);
    const id = pathId(ctx);
    Input.body(ctx.body).done();
    const request = getRequest(ctx.db, id);
    if (!request || request.master_id !== master.id) throw notFound('Заявка не найдена');
    if (request.status !== 'pending') throw conflict('REQUEST_ALREADY_DECIDED', 'Заявка уже рассмотрена');
    ctx.db.prepare("UPDATE master_requests SET status = 'cancelled' WHERE id = ?").run(id);
    return { status: 200, body: { request: requestView(getRequest(ctx.db, id)!) } };
  });

  // ---------- Администратор: рассмотрение ----------

  router.get('/api/admin/requests', (ctx): Result => {
    const input = Input.query(ctx.query);
    const status = input.oneOf('status', STATUSES, { optional: true });
    const masterId = input.id('masterId', { optional: true });
    input.done();
    const rows = ctx.db.prepare(`${SELECT}
      WHERE (@status IS NULL OR r.status = @status) AND (@master IS NULL OR r.master_id = @master)
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC
    `).all({ status: status ?? null, master: masterId ?? null }) as unknown as RequestRow[];
    const { pending } = ctx.db.prepare("SELECT count(*) AS pending FROM master_requests WHERE status = 'pending'")
      .get() as { pending: number };
    // Счетчик новых заявок приходит вместе со списком: пункту меню не нужен отдельный запрос
    return { status: 200, body: { pendingCount: pending, requests: rows.map(requestView) } };
  });

  // Записи, которые заденет одобрение: их показывают в окне подтверждения до нажатия «Одобрить».
  router.get('/api/admin/requests/:id/affected', (ctx): Result => {
    const request = getRequest(ctx.db, pathId(ctx));
    if (!request) throw notFound('Заявка не найдена');
    const affected = affectedByRequest(ctx.db, request);
    return { status: 200, body: { affectedBookings: bookingViews(ctx.db, affected, { viewer: 'admin', now: ctx.now }) } };
  });

  // Одобрить: заявка применяется сразу — блокировка времени или новый график. Записи, которые в нее
  // не помещаются, приходят в ответе: база их не трогает, администратор переносит или отменяет их сам.
  router.post('/api/admin/requests/:id/approve', (ctx): Result => {
    const user = requireUser(ctx);
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const reason = input.string('reason', { optional: true, nullable: true, max: 500 }) ?? null;
    const dryRun = input.bool('dryRun', { optional: true }) ?? false;
    input.done();

    const affected = applyOrPreview(ctx.db, dryRun, () => {
      const request = getRequest(ctx.db, id);
      if (!request) throw notFound('Заявка не найдена');
      if (request.status !== 'pending') throw conflict('REQUEST_ALREADY_DECIDED', 'Заявка уже рассмотрена');

      let timeBlockId: number | null = null;
      if (isPeriod(request.type)) {
        const { startsAt, endsAt } = periodRange(ctx.db, request.starts_on!, request.ends_on!);
        timeBlockId = insertTimeBlock(ctx.db, {
          masterId: request.master_id, type: BLOCK_OF[request.type]!, startsAt, endsAt,
          comment: request.comment, createdBy: user.id, createdAt: ctx.now.toISOString(),
        });
      } else if (request.type === 'schedule') {
        saveWeeklySchedule(ctx.db, request.master_id, request.valid_from!, JSON.parse(request.payload!) as ScheduleDay[]);
      }
      // Свободная заявка ничего не применяет: администратор делает нужное сам и просто отмечает решение

      ctx.db.prepare(`
        UPDATE master_requests SET status = 'approved', decided_by = ?, decided_at = ?, decision_reason = ?, time_block_id = ?
        WHERE id = ?
      `).run(user.id, ctx.now.toISOString(), reason, timeBlockId, id);
      return affectedByRequest(ctx.db, getRequest(ctx.db, id)!);
    });

    return {
      status: 200,
      body: {
        // При dryRun транзакция откатилась: заявка осталась на рассмотрении, показываем ее как есть
        request: requestView(getRequest(ctx.db, id)!),
        affectedBookings: bookingViews(ctx.db, affected, { viewer: 'admin', now: ctx.now }),
      },
    };
  });

  // Отклонить с причиной: мастер увидит ее в своих заявках. Расписание не меняется.
  router.post('/api/admin/requests/:id/reject', (ctx): Result => {
    const user = requireUser(ctx);
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const reason = input.string('reason', { max: 500 });
    input.done();
    transaction(ctx.db, () => {
      const request = getRequest(ctx.db, id);
      if (!request) throw notFound('Заявка не найдена');
      if (request.status !== 'pending') throw conflict('REQUEST_ALREADY_DECIDED', 'Заявка уже рассмотрена');
      ctx.db.prepare(`
        UPDATE master_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_reason = ? WHERE id = ?
      `).run(user.id, ctx.now.toISOString(), reason, id);
    });
    return { status: 200, body: { request: requestView(getRequest(ctx.db, id)!) } };
  });
}
