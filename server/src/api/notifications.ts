// Уведомления клиента в кабинете (таблица notifications, миграция 007): список и отметка «прочитано».
// Появляются они только от действий администратора с записью клиента — создает их notify/notifications.ts.
//
// Счетчик непрочитанных приходит вместе со списком (`unreadCount`): колокольчику в шапке не нужен
// отдельный запрос ради одного числа.
import { notFound } from '../http/errors.js';
import { pathId, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { requireRole } from './guards.js';
import { type NotificationRow, notificationViews } from './views.js';

/** Сколько уведомлений отдавать за раз: в колокольчике показываются последние. */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export function notificationRoutes(router: Router): void {
  // Свои уведомления, новые сверху, и число непрочитанных — одним запросом.
  router.get('/api/notifications', (ctx): Result => {
    const user = requireRole(ctx, 'client');
    const input = Input.query(ctx.query);
    const limit = input.int('limit', { optional: true, min: 1, max: MAX_LIMIT }) ?? DEFAULT_LIMIT;
    const unreadOnly = input.bool('unread', { optional: true }) ?? false;
    input.done();

    const rows = ctx.db.prepare(`
      SELECT id, booking_id, event_type, text, read_at, created_at FROM notifications
      WHERE user_id = @user AND (@unread = 0 OR read_at IS NULL)
      ORDER BY created_at DESC, id DESC LIMIT @limit
    `).all({ user: user.id, unread: unreadOnly ? 1 : 0, limit }) as unknown as NotificationRow[];
    const { unread } = ctx.db.prepare('SELECT count(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(user.id) as { unread: number };

    return { status: 200, body: { unreadCount: unread, notifications: notificationViews(rows) } };
  });

  // «Прочитано»: клиент закрыл уведомление в колокольчике. Повторный вызов ничего не меняет —
  // время прочтения остается первым.
  router.post('/api/notifications/:id/read', (ctx): Result => {
    const user = requireRole(ctx, 'client');
    const id = pathId(ctx);
    Input.body(ctx.body).done();
    const changed = ctx.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
      .run(ctx.now.toISOString(), id, user.id).changes;
    // Чужое уведомление для клиента просто не существует: 404, а не 403 — по ответу нельзя узнать чужие номера.
    if (changed === 0 && !ctx.db.prepare('SELECT 1 FROM notifications WHERE id = ? AND user_id = ?').get(id, user.id)) {
      throw notFound('Уведомление не найдено');
    }
    const { unread } = ctx.db.prepare('SELECT count(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(user.id) as { unread: number };
    return { status: 200, body: { unreadCount: unread } };
  });
}
