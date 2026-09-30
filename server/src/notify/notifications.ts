// Уведомления клиента в личном кабинете (таблица notifications, миграция 007).
//
// Главное правило: уведомление появляется, только когда запись клиента изменил кто-то другой — администратор.
// Свои действия клиент не получает: он только что сделал их сам. Поэтому каждая функция здесь принимает
// actor и молча ничего не делает, если действие совершил сам владелец записи.
//
// Событий три, других пока нет (решение владельца студии):
//   booking_cancelled   — администратор отменил запись;
//   booking_rescheduled — администратор перенес запись;
//   booking_overbooked  — администратор поставил на время этой записи еще один визит (наложение).
//
// Текст пишется здесь и хранится в базе готовым: он описывает событие так, как оно выглядело в тот момент.
// Пересчитать его позже нельзя — запись уже изменилась. Дата и время — в часовом поясе студии, как их
// называет клиент; в базе и в API время остается в UTC.
// Почты и внешних служб нет: уведомление живет только в кабинете (паспорт, «Ограничения»).
import { hasRole, type Role } from '../auth/sessions.js';
import type { Db } from '../db/connection.js';
import { readSettings } from '../studio/settings.js';

export type NotificationEvent = 'booking_cancelled' | 'booking_rescheduled' | 'booking_overbooked';

interface Actor {
  id: number;
  roles: readonly Role[];
}

/**
 * Дни недели в винительном падеже: после предлога «на» нужно «на пятницу», а Intl дает только «пятница».
 * Склоняются лишь среда, пятница и суббота — остальные совпадают с именительным.
 */
const ACCUSATIVE: Record<string, string> = { среда: 'среду', пятница: 'пятницу', суббота: 'субботу' };

/**
 * «четверг, 1 октября, 14:00» — как клиент называет время визита.
 * `after: 'на'` — форма для предлога: «на пятницу, 2 октября, 15:00».
 */
export function whenText(instant: string, timeZone: string, options: { after?: 'на' } = {}): string {
  const at = new Date(instant);
  const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long' }).format(at);
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long' }).format(at);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `${options.after === 'на' ? ACCUSATIVE[weekday] ?? weekday : weekday}, ${date}, ${time}`;
}

/** «Маникюр с покрытием гель-лаком, Дизайн ногтей ×2» — состав визита для текста уведомления. */
function servicesText(db: Db, bookingId: number): string {
  const items = db.prepare('SELECT service_name, quantity FROM booking_items WHERE booking_id = ? ORDER BY position')
    .all(bookingId) as { service_name: string; quantity: number }[];
  return items.map((i) => (i.quantity > 1 ? `${i.service_name} ×${i.quantity}` : i.service_name)).join(', ');
}

function insert(db: Db, n: { userId: number; bookingId: number; event: NotificationEvent; text: string; at: string }): void {
  db.prepare('INSERT INTO notifications (user_id, booking_id, event_type, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(n.userId, n.bookingId, n.event, n.text, n.at);
}

/**
 * Уведомление нужно, только если запись менял не ее владелец. Клиент, который сам записался, перенес
 * или отменил визит, ничего не получает; мастер записи не меняет, а администратор — меняет чужие.
 */
const byAdmin = (actor: Actor, clientId: number) => hasRole(actor, 'admin') && actor.id !== clientId;

/**
 * Администратор отменил запись клиента.
 * «Запись «Маникюр…» на четверг, 1 октября, 14:00 отменена студией. Причина: заболел мастер».
 */
export function notifyCancelled(
  db: Db, actor: Actor, booking: { id: number; client_id: number; starts_at: string }, reason: string | null, at: string,
): void {
  if (!byAdmin(actor, booking.client_id)) return;
  const { timezone } = readSettings(db);
  const services = servicesText(db, booking.id);
  const text = `Запись «${services}» на ${whenText(booking.starts_at, timezone, { after: 'на' })} отменена студией.` +
    (reason ? ` Причина: ${reason}.` : '');
  insert(db, { userId: booking.client_id, bookingId: booking.id, event: 'booking_cancelled', text, at });
}

/**
 * Администратор перенес запись клиента. В тексте — откуда и куда, а если сменился мастер — и он:
 * «Запись «Маникюр…» на четверг, 1 октября, 14:00 перенесена на пятницу, 2 октября, 11:00».
 */
export function notifyRescheduled(
  db: Db,
  actor: Actor,
  booking: { id: number; client_id: number; starts_at: string; master_id: number },
  change: { startsAt: string; masterId: number },
  at: string,
): void {
  if (!byAdmin(actor, booking.client_id)) return;
  const { timezone } = readSettings(db);
  const services = servicesText(db, booking.id);
  let text = `Запись «${services}» на ${whenText(booking.starts_at, timezone, { after: 'на' })} перенесена студией` +
    ` на ${whenText(change.startsAt, timezone, { after: 'на' })}.`;
  if (change.masterId !== booking.master_id) {
    const master = db.prepare('SELECT name FROM masters WHERE id = ?').get(change.masterId) as { name: string } | undefined;
    if (master) text += ` Визит проведет ${master.name}.`;
  }
  insert(db, { userId: booking.client_id, bookingId: booking.id, event: 'booking_rescheduled', text, at });
}

/**
 * Администратор поставил еще одну запись на время уже существующих (наложение, решение 40): их владельцы
 * узнают, что мастер в это время принимает не только их. Сам новый клиент уведомления не получает —
 * для него это обычная запись, и на прием он пришел по своей воле.
 * «На время вашей записи «Маникюр…» — четверг, 1 октября, 14:00 — студия назначила еще один визит:
 * мастер Анна Ковалева примет двух клиентов».
 */
export function notifyOverbooked(
  db: Db, actor: Actor, placed: { id: number; masterId: number; startsAt: string; busyUntil: string }, at: string,
): void {
  if (!hasRole(actor, 'admin')) return;
  const { timezone } = readSettings(db);
  const master = db.prepare('SELECT name FROM masters WHERE id = ?').get(placed.masterId) as { name: string } | undefined;
  // Чьи записи делят это время: действующие записи того же мастера, кроме только что созданной
  const affected = db.prepare(`
    SELECT id, client_id, starts_at FROM bookings
    WHERE master_id = ? AND id <> ? AND status IN ('active', 'completed', 'no_show')
      AND starts_at < ? AND busy_until > ?
    ORDER BY starts_at
  `).all(placed.masterId, placed.id, placed.busyUntil, placed.startsAt) as
    { id: number; client_id: number; starts_at: string }[];

  for (const booking of affected) {
    if (booking.client_id === actor.id) continue;
    const services = servicesText(db, booking.id);
    // Имя мастера остается в именительном падеже: склонять имена надежно нельзя, поэтому фраза построена так,
    // чтобы имя было подлежащим.
    const text = `На время вашей записи «${services}» — ${whenText(booking.starts_at, timezone)} — студия назначила еще один визит` +
      `${master ? `: мастер ${master.name} примет двух клиентов` : ''}. Ваша запись сохранена, время не изменилось.`;
    insert(db, { userId: booking.client_id, bookingId: booking.id, event: 'booking_overbooked', text, at });
  }
}
