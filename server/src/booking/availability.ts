// Свободен ли конкретный момент для визита: тот же расчет слотов (раздел 7), что показывает календарь,
// только для одного времени начала. Сервер повторяет проверку при создании брони, записи и переноса
// внутри транзакции BEGIN IMMEDIATE: триггеры базы ловят пересечения с записями и бронями,
// но не рабочее время мастера и блокировки (раздел 10.3).
//
// Защита от двойной записи — три уровня:
//   1. сервер проверяет время в транзакции BEGIN IMMEDIATE (checkSlot);
//   2. триггеры bookings_no_overlap_insert / _update и slot_holds_no_overlap отклоняют пересечение с кодом SLOT_TAKEN;
//   3. API превращает отказ любого уровня в 409 с ближайшими свободными слотами (isSlotConflict + slotTaken).
import type { Db } from '../db/connection.js';
import { conflict, databaseErrorCode } from '../http/errors.js';
import { addDays, zonedDate } from '../lib/studio-time.js';
import { readSettings } from '../studio/settings.js';
import { getSlots, type Slot, type SlotQuery } from './slots.js';

export interface SlotCheck extends Omit<SlotQuery, 'date'> {
  /** Начало визита, UTC в формате базы. */
  startsAt: string;
}

/** Слоты мастера на день, в который попадает startsAt по календарю студии, и есть ли среди них startsAt. */
export function checkSlot(db: Db, q: SlotCheck): { available: boolean; slots: Slot[] } {
  const { timezone } = readSettings(db);
  const date = zonedDate(Date.parse(q.startsAt), timezone);
  const slots = getSlots(db, { ...q, date });
  return { available: slots.some((s) => s.startsAt === q.startsAt), slots };
}

/**
 * Время оказалось занято при проверке сервером (уровень 1). Бросается внутри транзакции, чтобы она
 * откатилась; ответ с альтернативами собирается уже после отката — по актуальным данным.
 */
export class SlotUnavailable extends Error {
  constructor() {
    super('SLOT_UNAVAILABLE');
  }
}

/** Отказ из-за занятого времени: проверка сервера или триггер базы (уровни 1 и 2). */
export function isSlotConflict(error: unknown): boolean {
  return error instanceof SlotUnavailable || databaseErrorCode(error) === 'SLOT_TAKEN';
}

export interface Alternative {
  masterId: number;
  startsAt: string;
  endsAt: string;
}

/** Сколько альтернатив показывать и на сколько дней вперед их искать. */
const MAX_ALTERNATIVES = 8;
const SEARCH_DAYS = 14;

/**
 * Ближайшие свободные слоты тех же мастеров для визита той же длины (BOOK-M1, A-02s): сначала
 * в тот же день — ближе всего к выбранному времени, затем в следующие дни по порядку, пока не наберется
 * MAX_ALTERNATIVES. Горизонт записи и 2 часа до визита для клиента учитывает сам расчет слотов.
 */
export function nearestFreeSlots(
  db: Db,
  q: Omit<SlotQuery, 'masterId' | 'date'> & { masterIds: number[]; startsAt: string },
): Alternative[] {
  const { timezone } = readSettings(db);
  const target = Date.parse(q.startsAt);
  const firstDay = zonedDate(target, timezone);
  const result: Alternative[] = [];
  for (let i = 0; i < SEARCH_DAYS && result.length < MAX_ALTERNATIVES; i++) {
    const date = addDays(firstDay, i);
    const day: Alternative[] = [];
    for (const masterId of q.masterIds) {
      for (const s of getSlots(db, { ...q, masterId, date })) {
        if (s.startsAt !== q.startsAt) day.push({ masterId, startsAt: s.startsAt, endsAt: s.endsAt });
      }
    }
    // В первый день — ближайшие к выбранному времени, дальше — по порядку.
    if (i === 0) day.sort((a, b) => Math.abs(Date.parse(a.startsAt) - target) - Math.abs(Date.parse(b.startsAt) - target));
    result.push(...day.slice(0, MAX_ALTERNATIVES - result.length));
  }
  return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.masterId - b.masterId);
}

/**
 * Ответ 409 «время занято» (сценарий 4): понятное сообщение и ближайшие свободные слоты.
 * Текст ошибки базы в ответ не попадает.
 */
export function slotTaken(alternatives: Alternative[]) {
  return conflict(
    'SLOT_TAKEN',
    alternatives.length > 0
      ? 'Это время уже занято. Выберите другое — ниже ближайшее свободное время'
      : 'Это время уже занято, а свободного времени у мастера в ближайшие две недели нет. Выберите другого мастера или позвоните в студию',
    { alternatives },
  );
}
