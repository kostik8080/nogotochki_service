// Расчет свободного времени мастера по docs/db-schema.md, раздел 7.
// Слоты нигде не хранятся: каждый вызов считает их заново из режима студии, графика мастера,
// изменений на дату, блокировок, записей и чужих действующих броней (раздел 7.5).
// Расчет только показывает варианты. Окончательно занятость проверяют триггеры базы
// при создании брони и записи (раздел 10), поэтому гонки здесь не страшны.
//
// Промежутки полуоткрытые [начало, конец): запись до 12:00 и запись с 12:00 не пересекаются.
// Моменты внутри модуля — миллисекунды UTC, наружу отдаются строки ISO (как в базе) и время студии 'HH:MM'.
import type { Db } from '../db/connection.js';
import { addDays, isoWeekday, zonedDate, zonedTime, zonedTimeToUtc } from '../lib/studio-time.js';

const MINUTE = 60_000;
/** Наибольшая уборка после услуги: CHECK (cleanup_min BETWEEN 0 AND 60) в services. */
const MAX_CLEANUP_MIN = 60;
/** Статусы записи, которые занимают время мастера (раздел 5.19, решение 8). */
const OCCUPYING = "('active', 'completed', 'no_show')";

export interface Interval {
  start: number;
  end: number;
}

/** Режим дня мастера по правилам раздела 7.2. */
export type MasterDay =
  /** Мастер работает; окно — пересечение его смены с часами студии. */
  | { status: 'open'; date: string; window: Interval; studioReason: string | null }
  /** Студия закрыта: особый день (причина есть) или обычный выходной студии (причины нет). */
  | { status: 'studio_closed'; date: string; reason: string | null }
  /** По графику или изменению на дату мастер не работает, либо его смена не пересекается с часами студии. */
  | { status: 'master_off'; date: string }
  /** Мастер отключен и не получает свободного времени (правило 3). */
  | { status: 'master_inactive'; date: string };

export interface Slot {
  /** Начало и конец визита, UTC, формат базы. Конец — без уборки: его видит клиент. */
  startsAt: string;
  endsAt: string;
  /** Время начала по часам студии. */
  time: string;
}

export interface SlotQuery {
  masterId: number;
  /** Дата по календарю студии, 'YYYY-MM-DD'. */
  date: string;
  /** Длительность визита D — сумма длительностей услуг (getVisitTiming). */
  durationMin: number;
  /** Уборка после визита C — наибольшая среди услуг. */
  cleanupMin: number;
  /** Текущий момент: от него считаются действующие брони, минимальное время до визита и горизонт. */
  now: Date;
  /**
   * Кто смотрит расчет. Клиент связан минимальным временем до визита и горизонтом записи,
   * администратор — нет (раздел 7.3, шаг 6).
   */
  audience: 'client' | 'admin';
  /** Пользователь, чья бронь не считается помехой: он сам ее держит. */
  viewerId?: number | null;
  /** Переносимая запись: ее время не считается занятым (CAB-04, A-04). */
  excludeBookingId?: number | null;
}

interface Settings {
  timezone: string;
  slot_step_min: number;
  booking_horizon_days: number;
  min_lead_min: number;
}

function readSettings(db: Db): Settings {
  const settings = db.prepare(
    'SELECT timezone, slot_step_min, booking_horizon_days, min_lead_min FROM settings WHERE id = 1',
  ).get() as Settings | undefined;
  if (!settings) throw new Error('Нет строки настроек студии: примените миграции');
  return settings;
}

const maxTime = (a: string, b: string) => (a > b ? a : b);
const minTime = (a: string, b: string) => (a < b ? a : b);
const toMs = (iso: string) => Date.parse(iso);
const toIso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Шаги 2–3: режим дня
// ---------------------------------------------------------------------------

