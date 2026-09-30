// Настройки студии и витрины (паспорт, функция 10 администратора): контакты и ссылки, часовой пояс,
// режим технических работ, правила записи и обычный режим работы по дням недели.
// Избранные услуги для главной — isFeatured в PATCH /api/admin/services/:id, рассказ о мастере — bio мастера.
// Доступ: весь /api/admin/* закрывает одна проверка requireAdmin (api/guards.ts), ее вызывает app.ts до поиска
// маршрута. В обработчиках роль не проверяется; пользователя они берут через requireUser.
import { applyOrPreview, bookingsOutsideWorkingHours } from '../booking/affected.js';
import type { Db } from '../db/connection.js';
import type { Result, Router } from '../http/router.js';
import { Input, type Parsed } from '../http/validate.js';
import { readSettings } from '../studio/settings.js';
import { bookingViews } from './views.js';

function settingsView(db: Db) {
  const s = readSettings(db);
  const hours = db.prepare('SELECT weekday, open_time, close_time FROM studio_hours ORDER BY weekday').all() as
    { weekday: number; open_time: string; close_time: string }[];
  return {
    studioName: s.studio_name, address: s.address, phone: s.phone,
    mapUrl: s.map_url, vkUrl: s.vk_url, telegramUrl: s.telegram_url,
    timezone: s.timezone,
    slotStepMin: s.slot_step_min, bookingHorizonDays: s.booking_horizon_days, minLeadMin: s.min_lead_min,
    clientChangeDeadlineHours: s.client_change_deadline_hours, slotHoldMin: s.slot_hold_min,
    isMaintenance: s.is_maintenance === 1,
    hours: hours.map((h) => ({ weekday: h.weekday, open: h.open_time, close: h.close_time })),
  };
}

/** Ссылка на карту или соцсеть: только http(s), чтобы в витрину не попала ссылка javascript:. */
const url = (raw: unknown): Parsed<string> =>
  typeof raw === 'string' && /^https?:\/\/\S+$/.test(raw.trim()) && raw.length <= 500
    ? { value: raw.trim() }
    : { error: 'Нужна ссылка, начинающаяся с https://' };

/** Часовой пояс IANA, который знает Node: Europe/Moscow, Asia/Yekaterinburg. */
const timezone = (raw: unknown): Parsed<string> => {
  if (typeof raw !== 'string') return { error: 'Нужен часовой пояс, например Europe/Moscow' };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return { value: raw };
  } catch {
    return { error: 'Неизвестный часовой пояс, пример: Europe/Moscow' };
  }
};

export function adminSettingsRoutes(router: Router): void {
  router.get('/api/admin/settings', (ctx): Result => {
    return { status: 200, body: { settings: settingsView(ctx.db) } };
  });

  // Передаются только меняемые поля. Правила записи сразу меняют расчет свободного времени;
  // созданные записи и брони остаются как есть.
  router.patch('/api/admin/settings', (ctx): Result => {
    const input = Input.body(ctx.body);
    const fields: Record<string, string | number | null | undefined> = {
      studio_name: input.string('studioName', { optional: true, max: 100 }),
      address: input.string('address', { optional: true, max: 300 }),
      phone: input.phone('phone', { optional: true }),
      map_url: input.field('mapUrl', { optional: true, nullable: true }, url),
      vk_url: input.field('vkUrl', { optional: true, nullable: true }, url),
      telegram_url: input.field('telegramUrl', { optional: true, nullable: true }, url),
      timezone: input.field('timezone', { optional: true }, timezone),
      slot_step_min: input.int('slotStepMin', { optional: true, min: 5, max: 240 }),
      booking_horizon_days: input.int('bookingHorizonDays', { optional: true, min: 1, max: 365 }),
      min_lead_min: input.int('minLeadMin', { optional: true, min: 0, max: 7 * 24 * 60 }),
      client_change_deadline_hours: input.int('clientChangeDeadlineHours', { optional: true, min: 0, max: 7 * 24 }),
      slot_hold_min: input.int('slotHoldMin', { optional: true, min: 1, max: 60 }),
    };
    const maintenance = input.bool('isMaintenance', { optional: true });
    if (maintenance !== undefined) fields.is_maintenance = maintenance ? 1 : 0;
    input.done();

    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string | number | null>;
    const columns = Object.keys(set);
    if (columns.length > 0) {
      ctx.db.prepare(`UPDATE settings SET ${columns.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = 1`)
        .run({ ...set, updated_at: ctx.now.toISOString() });
    }
    return { status: 200, body: { settings: settingsView(ctx.db) } };
  });

  // Обычный режим работы студии по дням недели (раздел 5.2). Дня нет в списке — студия в этот день закрыта.
  // В ответе — предстоящие записи, которые в новый режим не помещаются; с dryRun: true режим не сохраняется.
  router.put('/api/admin/studio-hours', (ctx): Result => {
    const input = Input.body(ctx.body);
    const days = input.objects('days', (d) => ({
      weekday: d.int('weekday', { min: 1, max: 7 }),
      open: d.time('open'),
      close: d.time('close'),
    }), { max: 7 });
    const dryRun = input.bool('dryRun', { optional: true }) ?? false;
    if (input.valid) {
      if (new Set(days.map((d) => d.weekday)).size !== days.length) input.fail('days', 'День недели повторяется');
      days.forEach((d, i) => {
        if (d.close <= d.open) input.fail(`days[${i}].close`, 'Закрытие должно быть позже открытия');
      });
    }
    input.done();

    const affected = applyOrPreview(ctx.db, dryRun, () => {
      ctx.db.prepare('DELETE FROM studio_hours').run();
      const insert = ctx.db.prepare('INSERT INTO studio_hours (weekday, open_time, close_time) VALUES (?, ?, ?)');
      for (const d of days) insert.run(d.weekday, d.open, d.close);
      return bookingsOutsideWorkingHours(ctx.db, { from: ctx.now.toISOString() });
    });
    return {
      status: 200,
      body: { settings: settingsView(ctx.db), affectedBookings: bookingViews(ctx.db, affected, { viewer: 'admin', now: ctx.now }) },
    };
  });
}
