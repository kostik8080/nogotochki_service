// Изменения расписания мастера: блокировка времени и новый недельный график с даты.
// Одни и те же функции для двух путей: администратор меняет расписание напрямую (api/admin-schedule.ts,
// api/admin-masters.ts) и одобряет заявку мастера (api/requests.ts). Так одобрение заявки дает ровно тот же
// результат, что и ручное действие администратора, — включая список задетых записей.
import type { Db } from '../db/connection.js';

export interface ScheduleDay {
  /** День недели 1–7, с понедельника. */
  weekday: number;
  start: string;
  end: string;
}

export const BLOCK_TYPES = ['lunch', 'personal', 'day_off', 'vacation', 'sick_leave', 'other'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** Блокировка времени мастера: обед, личное время, выходной, отпуск, больничный. Возвращает ее номер. */
export function insertTimeBlock(db: Db, block: {
  masterId: number;
  type: BlockType;
  startsAt: string;
  endsAt: string;
  comment: string | null;
  createdBy: number;
  createdAt: string;
}): number {
  return Number(db.prepare(`
    INSERT INTO time_blocks (master_id, block_type, starts_at, ends_at, comment, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(block.masterId, block.type, block.startsAt, block.endsAt, block.comment, block.createdBy, block.createdAt).lastInsertRowid);
}

/**
 * Новый недельный график с даты (раздел 10.6, сценарий 14): текущие строки закрываются днем накануне,
 * будущие периоды, начинающиеся с этой даты или позже, заменяются новыми. Вызывается внутри транзакции.
 */
export function saveWeeklySchedule(db: Db, masterId: number, validFrom: string, days: ScheduleDay[]): void {
  db.prepare('DELETE FROM master_weekly_hours WHERE master_id = ? AND valid_from >= ?').run(masterId, validFrom);
  db.prepare(`
    UPDATE master_weekly_hours SET valid_to = ?
    WHERE master_id = ? AND valid_from < ? AND (valid_to IS NULL OR valid_to >= ?)
  `).run(dayBefore(validFrom), masterId, validFrom, validFrom);
  const insert = db.prepare(`
    INSERT INTO master_weekly_hours (master_id, weekday, valid_from, valid_to, start_time, end_time) VALUES (?, ?, ?, NULL, ?, ?)
  `);
  for (const d of days) insert.run(masterId, d.weekday, validFrom, d.start, d.end);
}

/** «2026-10-01» → «2026-09-30». Тот же расчет, что addDays(date, -1) в lib/studio-time.ts. */
function dayBefore(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}
