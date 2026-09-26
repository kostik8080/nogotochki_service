// Свободен ли конкретный момент для визита: тот же расчет слотов (раздел 7), что показывает календарь,
// только для одного времени начала. Сервер повторяет проверку при создании брони, записи и переноса
// внутри транзакции BEGIN IMMEDIATE: триггеры базы ловят пересечения с записями и бронями,
// но не рабочее время мастера и блокировки (раздел 10.3).
import type { Db } from '../db/connection.js';
import { conflict } from '../http/errors.js';
import { zonedDate } from '../lib/studio-time.js';
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

/** Сколько альтернатив показывать в ответе «время занято» (BOOK-M1, A-02s). */
const MAX_ALTERNATIVES = 12;

export interface Alternative {
  masterId: number;
  startsAt: string;
  endsAt: string;
}

/**
 * 409 «время занято» с ближайшими к выбранному моменту свободными слотами того же дня:
 * сценарий 4 — сервис сообщает, что время уже занято, и предлагает выбрать другое.
 */
export function slotTaken(startsAt: string, alternatives: Alternative[]) {
  const target = Date.parse(startsAt);
  const nearest = [...alternatives]
    .sort((a, b) => Math.abs(Date.parse(a.startsAt) - target) - Math.abs(Date.parse(b.startsAt) - target))
    .slice(0, MAX_ALTERNATIVES)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.masterId - b.masterId);
  return conflict('SLOT_TAKEN', 'Это время уже занято или недоступно. Выберите другое', { alternatives: nearest });
}
