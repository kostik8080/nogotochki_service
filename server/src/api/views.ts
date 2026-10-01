// Что API отдает наружу. Строки базы никогда не уходят в ответ целиком: здесь явно перечислено,
// какие поля видит клиент и какие — администратор. Хеши паролей, токенов и служебные поля
// (попытки входа, блокировки) не попадают в ответы, а контакты клиента видит только администратор.
// Время — моменты в UTC, как в базе; в часовой пояс студии их переводит интерфейс при показе.
// Деньги — целые копейки (поля …Kop).
import { type Role, rolesOf } from '../auth/sessions.js';
import type { Db } from '../db/connection.js';
import { readSettings } from '../studio/settings.js';

// ---------------------------------------------------------------------------
// Пользователь
// ---------------------------------------------------------------------------

/**
 * Своя учетная запись: имя, роли и контакты, без хеша пароля и служебных полей.
 * `roles` — список ролей: интерфейс проверяет, есть ли в нем нужная роль. `role` оставлено для чернового
 * интерфейса web-draft/; настоящий интерфейс web/ его не читает.
 */
export function selfView(db: Db, userId: number) {
  const u = db.prepare(`
    SELECT id, role, name, phone, email, password_hash, provider, phone_verified_at, email_verified_at, marketing_consent_at
    FROM users WHERE id = ?
  `).get(userId) as {
    id: number; role: Role; name: string; phone: string | null; email: string | null;
    password_hash: string | null; provider: string | null;
    phone_verified_at: string | null; email_verified_at: string | null; marketing_consent_at: string | null;
  };
  return {
    id: u.id, roles: rolesOf(u.role), role: u.role, name: u.name, phone: u.phone, email: u.email,
    phoneVerified: u.phone_verified_at !== null, emailVerified: u.email_verified_at !== null,
    marketingConsent: u.marketing_consent_at !== null,
    // Через какой внешний сервис человек входит (`yandex`) и есть ли у него пароль: по ним профиль
    // решает, показывать ли смену пароля и спрашивать ли пароль при удалении аккаунта. Сам хеш не уходит.
    provider: u.provider, hasPassword: u.password_hash !== null,
  };
}

// ---------------------------------------------------------------------------
// Записи
// ---------------------------------------------------------------------------

export type BookingStatus = 'active' | 'cancelled_by_client' | 'cancelled_by_studio' | 'completed' | 'no_show';
export const BOOKING_STATUSES: readonly BookingStatus[] = ['active', 'cancelled_by_client', 'cancelled_by_studio', 'completed', 'no_show'];

interface BookingRow {
  id: number;
  client_id: number;
  master_id: number;
  master_name: string;
  master_level: string;
  is_any_master: number;
  is_overbooking: number;
  starts_at: string;
  ends_at: string;
  busy_until: string;
  status: BookingStatus;
  price_level: string;
  comment: string | null;
  created_by: number;
  client_acknowledged_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  client_name: string;
  client_phone: string | null;
  client_email: string | null;
  /** Поле «Важно» из карточки клиента: аллергии и особенности. Его видят администратор и мастер. */
  important_note: string | null;
  creator_name: string;
  creator_role: Role;
}

interface ItemRow {
  booking_id: number;
  service_id: number;
  position: number;
  service_name: string;
  unit_price_kop: number;
  quantity: number;
  price_kop: number;
  duration_min: number;
}

interface EventRow {
  booking_id: number;
  event_type: string;
  actor_id: number | null;
  actor_name: string | null;
  actor_role: Role | null;
  old_status: string | null;
  new_status: string | null;
  old_master_id: number | null;
  new_master_id: number | null;
  old_starts_at: string | null;
  new_starts_at: string | null;
  old_total_price_kop: number | null;
  new_total_price_kop: number | null;
  reason: string | null;
  created_at: string;
}

