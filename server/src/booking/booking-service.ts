// Единственное место, где записи создаются и меняются: создание, перенос, отмена, итог визита.
// Функциями пользуются все: обработчики API для клиента, мастера и администратора, удаление аккаунта
// и тестовые данные. Второго пути записи в bookings, booking_items и booking_events нет —
// это проверяет тест test/booking-service.test.ts.
//
// Устроено в два слоя:
//   * createBooking, rescheduleBooking, cancelBooking, setVisitResult — правила: кто что может,
//     бронь, повторная проверка времени, правило 24 часов, версия записи. Права ролей проверяются здесь,
//     а не в маршрутах API, поэтому одинаковы для любого вызывающего кода;
//   * insertBookingRows, writeReschedule, writeCancellation, writeStatusChange — только запись строк
//     в правильном порядке (например, событие отмены раньше статуса, триггер 10.7). Правил в них нет:
//     их вызывают функции первого слоя и тестовые данные, которым нужна история в прошлом.
import { hasRole, type Role } from '../auth/sessions.js';
import { type Db, transaction } from '../db/connection.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.js';
import { notifyCancelled, notifyOverbooked, notifyRescheduled } from '../notify/notifications.js';
import { readSettings } from '../studio/settings.js';
import { checkSlot, isSlotConflict, nearestFreeSlots, SlotUnavailable, slotTaken } from './availability.js';
import { type ExistingBooking, loadBooking, pricesAtLevel } from './existing.js';
import { type Level, requireMasterForVisit, resolveVisit, unitPrice, type VisitItemInput } from './visit.js';

/** Кто действует: пользователь сессии или система (тестовые данные — через функции второго слоя). */
export interface Actor {
  id: number;
  /** Роли списком: права проверяет hasRole (auth/sessions.ts). */
  roles: readonly Role[];
}

type CancelStatus = 'cancelled_by_client' | 'cancelled_by_studio';
type ResultStatus = 'completed' | 'no_show';

const iso = (ms: number) => new Date(ms).toISOString();
const addMin = (at: string, min: number) => iso(Date.parse(at) + min * 60_000);

// ---------------------------------------------------------------------------
// Права ролей
// ---------------------------------------------------------------------------

/**
 * Права на записи. Клиент — свои записи; администратор — любые; мастер пока никаких:
 * разделов для мастера в первой версии нет (паспорт, раздел «Ограничения»; решение 38).
 */
function requireBookingRole(actor: Actor): void {
  if (hasRole(actor, 'master')) {
    throw forbidden('Учетная запись мастера пока не может создавать и менять записи. Это делает администратор', 'MASTER_NO_BOOKING_RIGHTS');
  }
}

/**
 * Можно ли изменить запись: клиент — только свою, действующую и не позднее чем за
 * client_change_deadline_hours до визита (правило 24 часов, сценарий 6). Администратор этим правилом
 * не связан. ignoreDeadline — только для удаления аккаунта: клиент отзывает свои данные целиком.
 */
export function assertCanChange(
  db: Db,
  actor: Actor,
  booking: { client_id: number; status: string; starts_at: string },
  now: Date,
  options: { ignoreDeadline?: boolean } = {},
): void {
  requireBookingRole(actor);
  if (!hasRole(actor, 'admin') && booking.client_id !== actor.id) throw forbidden('Это чужая запись');
  if (booking.status !== 'active') throw conflict('BOOKING_NOT_ACTIVE', 'Изменить можно только действующую запись');
  if (hasRole(actor, 'admin') || options.ignoreDeadline) return;
  const settings = readSettings(db);
  const deadline = Date.parse(booking.starts_at) - settings.client_change_deadline_hours * 3600_000;
  if (now.getTime() >= deadline) {
    throw forbidden(
      `Перенести или отменить запись можно не позднее чем за ${settings.client_change_deadline_hours} ч до визита. ` +
        `Позже — только через студию: ${settings.phone}`,
      'CHANGE_DEADLINE_PASSED',
    );
  }
}

/** Режим технических работ: клиенты не создают бронь и запись, администратор работает (раздел 5.1). */
export function assertNotMaintenance(db: Db, actor: Actor): void {
  if (hasRole(actor, 'admin')) return;
  const settings = readSettings(db);
  if (settings.is_maintenance) {
    throw new HttpError(503, 'MAINTENANCE', `Запись временно недоступна. Записаться можно по телефону ${settings.phone}`);
  }
}

