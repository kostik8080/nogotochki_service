// Какие записи задевает изменение расписания. База сама записи не трогает (раздел 5.3): сервис показывает
// администратору список, а он переносит записи или отменяет их со статусом «Отменена студией» (сценарии 8 и 14).
import { transaction, type Db } from '../db/connection.js';
import { zonedDate } from '../lib/studio-time.js';
import { readSettings } from '../studio/settings.js';
import { getMasterDay } from './slots.js';

/**
 * Действующие записи с момента from (и до to), которые не помещаются в рабочее окно мастера на свой день:
 * студия закрыта, мастер не работает или визит выходит за часы. Блокировки здесь не учитываются.
 */
export function bookingsOutsideWorkingHours(db: Db, q: { masterId?: number; from: string; to?: string }): number[] {
  const { timezone } = readSettings(db);
  const rows = db.prepare(`
    SELECT id, master_id, starts_at, ends_at FROM bookings
    WHERE status = 'active' AND starts_at >= @from AND (@to IS NULL OR starts_at < @to) AND (@master IS NULL OR master_id = @master)
    ORDER BY starts_at, master_id
  `).all({ from: q.from, to: q.to ?? null, master: q.masterId ?? null }) as { id: number; master_id: number; starts_at: string; ends_at: string }[];
  return rows.filter((b) => {
    const day = getMasterDay(db, b.master_id, zonedDate(Date.parse(b.starts_at), timezone));
    return day.status !== 'open' || Date.parse(b.starts_at) < day.window.start || Date.parse(b.ends_at) > day.window.end;
  }).map((b) => b.id);
}

/** Действующие записи мастера, визит которых пересекается с промежутком [from, to) — например, с новой блокировкой. */
export function bookingsOverlapping(db: Db, masterId: number, from: string, to: string): number[] {
  return (db.prepare(`
    SELECT id FROM bookings WHERE master_id = ? AND status = 'active' AND starts_at < ? AND ends_at > ? ORDER BY starts_at
  `).all(masterId, to, from) as { id: number }[]).map((r) => r.id);
}

const PREVIEW = Symbol('preview');

/**
 * Выполняет изменение в транзакции. С dryRun — выполняет и откатывает: так администратор видит,
 * какие записи заденет изменение, до сохранения (A-20d, A-22p).
 */
export function applyOrPreview<T>(db: Db, dryRun: boolean, fn: () => T): T {
  if (!dryRun) return transaction(db, fn);
  let result: T | undefined;
  try {
    transaction(db, () => {
      result = fn();
      throw PREVIEW;
    });
  } catch (error) {
    if (error !== PREVIEW) throw error;
  }
  return result as T;
}
