// Проверки доступа для обработчиков: вход выполнен (401) и роль подходит (403).
import type { Role, SessionUser } from '../auth/sessions.js';
import { conflict, forbidden, HttpError, unauthorized } from '../http/errors.js';
import type { Context } from '../http/router.js';
import { readSettings } from '../studio/settings.js';

export function requireUser(ctx: Context): SessionUser {
  if (ctx.user) return ctx.user;
  if (ctx.sessionStatus === 'expired') throw unauthorized('Сессия истекла, войдите снова', 'SESSION_EXPIRED');
  throw unauthorized();
}

export function requireRole(ctx: Context, ...roles: Role[]): SessionUser {
  const user = requireUser(ctx);
  if (!roles.includes(user.role)) {
    throw forbidden(roles.includes('admin') && roles.length === 1 ? 'Раздел только для администратора' : 'Действие недоступно для этой учетной записи');
  }
  return user;
}

/**
 * Режим технических работ (settings.is_maintenance): клиенты не создают бронь и запись,
 * раздел администратора работает (docs/db-schema.md, раздел 5.1).
 */
export function requireNotMaintenance(ctx: Context, user: SessionUser): void {
  if (user.role === 'admin') return;
  const settings = readSettings(ctx.db);
  if (settings.is_maintenance) {
    throw new HttpError(503, 'MAINTENANCE', `Запись временно недоступна. Записаться можно по телефону ${settings.phone}`);
  }
}

/**
 * Можно ли этому пользователю перенести или отменить запись. Клиент — только свою, действующую
 * и не позднее чем за client_change_deadline_hours до визита (правило 24 часов, сценарий 6);
 * позже — только через студию. Администратор этим правилом не связан (паспорт, функция 6 администратора).
 */
export function requireChangeableBooking(
  ctx: Context,
  user: SessionUser,
  booking: { client_id: number; status: string; starts_at: string },
): void {
  if (user.role !== 'admin' && booking.client_id !== user.id) throw forbidden('Это чужая запись');
  if (booking.status !== 'active') throw conflict('BOOKING_NOT_ACTIVE', 'Изменить можно только действующую запись');
  if (user.role === 'admin') return;
  const settings = readSettings(ctx.db);
  const deadline = Date.parse(booking.starts_at) - settings.client_change_deadline_hours * 3600_000;
  if (ctx.now.getTime() >= deadline) {
    throw forbidden(
      `Перенести или отменить запись можно не позднее чем за ${settings.client_change_deadline_hours} ч до визита. ` +
        `Позже — только через студию: ${settings.phone}`,
      'CHANGE_DEADLINE_PASSED',
    );
  }
}
