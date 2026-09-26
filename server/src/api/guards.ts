// Проверки доступа для обработчиков: вход выполнен (401) и роль подходит (403).
import type { Role, SessionUser } from '../auth/sessions.js';
import { assertCanChange, assertNotMaintenance } from '../booking/booking-service.js';
import { forbidden, unauthorized } from '../http/errors.js';
import type { Context } from '../http/router.js';

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

/** Режим технических работ: клиенты не создают бронь и запись. Правило — в booking-service.ts. */
export function requireNotMaintenance(ctx: Context, user: SessionUser): void {
  assertNotMaintenance(ctx.db, user);
}

/** Можно ли пользователю перенести или отменить запись (правило 24 часов). Правило — в booking-service.ts. */
export function requireChangeableBooking(
  ctx: Context,
  user: SessionUser,
  booking: { client_id: number; status: string; starts_at: string },
): void {
  assertCanChange(ctx.db, user, booking, ctx.now);
}
