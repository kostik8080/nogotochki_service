// Проверки доступа, три по порядку: вход выполнен (401), роль подходит (403)
// и запрошенный объект принадлежит пользователю (403). Третью проверку нельзя пропускать даже там,
// где роль уже совпала: клиент видит только свои записи, мастер — записи своего расписания,
// администратор — все записи студии. Раздел администратора целиком закрывает одна функция — requireAdmin.
import { hasRole, type Role, type SessionUser } from '../auth/sessions.js';
import { assertCanChange, assertNotMaintenance } from '../booking/booking-service.js';
import { forbidden, unauthorized } from '../http/errors.js';
import type { Context } from '../http/router.js';

/** Сессия запроса: кто вошел и что с cookie. Проверкам больше ничего не нужно. */
export type SessionState = Pick<Context, 'user' | 'sessionStatus'>;

export function requireUser(ctx: SessionState): SessionUser {
  if (ctx.user) return ctx.user;
  if (ctx.sessionStatus === 'expired') throw unauthorized('Сессия истекла, войдите снова', 'SESSION_EXPIRED');
  throw unauthorized();
}

/**
 * Вторая проверка: у пользователя есть хотя бы одна из ролей. Роли — список (SessionUser.roles):
 * проверяется наличие роли в нем, а не равенство одной роли.
 */
export function requireRole(ctx: SessionState, ...roles: Role[]): SessionUser {
  const user = requireUser(ctx);
  if (!roles.some((role) => hasRole(user, role))) {
    throw forbidden(roles.includes('admin') && roles.length === 1 ? 'Раздел только для администратора' : 'Действие недоступно для этой учетной записи');
  }
  return user;
}

// ---------------------------------------------------------------------------
// Раздел администратора
// ---------------------------------------------------------------------------

/** Адрес из раздела администратора в API: /api/admin и все под ним. */
export function isAdminApiPath(pathname: string): boolean {
  return pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}

/**
 * Единственная проверка доступа к разделу администратора: нет входа — 401, нет роли администратора — 403.
 * Через нее проходят:
 *   * все запросы к /api/admin/* — app.ts вызывает ее до поиска маршрута, поэтому новый эндпоинт под /api/admin
 *     защищен сам, без строчки в обработчике, а клиент не узнает, какие адреса в разделе есть (403 вместо 404 и 405);
 *   * страницы /admin — web/admin-pages.ts превращает 401 во вход, а 403 — в страницу «Этот раздел только для администраторов».
 * Обработчики /api/admin/* роль не проверяют; пользователя они берут через requireUser.
 * Тест admin-access.test.ts перебирает все маршруты /api/admin и проверяет, что клиенту каждый отвечает 403.
 */
export function requireAdmin(session: SessionState): SessionUser {
  return requireRole(session, 'admin');
}

/**
 * Профиль мастера, привязанный к учетной записи (`masters.user_id`). Без связи мастеру смотреть нечего:
 * учетная запись есть, а расписания у нее нет — это заводит администратор.
 */
export function requireMasterProfile(ctx: Context, user: SessionUser): { id: number; name: string; level: string; photoUrl: string | null } {
  const master = ctx.db.prepare('SELECT id, name, level, photo_path FROM masters WHERE user_id = ?').get(user.id) as
    { id: number; name: string; level: string; photo_path: string | null } | undefined;
  if (!master) throw forbidden('Учетная запись не связана с профилем мастера. Обратитесь к администратору', 'MASTER_NOT_LINKED');
  // Свой одобренный портрет: мастер видит в разделе, что сейчас стоит у него на сайте
  const { photo_path, ...rest } = master;
  return { ...rest, photoUrl: photo_path === null ? null : `/api/masters/${master.id}/photo` };
}

/**
 * Третья проверка для карточки записи: объект принадлежит пользователю. Администратор видит любую запись,
 * клиент — только свою, мастер — только ту, что стоит в его расписании. Роль здесь уже проверена
 * через requireRole, но одной роли мало: клиент с правильной ролью не должен открыть чужую запись.
 */
export function requireBookingAccess(
  ctx: Context,
  user: SessionUser,
  booking: { client_id: number; master_id: number },
): void {
  if (hasRole(user, 'admin')) return;
  if (hasRole(user, 'master')) {
    if (booking.master_id !== requireMasterProfile(ctx, user).id) throw forbidden('Эта запись не из вашего расписания');
    return;
  }
  if (booking.client_id !== user.id) throw forbidden('Это чужая запись');
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