export interface BookingViewOptions {
  /**
   * Кто смотрит: клиент видит свою запись без служебных полей, администратор — все,
   * мастер — только нужное для визита: состав, комментарий, имя клиента и «Важно», но не цены и не контакты.
   */
  viewer: Role;
  now: Date;
  /** Добавить историю изменений (карточка записи у администратора). */
  withEvents?: boolean;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Записи по номерам — в том же порядке, что номера. Состав и отмены читаются одним запросом на всех. */
export function bookingViews(db: Db, ids: number[], options: BookingViewOptions) {
  if (ids.length === 0) return [];
  const settings = readSettings(db);
  const rows = db.prepare(`
    SELECT b.id, b.client_id, b.master_id, m.name AS master_name, m.level AS master_level, b.is_any_master, b.is_overbooking,
           b.starts_at, b.ends_at, b.busy_until, b.status, b.price_level, b.comment, b.created_by, b.client_acknowledged_at, b.version,
           b.created_at, b.updated_at,
           c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
           cp.important_note,
           cr.name AS creator_name, cr.role AS creator_role
    FROM bookings b
    JOIN masters m ON m.id = b.master_id
    JOIN users c ON c.id = b.client_id
    LEFT JOIN client_profiles cp ON cp.user_id = b.client_id
    JOIN users cr ON cr.id = b.created_by
    WHERE b.id IN (${placeholders(ids.length)})
  `).all(...ids) as unknown as BookingRow[];
  const items = db.prepare(`
    SELECT booking_id, service_id, position, service_name, unit_price_kop, quantity, price_kop, duration_min
    FROM booking_items WHERE booking_id IN (${placeholders(ids.length)}) ORDER BY booking_id, position
  `).all(...ids) as unknown as ItemRow[];
  const events = db.prepare(`
    SELECT e.booking_id, e.event_type, e.actor_id, u.name AS actor_name, u.role AS actor_role,
           e.old_status, e.new_status, e.old_master_id, e.new_master_id, e.old_starts_at, e.new_starts_at,
           e.old_total_price_kop, e.new_total_price_kop, e.reason, e.created_at
    FROM booking_events e LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.booking_id IN (${placeholders(ids.length)})
    ORDER BY e.booking_id, e.created_at, e.id
  `).all(...ids) as unknown as EventRow[];

  const deadlineMs = settings.client_change_deadline_hours * 3600_000;
  const byId = new Map(rows.map((b) => {
    const lines = items.filter((i) => i.booking_id === b.id);
    const history = events.filter((e) => e.booking_id === b.id);
    const cancel = history.find((e) => e.event_type === 'cancelled');
    // Баннер «Запись отменена или перенесена студией» (CAB-01, решение 26): последнее такое изменение
    // администратора, которое клиент еще не закрыл крестиком.
    const studioChange = [...history].reverse().find((e) => e.actor_role === 'admin'
      && (e.event_type === 'cancelled' || e.event_type === 'rescheduled')
      && (b.client_acknowledged_at === null || e.created_at > b.client_acknowledged_at));
    const changeDeadline = new Date(Date.parse(b.starts_at) - deadlineMs);
    const isAdmin = options.viewer === 'admin';
    const isMaster = options.viewer === 'master';
    return [b.id, {
      id: b.id,
      status: b.status,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
      durationMin: lines.reduce((sum, l) => sum + l.duration_min, 0),
      master: { id: b.master_id, name: b.master_name, level: b.master_level },
      isAnyMaster: b.is_any_master === 1,
      items: lines.map((l) => ({
        serviceId: l.service_id, name: l.service_name, quantity: l.quantity, durationMin: l.duration_min,
        // Цены мастеру не показываются (паспорт, раздел мастера: «цены и чужие записи мастеру не видны»).
        ...(isMaster ? {} : { unitPriceKop: l.unit_price_kop, priceKop: l.price_kop }),
      })),
      comment: b.comment,
      cancellation: cancel ? {
        at: cancel.created_at,
        by: cancel.new_status === 'cancelled_by_client' ? 'client' : 'studio',
        reason: cancel.reason,
      } : null,
      version: b.version,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
      // Цены и правило 24 часов — клиенту и администратору. Мастер запись не меняет и цен не видит.
      ...(isMaster ? {} : {
        priceLevel: b.price_level,
        totalPriceKop: lines.reduce((sum, l) => sum + l.price_kop, 0),
        // Правило 24 часов (раздел 6): клиент меняет запись сам только до этого момента.
        changeDeadline: changeDeadline.toISOString(),
        canChange: b.status === 'active' && options.now < changeDeadline,
        studioChange: studioChange ? { type: studioChange.event_type, at: studioChange.created_at } : null,
      }),
      // Мастеру — то, что нужно для визита: имя клиента, его «Важно» (аллергии, особенности)
      // и отметка о наложении, чтобы он знал, что время делят две записи. Телефона и e-mail здесь нет.
      ...(isMaster ? {
        client: { name: b.client_name, importantNote: b.important_note },
        isOverbooking: b.is_overbooking === 1,
      } : {}),
      // Только администратору: контакты клиента, уборка после визита, кто создал запись, история.
      ...(isAdmin ? {
        client: { id: b.client_id, name: b.client_name, phone: b.client_phone, email: b.client_email },
        busyUntil: b.busy_until,
        // Запись поставлена администратором поверх другой записи (решение 40). Клиенту это не показывается.
        isOverbooking: b.is_overbooking === 1,
        createdBy: { id: b.created_by, name: b.creator_name, role: b.creator_role },
        ...(options.withEvents ? { events: history.map(eventView) } : {}),
      } : {}),
    }] as const;
  }));
  return ids.map((id) => byId.get(id)).filter((b) => b !== undefined);
}

export type BookingView = ReturnType<typeof bookingViews>[number];

export function bookingView(db: Db, id: number, options: BookingViewOptions): BookingView {
  const [view] = bookingViews(db, [id], options);
  if (!view) throw new Error(`Запись ${id} не найдена`);
  return view;
}

function eventView(e: EventRow) {
  return {
    type: e.event_type,
    at: e.created_at,
    actor: e.actor_id === null ? null : { id: e.actor_id, name: e.actor_name, role: e.actor_role },
    ...(e.old_status !== null || e.new_status !== null ? { oldStatus: e.old_status, newStatus: e.new_status } : {}),
    ...(e.event_type === 'rescheduled' ? {
      oldMasterId: e.old_master_id, newMasterId: e.new_master_id,
      oldStartsAt: e.old_starts_at, newStartsAt: e.new_starts_at,
    } : {}),
    ...(e.old_total_price_kop !== null ? { oldTotalPriceKop: e.old_total_price_kop, newTotalPriceKop: e.new_total_price_kop } : {}),
    reason: e.reason,
  };
}

// ---------------------------------------------------------------------------
// Уведомления клиента
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: number;
  booking_id: number;
  event_type: string;
  text: string;
  read_at: string | null;
  created_at: string;
}

/**
 * Уведомления для кабинета: готовый текст, событие, номер записи (по нему открывается ее карточка)
 * и отметка о прочтении. Счетчик непрочитанных приходит рядом со списком — см. api/notifications.ts.
 */
export function notificationViews(rows: NotificationRow[]) {
  return rows.map((n) => ({
    id: n.id,
    type: n.event_type,
    text: n.text,
    bookingId: n.booking_id,
    isRead: n.read_at !== null,
    createdAt: n.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Бронь времени
// ---------------------------------------------------------------------------

export interface HoldRow {
  id: number;
  owner_id: number;
  master_id: number;
  starts_at: string;
  ends_at: string;
  busy_until: string;
  booking_id: number | null;
  expires_at: string;
}

export function holdView(h: HoldRow, now: Date) {
  return {
    id: h.id,
    masterId: h.master_id,
    startsAt: h.starts_at,
    endsAt: h.ends_at,
    bookingId: h.booking_id,
    expiresAt: h.expires_at,
    // «Время закреплено за вами еще MM:SS» (раздел 6) — по часам сервера, чтобы не зависеть от часов телефона.
    secondsLeft: Math.max(0, Math.floor((Date.parse(h.expires_at) - now.getTime()) / 1000)),
  };
}
