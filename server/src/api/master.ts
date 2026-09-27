// Раздел мастера (паспорт: мастерам «нужно заранее знать свое расписание записей»). Только чтение:
// мастер видит свои рабочие дни, записи и блокировки, но записи не создает, не переносит и не отменяет —
// это делает администратор (функции booking-service отвечают мастеру 403).
// Из данных клиента мастеру видно только то, что нужно для визита: имя и поле «Важно» (аллергии,
// особенности). Телефон и e-mail клиента мастеру не показываются.
import { getMasterDay } from '../booking/slots.js';
import type { Db } from '../db/connection.js';
import type { Result, Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { addDays, zonedDate, zonedTimeToUtc } from '../lib/studio-time.js';
import { readSettings } from '../studio/settings.js';
import { requireMasterProfile, requireRole } from './guards.js';

/** Самый длинный период за один запрос — месяц. */
const MAX_DAYS = 31;

export function masterRoutes(router: Router): void {
  router.get('/api/master/schedule', (ctx): Result => {
    const user = requireRole(ctx, 'master');
    const input = Input.query(ctx.query);
    const { timezone } = readSettings(ctx.db);
    const today = zonedDate(ctx.now.getTime(), timezone);
    const from = input.date('from', { optional: true }) ?? today;
    const to = input.date('to', { optional: true }) ?? addDays(from, 6);
    if (input.valid && to < from) input.fail('to', 'Конец периода раньше начала');
    if (input.valid && to > addDays(from, MAX_DAYS - 1)) input.fail('to', `Период не длиннее ${MAX_DAYS} дней`);
    input.done();

    // Третья проверка: мастер смотрит только свое расписание — профиль ищется по masters.user_id.
    const master = requireMasterProfile(ctx, user);

    const days = [];
    for (let date = from; date <= to; date = addDays(date, 1)) days.push(dayView(ctx.db, master.id, date, timezone));
    return { status: 200, body: { master, timezone, from, to, days } };
  });
}

function dayView(db: Db, masterId: number, date: string, timezone: string) {
  const dayFrom = new Date(zonedTimeToUtc(date, '00:00', timezone)).toISOString();
  const dayTo = new Date(zonedTimeToUtc(addDays(date, 1), '00:00', timezone)).toISOString();
  const day = getMasterDay(db, masterId, date);

  const bookings = db.prepare(`
    SELECT b.id, b.starts_at, b.ends_at, b.busy_until, b.status, b.is_overbooking, b.comment,
           u.name AS client_name, cp.important_note
    FROM bookings b
    JOIN users u ON u.id = b.client_id
    LEFT JOIN client_profiles cp ON cp.user_id = b.client_id
    WHERE b.master_id = ? AND b.starts_at >= ? AND b.starts_at < ?
      AND b.status IN ('active', 'completed', 'no_show')
    ORDER BY b.starts_at
  `).all(masterId, dayFrom, dayTo) as {
    id: number; starts_at: string; ends_at: string; busy_until: string; status: string; is_overbooking: number;
    comment: string | null; client_name: string; important_note: string | null;
  }[];
  const items = bookings.length === 0 ? [] : db.prepare(`
    SELECT booking_id, service_name, quantity, duration_min FROM booking_items
    WHERE booking_id IN (${bookings.map(() => '?').join(', ')}) ORDER BY booking_id, position
  `).all(...bookings.map((b) => b.id)) as { booking_id: number; service_name: string; quantity: number; duration_min: number }[];
  const blocks = db.prepare(`
    SELECT block_type, starts_at, ends_at, comment FROM time_blocks
    WHERE master_id = ? AND starts_at < ? AND ends_at > ? ORDER BY starts_at
  `).all(masterId, dayTo, dayFrom) as { block_type: string; starts_at: string; ends_at: string; comment: string | null }[];

  return {
    date,
    status: day.status,
    // Рабочее окно мастера в этот день (UTC); у закрытого дня — причина, если это особый день студии.
    window: day.status === 'open' ? { start: new Date(day.window.start).toISOString(), end: new Date(day.window.end).toISOString() } : null,
    reason: day.status === 'studio_closed' ? day.reason : null,
    bookings: bookings.map((b) => ({
      id: b.id, startsAt: b.starts_at, endsAt: b.ends_at, busyUntil: b.busy_until, status: b.status,
      isOverbooking: b.is_overbooking === 1,
      services: items.filter((i) => i.booking_id === b.id).map((i) => ({ name: i.service_name, quantity: i.quantity, durationMin: i.duration_min })),
      comment: b.comment,
      client: { name: b.client_name, importantNote: b.important_note },
    })),
    timeBlocks: blocks.map((t) => ({ type: t.block_type, startsAt: t.starts_at, endsAt: t.ends_at, comment: t.comment })),
  };
}