const versionConflict = () => conflict('VERSION_CONFLICT', 'Запись изменена другим сотрудником. Обновите данные и повторите');

/** Если интерфейс передал версию, которую видел пользователь, она должна совпадать с текущей (A-S1). */
function checkVersion(current: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== current) throw versionConflict();
}

interface HoldRow {
  booking_id: number | null;
  master_id: number;
  starts_at: string;
  ends_at: string;
  busy_until: string;
  expires_at: string;
}

const ownHold = (db: Db, actor: Actor) =>
  db.prepare('SELECT booking_id, master_id, starts_at, ends_at, busy_until, expires_at FROM slot_holds WHERE owner_id = ?')
    .get(actor.id) as HoldRow | undefined;

// ---------------------------------------------------------------------------
// Слой 2: запись строк
// ---------------------------------------------------------------------------

export interface BookingRows {
  clientId: number;
  masterId: number;
  priceLevel: Level;
  startsAt: string;
  /** Уборка после визита, копируется в запись (решение 32). */
  cleanupMin: number;
  /** Услуги в порядке выполнения: название, цена и длительность — на момент записи (сценарий 7). */
  lines: { serviceId: number; name: string; unitPriceKop: number; quantity: number; durationMin: number }[];
  isAnyMaster?: boolean;
  isOverbooking?: boolean;
  comment?: string | null;
  createdBy: number;
  createdAt: string;
}