/** Режим дня мастера: работает ли он и в каком окне (разделы 7.2 и 7.3, шаги 2–3). */
export function getMasterDay(db: Db, masterId: number, date: string): MasterDay {
  const { timezone } = readSettings(db);
  const master = db.prepare('SELECT is_active FROM masters WHERE id = ?').get(masterId) as { is_active: number } | undefined;
  if (!master) throw new Error(`Мастер ${masterId} не найден`);

  // Правило 1: студия важнее мастера. Особый день важнее режима по дню недели.
  const weekday = isoWeekday(date);
  const special = db.prepare(
    'SELECT is_open, open_time, close_time, reason FROM studio_day_overrides WHERE work_date = ?',
  ).get(date) as { is_open: number; open_time: string | null; close_time: string | null; reason: string } | undefined;
  let studio: { open: string; close: string } | undefined;
  if (special) {
    if (!special.is_open) return { status: 'studio_closed', date, reason: special.reason };
    studio = { open: special.open_time!, close: special.close_time! };
  } else {
    const hours = db.prepare('SELECT open_time, close_time FROM studio_hours WHERE weekday = ?')
      .get(weekday) as { open_time: string; close_time: string } | undefined;
    if (!hours) return { status: 'studio_closed', date, reason: null };
    studio = { open: hours.open_time, close: hours.close_time };
  }

  // Правило 3: отключенный мастер не работает, какой бы ни был график.
  if (!master.is_active) return { status: 'master_inactive', date };

  // Правило 2: изменение на дату важнее недельного графика, действующего на эту дату.
  const override = db.prepare(
    'SELECT is_working, start_time, end_time FROM master_day_overrides WHERE master_id = ? AND work_date = ?',
  ).get(masterId, date) as { is_working: number; start_time: string | null; end_time: string | null } | undefined;
  let shift: { start: string; end: string } | undefined;
  if (override) {
    if (!override.is_working) return { status: 'master_off', date };
    shift = { start: override.start_time!, end: override.end_time! };
  } else {
    const weekly = db.prepare(`
      SELECT start_time, end_time FROM master_weekly_hours
      WHERE master_id = ? AND weekday = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
    `).get(masterId, weekday, date, date) as { start_time: string; end_time: string } | undefined;
    if (!weekly) return { status: 'master_off', date };
    shift = { start: weekly.start_time, end: weekly.end_time };
  }

  // Шаг 3: рабочее окно — пересечение смены с часами студии. Время 'HH:MM' сравнивается как строки.
  const start = maxTime(shift.start, studio.open);
  const end = minTime(shift.end, studio.close);
  if (end <= start) return { status: 'master_off', date };
  return {
    status: 'open',
    date,
    window: { start: zonedTimeToUtc(date, start, timezone), end: zonedTimeToUtc(date, end, timezone) },
    studioReason: special?.reason ?? null,
  };
}

// ---------------------------------------------------------------------------
// Шаг 4: занятое время и свободные интервалы
// ---------------------------------------------------------------------------

interface Busy {
  /** Записи и чужие брони вместе с уборкой после них: [starts_at, busy_until). */
  clients: Interval[];
  /** Блокировки мастера. */
  blocks: Interval[];
}

/** Занятое время мастера, которое задевает промежуток [from, to). */
function loadBusy(db: Db, masterId: number, from: number, to: number, q: Pick<SlotQuery, 'now' | 'viewerId' | 'excludeBookingId'>): Busy {
  const params = { master: masterId, from: toIso(from), to: toIso(to) };
  const bookings = db.prepare(`
    SELECT starts_at, busy_until FROM bookings
    WHERE master_id = @master AND status IN ${OCCUPYING}
      AND starts_at < @to AND busy_until > @from
      AND id IS NOT @exclude
  `).all({ ...params, exclude: q.excludeBookingId ?? null }) as { starts_at: string; busy_until: string }[];
  // Чужие действующие брони: истекшая бронь не мешает, даже если строка еще не удалена (раздел 8).
  const holds = db.prepare(`
    SELECT starts_at, busy_until FROM slot_holds
    WHERE master_id = @master AND expires_at > @now
      AND starts_at < @to AND busy_until > @from
      AND owner_id IS NOT @viewer
  `).all({ ...params, now: q.now.toISOString(), viewer: q.viewerId ?? null }) as { starts_at: string; busy_until: string }[];
  const blocks = db.prepare(`
    SELECT starts_at, ends_at FROM time_blocks
    WHERE master_id = @master AND starts_at < @to AND ends_at > @from
  `).all(params) as { starts_at: string; ends_at: string }[];

  return {
    clients: [...bookings, ...holds].map((r) => ({ start: toMs(r.starts_at), end: toMs(r.busy_until) })),
    blocks: blocks.map((r) => ({ start: toMs(r.starts_at), end: toMs(r.ends_at) })),
  };
}

/** Окно минус занятые промежутки, по возрастанию. */
function subtract(window: Interval, busy: Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of [...busy].sort((x, y) => x.start - y.start)) {
    if (b.end <= cursor) continue;
    if (b.start >= window.end) break;
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}

/**
 * Свободные интервалы мастера на день: рабочее окно минус записи с уборкой, блокировки
 * и чужие действующие брони (раздел 7.3, шаг 4). Нужны сами по себе: «свободные часы»
 * в шахматке и «ближайшие окна» в панели записи.
 */
export function getFreeIntervals(
  db: Db,
  q: Pick<SlotQuery, 'masterId' | 'date' | 'now' | 'viewerId' | 'excludeBookingId'>,
): Interval[] {
  const day = getMasterDay(db, q.masterId, q.date);
  if (day.status !== 'open') return [];
  const busy = loadBusy(db, q.masterId, day.window.start, day.window.end, q);
  return subtract(day.window, [...busy.clients, ...busy.blocks]);
}

// ---------------------------------------------------------------------------
// Шаги 5–6: слоты
// ---------------------------------------------------------------------------

