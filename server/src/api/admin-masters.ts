// Управление мастерами (паспорт, функция 3 администратора; экраны A-19, A-22, A-22p).
// Мастера не удаляются: на них ссылаются записи. Вместо удаления — isActive: false, отключенного мастера
// не предлагают клиентам, но он остается в истории записей.
import { applyOrPreview, bookingsOutsideWorkingHours } from '../booking/affected.js';
import type { Db } from '../db/connection.js';
import { transaction } from '../db/connection.js';
import { badRequest, notFound } from '../http/errors.js';
import { pathId, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { addDays, zonedDate, zonedTimeToUtc } from '../lib/studio-time.js';
import { readSettings } from '../studio/settings.js';
import { requireRole } from './guards.js';
import { bookingViews } from './views.js';

interface MasterRow {
  id: number;
  name: string;
  level: 'master' | 'top_master';
  specialty: string | null;
  experience_years: number | null;
  bio: string | null;
  photo_url: string | null;
  sort_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface ScheduleDay {
  weekday: number;
  start: string;
  end: string;
}

const getMaster = (db: Db, id: number) => db.prepare(`
  SELECT id, name, level, specialty, experience_years, bio, photo_url, sort_order, is_active, created_at, updated_at
  FROM masters WHERE id = ?
`).get(id) as MasterRow | undefined;

/** Мастер для администратора: услуги и график — действующий и будущие периоды, прошедшие не показываются. */
function masterView(db: Db, m: MasterRow, today: string) {
  const serviceIds = (db.prepare('SELECT service_id FROM master_services WHERE master_id = ? ORDER BY service_id').all(m.id) as
    { service_id: number }[]).map((r) => r.service_id);
  const schedule = db.prepare(`
    SELECT weekday, valid_from, valid_to, start_time, end_time FROM master_weekly_hours
    WHERE master_id = ? AND (valid_to IS NULL OR valid_to >= ?)
    ORDER BY valid_from, weekday
  `).all(m.id, today) as { weekday: number; valid_from: string; valid_to: string | null; start_time: string; end_time: string }[];
  return {
    id: m.id, name: m.name, level: m.level, specialty: m.specialty, experienceYears: m.experience_years, bio: m.bio,
    photoUrl: m.photo_url, sortOrder: m.sort_order, isActive: m.is_active === 1, serviceIds,
    schedule: schedule.map((s) => ({ weekday: s.weekday, validFrom: s.valid_from, validTo: s.valid_to, start: s.start_time, end: s.end_time })),
    createdAt: m.created_at, updatedAt: m.updated_at,
  };
}

function readMasterFields(input: Input, creating: boolean) {
  return {
    name: input.string('name', { optional: !creating, max: 100 }),
    level: input.oneOf('level', ['master', 'top_master'] as const, { optional: true }),
    specialty: input.string('specialty', { optional: true, nullable: true, max: 200 }),
    experienceYears: input.int('experienceYears', { optional: true, nullable: true, min: 0, max: 80 }),
    bio: input.string('bio', { optional: true, nullable: true, max: 1000 }),
    photoUrl: input.string('photoUrl', { optional: true, nullable: true, max: 500 }),
    sortOrder: input.int('sortOrder', { optional: true, min: 0, max: 100_000 }),
    isActive: input.bool('isActive', { optional: true }),
    serviceIds: input.ids('serviceIds', { optional: true }),
  };
}

/** Недельный график: дата начала и рабочие дни. Пустой список дней — мастер с этой даты не работает (уход). */
function readSchedule(input: Input) {
  const validFrom = input.date('validFrom');
  const days = input.objects('days', (d): ScheduleDay => ({
    weekday: d.int('weekday', { min: 1, max: 7 }),
    start: d.time('start'),
    end: d.time('end'),
  }), { max: 7 });
  if (input.valid) {
    if (new Set(days.map((d) => d.weekday)).size !== days.length) input.fail('days', 'День недели повторяется');
    days.forEach((d, i) => {
      if (d.end <= d.start) input.fail(`days[${i}].end`, 'Конец смены должен быть позже начала');
    });
  }
  return { validFrom, days };
}

function checkServices(db: Db, serviceIds: number[] | undefined): void {
  if (!serviceIds?.length) return;
  const found = db.prepare(`SELECT count(*) AS n FROM services WHERE id IN (${serviceIds.map(() => '?').join(', ')})`)
    .get(...serviceIds) as { n: number };
  if (found.n !== serviceIds.length) throw badRequest('SERVICE_NOT_FOUND', 'Одна из услуг не найдена', { serviceIds });
}

function saveServices(db: Db, masterId: number, serviceIds: number[] | undefined): void {
  if (serviceIds === undefined) return;
  db.prepare('DELETE FROM master_services WHERE master_id = ?').run(masterId);
  const insert = db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)');
  for (const serviceId of serviceIds) insert.run(masterId, serviceId);
}

/**
 * Новый график с даты (раздел 10.6, сценарий 14): текущие строки закрываются днем накануне,
 * будущие периоды, начинающиеся с этой даты или позже, заменяются новыми. В одной транзакции.
 */
function saveSchedule(db: Db, masterId: number, validFrom: string, days: ScheduleDay[]): void {
  db.prepare('DELETE FROM master_weekly_hours WHERE master_id = ? AND valid_from >= ?').run(masterId, validFrom);
  db.prepare(`
    UPDATE master_weekly_hours SET valid_to = ?
    WHERE master_id = ? AND valid_from < ? AND (valid_to IS NULL OR valid_to >= ?)
  `).run(addDays(validFrom, -1), masterId, validFrom, validFrom);
  const insert = db.prepare(`
    INSERT INTO master_weekly_hours (master_id, weekday, valid_from, valid_to, start_time, end_time) VALUES (?, ?, ?, NULL, ?, ?)
  `);
  for (const d of days) insert.run(masterId, d.weekday, validFrom, d.start, d.end);
}

export function adminMasterRoutes(router: Router): void {
  router.get('/api/admin/masters', (ctx): Result => {
    requireRole(ctx, 'admin');
    const today = zonedDate(ctx.now.getTime(), readSettings(ctx.db).timezone);
    const rows = ctx.db.prepare('SELECT id FROM masters ORDER BY sort_order, id').all() as { id: number }[];
    return { status: 200, body: { masters: rows.map((r) => masterView(ctx.db, getMaster(ctx.db, r.id)!, today)) } };
  });

  // Новый мастер: профиль, услуги и, если передан, недельный график с даты начала работы.
  router.post('/api/admin/masters', (ctx): Result => {
    requireRole(ctx, 'admin');
    const input = Input.body(ctx.body);
    const f = readMasterFields(input, true);
    const schedule = input.object('schedule', readSchedule, { optional: true });
    input.done();

    const now = ctx.now.toISOString();
    const today = zonedDate(ctx.now.getTime(), readSettings(ctx.db).timezone);
    const id = transaction(ctx.db, () => {
      checkServices(ctx.db, f.serviceIds);
      const id = Number(ctx.db.prepare(`
        INSERT INTO masters (name, level, specialty, experience_years, bio, photo_url, sort_order, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(f.name!, f.level ?? 'master', f.specialty ?? null, f.experienceYears ?? null, f.bio ?? null, f.photoUrl ?? null,
        f.sortOrder ?? 0, f.isActive === false ? 0 : 1, now, now).lastInsertRowid);
      saveServices(ctx.db, id, f.serviceIds);
      if (schedule) saveSchedule(ctx.db, id, schedule.validFrom, schedule.days);
      return id;
    });
    return { status: 201, body: { master: masterView(ctx.db, getMaster(ctx.db, id)!, today) } };
  });

  // Изменение мастера. Смена уровня меняет цены только новых записей (сценарий 11).
  // При отключении в ответе — предстоящие записи мастера, которые нужно перенести или отменить.
  router.patch('/api/admin/masters/:id', (ctx): Result => {
    const user = requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const f = readMasterFields(input, false);
    input.done();

    const now = ctx.now.toISOString();
    const today = zonedDate(ctx.now.getTime(), readSettings(ctx.db).timezone);
    transaction(ctx.db, () => {
      if (!getMaster(ctx.db, id)) throw notFound('Мастер не найден');
      checkServices(ctx.db, f.serviceIds);
      const set: Record<string, string | number | null> = {};
      const put = (column: string, value: string | number | null | undefined) => {
        if (value !== undefined) set[column] = value;
      };
      put('name', f.name);
      put('level', f.level);
      put('specialty', f.specialty);
      put('experience_years', f.experienceYears);
      put('bio', f.bio);
      put('photo_url', f.photoUrl);
      put('sort_order', f.sortOrder);
      put('is_active', f.isActive === undefined ? undefined : f.isActive ? 1 : 0);
      const columns = Object.keys(set);
      if (columns.length > 0) {
        ctx.db.prepare(`UPDATE masters SET ${columns.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
          .run({ ...set, updated_at: now, id });
      }
      saveServices(ctx.db, id, f.serviceIds);
    });

    const master = getMaster(ctx.db, id)!;
    const upcoming = master.is_active ? [] : (ctx.db.prepare(`
      SELECT id FROM bookings WHERE master_id = ? AND status = 'active' AND starts_at >= ? ORDER BY starts_at
    `).all(id, now) as { id: number }[]).map((r) => r.id);
    return {
      status: 200,
      body: {
        master: masterView(ctx.db, master, today),
        ...(master.is_active ? {} : { upcomingBookings: bookingViews(ctx.db, upcoming, { viewer: user.role, now: ctx.now }) }),
      },
    };
  });

  // Новый недельный график с даты (A-22p, сценарий 14): «с 1 октября Анна работает ср–сб».
  // В ответе — действующие записи с этой даты, которые в новый график не попадают.
  // С dryRun: true график не сохраняется — только показывает эти записи.
  router.put('/api/admin/masters/:id/schedule', (ctx): Result => {
    const user = requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const { validFrom, days } = readSchedule(input);
    const dryRun = input.bool('dryRun', { optional: true }) ?? false;
    input.done();

    const { timezone } = readSettings(ctx.db);
    const today = zonedDate(ctx.now.getTime(), timezone);
    // Прошедшие дни не переписываются: по ним уже считались слоты созданных записей.
    if (validFrom < today) throw badRequest('DATE_IN_PAST', 'Новый график может начаться не раньше сегодняшнего дня');

    const from = new Date(zonedTimeToUtc(validFrom, '00:00', timezone)).toISOString();
    const affected = applyOrPreview(ctx.db, dryRun, () => {
      if (!getMaster(ctx.db, id)) throw notFound('Мастер не найден');
      saveSchedule(ctx.db, id, validFrom, days);
      return bookingsOutsideWorkingHours(ctx.db, { masterId: id, from });
    });
    return {
      status: 200,
      body: {
        master: masterView(ctx.db, getMaster(ctx.db, id)!, today),
        affectedBookings: bookingViews(ctx.db, affected, { viewer: user.role, now: ctx.now }),
      },
    };
  });
}
