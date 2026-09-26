// Уборка временных строк (docs/db-schema.md, раздел 8, шаг 4). На правильность проверок она не влияет:
// истекшая бронь и сессия и так не учитываются по expires_at. Уборка нужна для порядка, чтобы таблицы не росли.
import type { Db } from '../db/connection.js';

/** Удаляет истекшие брони времени. Вызывается при каждой новой брони и периодически сервером. */
export function cleanupExpiredHolds(db: Db, now: Date): number {
  return Number(db.prepare('DELETE FROM slot_holds WHERE expires_at <= ?').run(now.toISOString()).changes);
}

/** Истекшие брони и закрытые или истекшие сессии. На сессии ничто не ссылается, их можно удалять. */
export function cleanupExpired(db: Db, now: Date): { holds: number; sessions: number } {
  const holds = cleanupExpiredHolds(db, now);
  const sessions = Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL')
    .run(now.toISOString()).changes);
  return { holds, sessions };
}