/** Единственная вставка записи и ее состава. Конец визита и занятость мастера считаются здесь. */
export function insertBookingRows(db: Db, r: BookingRows): number {
  const endsAt = addMin(r.startsAt, r.lines.reduce((sum, l) => sum + l.durationMin, 0));
  const busyUntil = addMin(endsAt, r.cleanupMin);
  const id = Number(db.prepare(`
    INSERT INTO bookings (client_id, master_id, is_any_master, is_overbooking, starts_at, ends_at, busy_until, price_level,
                          comment, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.clientId, r.masterId, r.isAnyMaster ? 1 : 0, r.isOverbooking ? 1 : 0, r.startsAt, endsAt, busyUntil, r.priceLevel,
    r.comment ?? null, r.createdBy, r.createdAt, r.createdAt).lastInsertRowid);
  const insertItem = db.prepare(`
    INSERT INTO booking_items (booking_id, service_id, position, service_name, unit_price_kop, quantity, price_kop, duration_min)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  r.lines.forEach((l, i) => insertItem.run(id, l.serviceId, i + 1, l.name, l.unitPriceKop, l.quantity, l.unitPriceKop * l.quantity, l.durationMin));
  return id;
}

/**
 * Перенос той же записи: новое время, мастер и, у мастера другого уровня, цены. Старое время
 * и суммы — в событии rescheduled. Условие по версии — защита от одновременного редактирования.
 */
export function writeReschedule(
  db: Db,
  b: ExistingBooking,
  change: {
    masterId: number; level: Level; startsAt: string; actorId: number | null; reason: string | null; at: string;
    /** Перенос поверх занятого времени — только администратором (решение 40). Обычный перенос снимает признак. */
    isOverbooking?: boolean;
  },
): void {
  const endsAt = addMin(change.startsAt, b.durationMin);
  const busyUntil = addMin(endsAt, b.cleanupMin);
  const prices = pricesAtLevel(b, change.level);
  if (prices.changed) {
    const updateItem = db.prepare('UPDATE booking_items SET unit_price_kop = ?, price_kop = ? WHERE booking_id = ? AND service_id = ?');
    b.items.forEach((item, i) => updateItem.run(prices.units[i]!, prices.units[i]! * item.quantity, b.id, item.service_id));
  }
  db.prepare(`
    INSERT INTO booking_events (booking_id, event_type, actor_id, old_master_id, new_master_id, old_starts_at, new_starts_at,
                                old_total_price_kop, new_total_price_kop, reason, created_at)
    VALUES (?, 'rescheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.id, change.actorId, b.master_id, change.masterId, b.starts_at, change.startsAt,
    prices.changed ? b.totalKop : null, prices.changed ? prices.totalKop : null, change.reason, change.at);
  // Пересечение с другой записью — в том числе при смене мастера — отклонит триггер bookings_no_overlap_update;
  // наложение без администратора в последнем событии — триггер bookings_overbooking_admin_only_update.
  const updated = db.prepare(`
    UPDATE bookings SET master_id = ?, starts_at = ?, ends_at = ?, busy_until = ?, price_level = ?, is_overbooking = ?,
                        version = version + 1, updated_at = ?
    WHERE id = ? AND version = ?
  `).run(change.masterId, change.startsAt, endsAt, busyUntil, change.level, change.isOverbooking ? 1 : 0, change.at, b.id, b.version);
  if (updated.changes !== 1) throw versionConflict();
}

/**
 * Отмена: сначала событие cancelled (кто, когда, почему), потом статус — иначе триггер 10.7 отклонит
 * смену статуса. Бронь на перенос этой записи снимается: время освобождается сразу.
 */
export function writeCancellation(
  db: Db,
  c: { bookingId: number; version: number; status: CancelStatus; actorId: number | null; reason: string | null; at: string },
): void {
  db.prepare(`
    INSERT INTO booking_events (booking_id, event_type, actor_id, old_status, new_status, reason, created_at)
    VALUES (?, 'cancelled', ?, 'active', ?, ?, ?)
  `).run(c.bookingId, c.actorId, c.status, c.reason, c.at);
  const updated = db.prepare('UPDATE bookings SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
    .run(c.status, c.at, c.bookingId, c.version);
  if (updated.changes !== 1) throw versionConflict();
  db.prepare('DELETE FROM slot_holds WHERE booking_id = ?').run(c.bookingId);
}

/** Итог визита: событие status_changed, затем статус. */
export function writeStatusChange(
  db: Db,
  c: { bookingId: number; version: number; oldStatus: string; status: ResultStatus; actorId: number | null; reason: string | null; at: string },
): void {
  db.prepare(`
    INSERT INTO booking_events (booking_id, event_type, actor_id, old_status, new_status, reason, created_at)
    VALUES (?, 'status_changed', ?, ?, ?, ?, ?)
  `).run(c.bookingId, c.actorId, c.oldStatus, c.status, c.reason, c.at);
  const updated = db.prepare('UPDATE bookings SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
    .run(c.status, c.at, c.bookingId, c.version);
  if (updated.changes !== 1) throw versionConflict();
}

// ---------------------------------------------------------------------------
// Слой 1: правила
// ---------------------------------------------------------------------------

export interface CreateBookingRequest {
  masterId: number;
  startsAt: string;
  items: VisitItemInput[];
  comment: string | null;
  isAnyMaster: boolean;
  /** Только администратор: клиент из базы или новый клиент без учетной записи. */
  clientId?: number;
  newClient?: { name: string; phone: string };
  /** Осознанное наложение (решение 40). Действует только у администратора; у остальных отбрасывается. */
  isOverbooking?: boolean;
}

/**
 * Создать запись (BOOK-04, A-02). Одна функция для всех ролей:
 *   клиент — только на себя и только по своей действующей брони на это время (раздел 8, шаг 2);
 *   администратор — за клиента из базы или нового, без брони, при isOverbooking — поверх записей других
 *   клиентов и блокировок (рабочее время мастера и чужие брони наложение не перекрывает);
 *   мастер — 403.
 * Транзакция BEGIN IMMEDIATE: повторная проверка времени и вставка неразделимы. Если время занято —
 * по проверке сервера или по триггеру базы, — 409 с ближайшим свободным временем мастера.
 */
export function createBooking(db: Db, actor: Actor, req: CreateBookingRequest, now: Date): number {
  requireBookingRole(actor);
  if (hasRole(actor, 'client') && (req.clientId !== undefined || req.newClient !== undefined)) {
    throw forbidden('Клиент записывает только себя');
  }
  if (hasRole(actor, 'admin') && req.clientId === undefined && req.newClient === undefined) {
    throw badRequest('VALIDATION_ERROR', 'Укажите клиента', { fields: [{ field: 'clientId', message: 'Укажите клиента или нового клиента' }] });
  }
  assertNotMaintenance(db, actor);
  // Проверка роли для наложения: признак действует только у администратора, у клиента молча отбрасывается —
  // запись создается обычной и проходит все проверки. Второй барьер — триггер bookings_overbooking_admin_only.
  const isOverbooking = hasRole(actor, 'admin') && req.isOverbooking === true;

  // Длительность и уборка нужны и после отката транзакции — чтобы подобрать альтернативы.
  let timing: { durationMin: number; cleanupMin: number } | undefined;
  try {
    return transaction(db, () => {
      const visit = resolveVisit(db, req.items);
      timing = { durationMin: visit.durationMin, cleanupMin: visit.cleanupMin };
      const master = requireMasterForVisit(db, req.masterId, visit.serviceIds);
      const endsAt = addMin(req.startsAt, visit.durationMin);
      const busyUntil = addMin(endsAt, visit.cleanupMin);
      const clientId = hasRole(actor, 'client') ? actor.id : resolveClient(db, req.clientId, req.newClient, now);

      // У клиента бронь обязательна и должна совпадать с тем, что он подтверждает.
      if (hasRole(actor, 'client')) {
        const hold = ownHold(db, actor);
        if (!hold) throw conflict('HOLD_NOT_FOUND', 'Время не закреплено за вами. Выберите время заново');
        if (hold.expires_at <= now.toISOString()) throw conflict('HOLD_EXPIRED', 'Время брони истекло. Проверьте, свободно ли еще это время');
        if (hold.booking_id !== null || hold.master_id !== req.masterId || hold.starts_at !== req.startsAt
          || hold.ends_at !== endsAt || hold.busy_until !== busyUntil) {
          throw conflict('HOLD_MISMATCH', 'Бронь не совпадает с выбранными мастером, временем или услугами. Выберите время заново');
        }
      }

      // Уровень 1 защиты от двойной записи: время заново считается в той же транзакции — с момента брони
      // могли добавить блокировку или изменить график. Ограничения клиента (2 часа, горизонт) проверены
      // при брони, а бронь гарантирует время. При наложении записи других клиентов и блокировки не мешают.
      const check = checkSlot(db, {
        masterId: req.masterId, startsAt: req.startsAt, ...timing, now, audience: 'admin', viewerId: actor.id,
        overbooking: isOverbooking,
      });
      if (!check.available) throw new SlotUnavailable();

      // Своя бронь снимается до вставки: триггер записи учитывает любые действующие брони (раздел 8).
      db.prepare('DELETE FROM slot_holds WHERE owner_id = ?').run(actor.id);
      // Уровень 2: пересечение отклонит триггер bookings_no_overlap_insert.
      const id = insertBookingRows(db, {
        clientId, masterId: req.masterId, priceLevel: master.level, startsAt: req.startsAt, cleanupMin: visit.cleanupMin,
        lines: visit.lines.map((l) => ({
          serviceId: l.serviceId, name: l.name, unitPriceKop: unitPrice(l, master.level), quantity: l.quantity, durationMin: l.durationMin,
        })),
        isAnyMaster: req.isAnyMaster, isOverbooking, comment: req.comment, createdBy: actor.id, createdAt: now.toISOString(),
      });
      // Наложение: клиенты, чье время администратор занял вторым визитом, узнают об этом в кабинете.
      // Сам записанный клиент уведомления не получает — для него это обычная запись.
      if (isOverbooking) {
        notifyOverbooked(db, actor, {
          id, masterId: req.masterId, startsAt: req.startsAt, busyUntil,
        }, now.toISOString());
      }
      return id;
    });
  } catch (error) {
    // Уровень 3: транзакция откатилась. Вместо текста ошибки базы — 409 и ближайшее свободное время мастера.
    if (isSlotConflict(error) && timing) {
      throw slotTaken(nearestFreeSlots(db, {
        masterIds: [req.masterId], startsAt: req.startsAt, ...timing, now,
        audience: hasRole(actor, 'admin') ? 'admin' : 'client', viewerId: actor.id,
      }));
    }
    throw error;
  }
}

export interface RescheduleRequest {
  startsAt: string;
  /** Другой мастер; по умолчанию — тот же. */
  masterId?: number;
  reason: string | null;
  version?: number;
  /** Перенос поверх занятого времени (решение 40). Действует только у администратора; у остальных отбрасывается. */
  isOverbooking?: boolean;
}

/**
 * Перенос той же записи (сценарий 5, CAB-04, A-04). Клиент — своей записи, до срока правила 24 часов
 * и по брони на перенос (POST /api/holds с bookingId); администратор — любой, без брони, при isOverbooking —
 * поверх записей других клиентов и блокировок; мастер — 403.
 * Цена пересчитывается только у мастера другого уровня (решение 11).
 */
export function rescheduleBooking(db: Db, actor: Actor, bookingId: number, req: RescheduleRequest, now: Date): void {
  requireBookingRole(actor);
  // Наложение при переносе — только у администратора; у клиента признак молча отбрасывается.
  const isOverbooking = hasRole(actor, 'admin') && req.isOverbooking === true;
  let target: { masterId: number; durationMin: number; cleanupMin: number } | undefined;
  try {
    transaction(db, () => {
      const booking = loadBooking(db, bookingId);
      if (!booking) throw notFound('Запись не найдена');
      assertCanChange(db, actor, booking, now);
      checkVersion(booking.version, req.version);

      const masterId = req.masterId ?? booking.master_id;
      target = { masterId, durationMin: booking.durationMin, cleanupMin: booking.cleanupMin };
      if (masterId === booking.master_id && req.startsAt === booking.starts_at) {
        throw badRequest('NOTHING_TO_CHANGE', 'Новое время совпадает с текущим');
      }
      const master = requireMasterForVisit(db, masterId, booking.serviceIds);

      if (hasRole(actor, 'client')) {
        const hold = ownHold(db, actor);
        if (!hold || hold.booking_id !== bookingId) throw conflict('HOLD_NOT_FOUND', 'Новое время не закреплено за вами. Выберите время заново');
        if (hold.expires_at <= now.toISOString()) throw conflict('HOLD_EXPIRED', 'Время брони истекло. Проверьте, свободно ли еще это время');
        if (hold.master_id !== masterId || hold.starts_at !== req.startsAt) {
          throw conflict('HOLD_MISMATCH', 'Бронь не совпадает с выбранными мастером и временем. Выберите время заново');
        }
      }

      const check = checkSlot(db, {
        masterId, startsAt: req.startsAt, durationMin: booking.durationMin, cleanupMin: booking.cleanupMin, now,
        audience: 'admin', viewerId: actor.id, excludeBookingId: bookingId, overbooking: isOverbooking,
      });
      if (!check.available) throw new SlotUnavailable();

      db.prepare('DELETE FROM slot_holds WHERE owner_id = ?').run(actor.id);
      writeReschedule(db, booking, {
        masterId, level: master.level, startsAt: req.startsAt, actorId: actor.id, reason: req.reason, at: now.toISOString(), isOverbooking,
      });
      // Перенос сделал администратор — клиент узнает об этом в кабинете: откуда, куда и к кому.
      // Свой перенос клиент не получает: он только что выбрал время сам.
      notifyRescheduled(db, actor, booking, { startsAt: req.startsAt, masterId }, now.toISOString());
      // Перенос поверх занятого времени — то же наложение: предупреждаем тех, чье время теперь делится.
      if (isOverbooking) {
        notifyOverbooked(db, actor, {
          id: booking.id, masterId, startsAt: req.startsAt,
          busyUntil: addMin(addMin(req.startsAt, booking.durationMin), booking.cleanupMin),
        }, now.toISOString());
      }
    });
  } catch (error) {
    if (isSlotConflict(error) && target) {
      throw slotTaken(nearestFreeSlots(db, {
        masterIds: [target.masterId], startsAt: req.startsAt, durationMin: target.durationMin, cleanupMin: target.cleanupMin, now,
        audience: hasRole(actor, 'admin') ? 'admin' : 'client', viewerId: actor.id, excludeBookingId: bookingId,
      }));
    }
    throw error;
  }
}

export interface CancelRequest {
  reason: string | null;
  /** Кто отменил — выбирает только администратор (A-05); клиент всегда отменяет от своего имени. */
  by?: 'client' | 'studio';
  version?: number;
}

/**
 * Отмена (CAB-05, A-05, сценарий 17). Клиент — своей записи до срока правила 24 часов, статус «Отменена клиентом»;
 * администратор — любой, by = client или studio (по умолчанию studio); мастер — 403.
 * accountDeletion — отмена предстоящих записей при удалении аккаунта: правило 24 часов не действует.
 */
export function cancelBooking(db: Db, actor: Actor, bookingId: number, req: CancelRequest, now: Date, options: { accountDeletion?: boolean } = {}): void {
  requireBookingRole(actor);
  if (hasRole(actor, 'client') && req.by === 'studio') {
    throw badRequest('VALIDATION_ERROR', 'Клиент отменяет запись от своего имени', { fields: [{ field: 'by', message: 'Клиент отменяет запись от своего имени' }] });
  }
  transaction(db, () => {
    const booking = db.prepare('SELECT client_id, status, starts_at, version FROM bookings WHERE id = ?').get(bookingId) as
      { client_id: number; status: string; starts_at: string; version: number } | undefined;
    if (!booking) throw notFound('Запись не найдена');
    assertCanChange(db, actor, booking, now, { ignoreDeadline: options.accountDeletion });
    checkVersion(booking.version, req.version);
    writeCancellation(db, {
      bookingId, version: booking.version,
      status: hasRole(actor, 'client') || req.by === 'client' ? 'cancelled_by_client' : 'cancelled_by_studio',
      actorId: actor.id, reason: req.reason, at: now.toISOString(),
    });
    // Отмену внес администратор — клиент узнает о ней в кабинете. Свою отмену клиент не получает,
    // как и отмену предстоящих записей при удалении собственного аккаунта.
    notifyCancelled(db, actor, { id: bookingId, client_id: booking.client_id, starts_at: booking.starts_at }, req.reason, now.toISOString());
  });
}

/**
 * «Визит завершен» или «Клиент не пришел» (A-03, A-06) — только администратор и только для визита,
 * который уже начался. Ошибочную отметку можно исправить: завершена ↔ не пришел.
 */
export function setVisitResult(
  db: Db, actor: Actor, bookingId: number, req: { status: ResultStatus; reason: string | null; version?: number }, now: Date,
): void {
  if (!hasRole(actor, 'admin')) throw forbidden('Итог визита отмечает администратор');
  transaction(db, () => {
    const booking = db.prepare('SELECT status, starts_at, version FROM bookings WHERE id = ?').get(bookingId) as
      { status: string; starts_at: string; version: number } | undefined;
    if (!booking) throw notFound('Запись не найдена');
    checkVersion(booking.version, req.version);
    if (booking.status === 'cancelled_by_client' || booking.status === 'cancelled_by_studio') {
      throw conflict('BOOKING_NOT_ACTIVE', 'Запись отменена: отметить визит нельзя');
    }
    if (booking.status === req.status) throw badRequest('NOTHING_TO_CHANGE', 'У записи уже этот статус');
    if (booking.starts_at > now.toISOString()) throw conflict('VISIT_NOT_STARTED', 'Отметить визит можно, когда он уже начался');
    writeStatusChange(db, {
      bookingId, version: booking.version, oldStatus: booking.status, status: req.status,
      actorId: actor.id, reason: req.reason, at: now.toISOString(),
    });
  });
}

/** Клиент, за которого записывает администратор: из базы или новый, по имени и телефону (сценарий 16). */
function resolveClient(db: Db, clientId: number | undefined, newClient: { name: string; phone: string } | undefined, now: Date): number {
  if (clientId !== undefined) {
    const client = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client' AND deleted_at IS NULL").get(clientId);
    if (!client) throw badRequest('CLIENT_NOT_FOUND', 'Клиент не найден', { clientId });
    return clientId;
  }
  const existing = db.prepare('SELECT id, role FROM users WHERE phone = ?').get(newClient!.phone) as { id: number; role: string } | undefined;
  if (existing) {
    throw conflict('PHONE_TAKEN', 'Клиент с этим телефоном уже есть в базе — выберите его', existing.role === 'client' ? { clientId: existing.id } : undefined);
  }
  return Number(db.prepare("INSERT INTO users (role, name, phone, created_at, updated_at) VALUES ('client', ?, ?, ?, ?)")
    .run(newClient!.name, newClient!.phone, now.toISOString(), now.toISOString()).lastInsertRowid);
}