/** Моменты, с которых можно начать визит длительностью D у этого мастера в этот день (раздел 7.3, шаги 5–6). */
export function getSlots(db: Db, q: SlotQuery): Slot[] {
  if (!Number.isInteger(q.durationMin) || q.durationMin <= 0) throw new Error(`Длительность визита ${q.durationMin}: нужно целое число минут больше 0`);
  if (!Number.isInteger(q.cleanupMin) || q.cleanupMin < 0) throw new Error(`Уборка ${q.cleanupMin}: нужно целое число минут от 0`);

  const settings = readSettings(db);
  const now = q.now.getTime();

  // Шаг 6, горизонт: клиенту открыты даты с сегодняшней по сегодня + booking_horizon_days − 1
  // (90 дней, считая сегодняшний, — как календарь прототипа).
  if (q.audience === 'client') {
    const today = zonedDate(now, settings.timezone);
    if (q.date > addDays(today, settings.booking_horizon_days - 1)) return [];
  }

  const day = getMasterDay(db, q.masterId, q.date);
  if (day.status !== 'open') return [];

  const visit = q.durationMin * MINUTE;
  const visitWithCleanup = (q.durationMin + q.cleanupMin) * MINUTE;
  // Уборка может выйти за конец окна, и за концом смены может оказаться запись (например, созданная
  // администратором). Поэтому занятое время читается с запасом на наибольшую уборку.
  const busy = loadBusy(db, q.masterId, day.window.start, day.window.end + MAX_CLEANUP_MIN * MINUTE, q);
  const free = subtract(day.window, [...busy.clients, ...busy.blocks]);
  const earliest = q.audience === 'client' ? now + settings.min_lead_min * MINUTE : -Infinity;

  const slots: Slot[] = [];
  // Кандидаты — начало окна, затем с шагом slot_step_min.
  for (let t = day.window.start; t + visit <= day.window.end; t += settings.slot_step_min * MINUTE) {
    if (t < earliest) continue;
    // Сам визит целиком внутри одного свободного интервала.
    if (!free.some((f) => t >= f.start && t + visit <= f.end)) continue;
    // Визит с уборкой не задевает записи и чужие брони. Блокировки и конец смены уборке не мешают.
    if (busy.clients.some((c) => c.start < t + visitWithCleanup && c.end > t)) continue;
    slots.push({ startsAt: toIso(t), endsAt: toIso(t + visit), time: zonedTime(t, settings.timezone) });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Визит из нескольких услуг и «Любой свободный мастер»
// ---------------------------------------------------------------------------

/**
 * Длительность D и уборка C визита из этих услуг: D — сумма длительностей, C — наибольшая уборка
 * (раздел 5.20, решение 32). Опция «Дизайн ногтей» добавляет свои 30 минут при любом количестве,
 * поэтому количество на расчет не влияет.
 */
export function getVisitTiming(db: Db, serviceIds: number[]): { durationMin: number; cleanupMin: number } {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) throw new Error('В визите нет услуг');
  const rows = db.prepare(
    `SELECT id, duration_min, cleanup_min FROM services WHERE id IN (${ids.map(() => '?').join(', ')})`,
  ).all(...ids) as { id: number; duration_min: number; cleanup_min: number }[];
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length > 0) throw new Error(`Услуги не найдены: ${missing.join(', ')}`);
  return {
    durationMin: rows.reduce((sum, r) => sum + r.duration_min, 0),
    cleanupMin: Math.max(...rows.map((r) => r.cleanup_min)),
  };
}

/** Активные мастера, которые выполняют все эти услуги (раздел 6), по порядку показа. */
export function findMastersForServices(db: Db, serviceIds: number[]): number[] {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return [];
  const rows = db.prepare(`
    SELECT m.id FROM masters m
    JOIN master_services ms ON ms.master_id = m.id
    WHERE m.is_active = 1 AND ms.service_id IN (${ids.map(() => '?').join(', ')})
    GROUP BY m.id
    HAVING count(DISTINCT ms.service_id) = ?
    ORDER BY m.sort_order, m.id
  `).all(...ids, ids.length) as { id: number }[];
  return rows.map((r) => r.id);
}

export interface AnyMasterSlot extends Slot {
  /** Мастера, свободные в этот слот, по порядку показа. Кого из них назначить, решается при создании брони. */
  masterIds: number[];
}

/**
 * Слоты варианта «Любой свободный мастер» (BOOK-02): расчет для каждого мастера, который выполняет
 * все услуги визита, и объединение по времени начала (раздел 7.3).
 */
export function getSlotsAnyMaster(
  db: Db,
  q: Omit<SlotQuery, 'masterId' | 'durationMin' | 'cleanupMin'> & { serviceIds: number[] },
): AnyMasterSlot[] {
  const timing = getVisitTiming(db, q.serviceIds);
  const byStart = new Map<string, AnyMasterSlot>();
  for (const masterId of findMastersForServices(db, q.serviceIds)) {
    for (const slot of getSlots(db, { ...q, ...timing, masterId })) {
      const existing = byStart.get(slot.startsAt);
      if (existing) existing.masterIds.push(masterId);
      else byStart.set(slot.startsAt, { ...slot, masterIds: [masterId] });
    }
  }
  return [...byStart.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
