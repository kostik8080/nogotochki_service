// Бронь времени на время оформления (docs/db-schema.md, раздел 8). Клиент выбрал слот и нажал
// «Продолжить» — время закрепляется за ним на settings.slot_hold_min минут (10) и не предлагается другим.
// Бронь истекает сама: во всех проверках учитываются только строки с expires_at > сейчас, а истекшие
// строки удаляет уборка (cleanupExpired раз в минуту и при каждой новой брони).
import { hasRole } from '../auth/sessions.js';
import { checkSlot, isSlotConflict, nearestFreeSlots, SlotUnavailable, slotTaken } from '../booking/availability.js';
import { loadBooking, pricesAtLevel } from '../booking/existing.js';
import { cleanupExpiredHolds } from '../booking/cleanup.js';
import { findMastersForServices } from '../booking/slots.js';
import { readVisitItems, requireMasterForVisit, resolveVisit, visitPrice, type Level } from '../booking/visit.js';
import { transaction } from '../db/connection.js';
import { badRequest, notFound } from '../http/errors.js';
import type { Result, Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { readSettings } from '../studio/settings.js';
import { requireChangeableBooking, requireNotMaintenance, requireRole } from './guards.js';
import { holdView, type HoldRow } from './views.js';

export function holdRoutes(router: Router): void {
  // Создать бронь. Новая бронь заменяет прежнюю: у пользователя одна бронь (раздел 9).
  //   { "masterId": 2, "startsAt": "…Z", "services": [{ "serviceId": 12 }] } — новая запись;
  //   { "masterId": null, … } — «Любой свободный мастер»: мастера назначает сервис;
  //   { "bookingId": 7, "startsAt": "…Z", "masterId"?: 3 } — перенос записи (CAB-04).
  router.post('/api/holds', (ctx): Result => {
    // Мастер бронь не держит (раздел 10.8): у роли пока нет прав.
    const user = requireRole(ctx, 'client', 'admin');
    ctx.limit('hold', String(user.id));
    const input = Input.body(ctx.body);
    const startsAt = input.instant('startsAt');
    const masterId = input.id('masterId', { optional: true, nullable: true });
    const bookingId = input.id('bookingId', { optional: true });
    const items = input.has('services') ? readVisitItems(input) : undefined;
    if (bookingId === undefined && !input.has('services')) input.fail('services', 'Укажите услуги визита или запись для переноса');
    if (bookingId !== undefined && input.has('services')) input.fail('services', 'При переносе услуги берутся из записи');
    if (bookingId !== undefined && masterId === null) input.fail('masterId', 'При переносе укажите мастера или не передавайте поле');
    input.done();
    requireNotMaintenance(ctx, user);

    const settings = readSettings(ctx.db);
    const audience = hasRole(user, 'admin') ? 'admin' : 'client';
    const now = ctx.now;
    // Что искали — для подбора альтернатив после отката транзакции.
    let wanted: { masterIds: number[]; durationMin: number; cleanupMin: number; excludeBookingId: number | null } | undefined;

    try {
      const result = transaction(ctx.db, () => {
        cleanupExpiredHolds(ctx.db, now);

        // Что удерживаем: длительность D, уборку C, кандидатов в мастера и цену у каждого.
        let durationMin: number;
        let cleanupMin: number;
        let candidates: { id: number; name: string; level: Level }[];
        let priceOf: (level: Level) => number;
        let excludeBookingId: number | null = null;
        if (bookingId !== undefined) {
          const booking = loadBooking(ctx.db, bookingId);
          if (!booking) throw notFound('Запись не найдена');
          requireChangeableBooking(ctx, user, booking);
          ({ durationMin, cleanupMin } = booking);
          candidates = [requireMasterForVisit(ctx.db, masterId ?? booking.master_id, booking.serviceIds)];
          priceOf = (level) => pricesAtLevel(booking, level).totalKop;
          excludeBookingId = booking.id;
        } else {
          const visit = resolveVisit(ctx.db, items!);
          ({ durationMin, cleanupMin } = visit);
          candidates = masterId
            ? [requireMasterForVisit(ctx.db, masterId, visit.serviceIds)]
            : findMastersForServices(ctx.db, visit.serviceIds).map((id) => requireMasterForVisit(ctx.db, id, visit.serviceIds));
          if (candidates.length === 0) {
            throw badRequest('NO_MASTER_FOR_SERVICES', 'Ни один мастер не выполняет все выбранные услуги. Разделите их на несколько визитов');
          }
          priceOf = (level) => visitPrice(visit, level);
        }

        wanted = { masterIds: candidates.map((m) => m.id), durationMin, cleanupMin, excludeBookingId };

        // Прежняя бронь пользователя снимается: новая ее заменяет. Если новую создать не удастся,
        // транзакция откатится, и прежняя бронь останется.
        ctx.db.prepare('DELETE FROM slot_holds WHERE owner_id = ?').run(user.id);

        // Первый по порядку показа мастер, у которого это время свободно (для «Любого мастера» — назначение).
        for (const master of candidates) {
          const check = checkSlot(ctx.db, {
            masterId: master.id, startsAt, durationMin, cleanupMin, now, audience, viewerId: user.id, excludeBookingId,
          });
          if (!check.available) continue;
          const endsAt = new Date(Date.parse(startsAt) + durationMin * 60_000).toISOString();
          const busyUntil = new Date(Date.parse(endsAt) + cleanupMin * 60_000).toISOString();
          const expiresAt = new Date(now.getTime() + settings.slot_hold_min * 60_000).toISOString();
          const id = Number(ctx.db.prepare(`
            INSERT INTO slot_holds (owner_id, master_id, starts_at, ends_at, busy_until, booking_id, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(user.id, master.id, startsAt, endsAt, busyUntil, excludeBookingId, expiresAt, now.toISOString()).lastInsertRowid);
          const hold = ctx.db.prepare('SELECT * FROM slot_holds WHERE id = ?').get(id) as unknown as HoldRow;
          return { hold, master, priceKop: priceOf(master.level), durationMin };
        }
        // Ни у кого из мастеров время не свободно: откат вернет прежнюю бронь пользователя.
        throw new SlotUnavailable();
      });
      return {
        status: 201,
        body: {
          hold: {
            ...holdView(result.hold, now),
            master: { id: result.master.id, name: result.master.name, level: result.master.level },
            durationMin: result.durationMin,
            priceKop: result.priceKop,
          },
        },
      };
    } catch (error) {
      // Время занято: по проверке сервера или по триггеру slot_holds_no_overlap, если кто-то занял его
      // между проверкой и вставкой (сценарий 4). Ответ — 409 с ближайшим свободным временем.
      if (isSlotConflict(error) && wanted) {
        throw slotTaken(nearestFreeSlots(ctx.db, { ...wanted, startsAt, now, audience, viewerId: user.id }));
      }
      throw error;
    }
  });

  // Текущая действующая бронь пользователя — например, после возврата на шаг подтверждения.
  // Истекшая бронь не возвращается: клиент увидит «Время брони истекло» (BOOK-M2) и создаст новую.
  router.get('/api/holds/current', (ctx): Result => {
    const user = requireRole(ctx, 'client', 'admin');
    const hold = ctx.db.prepare('SELECT * FROM slot_holds WHERE owner_id = ? AND expires_at > ?')
      .get(user.id, ctx.now.toISOString()) as unknown as HoldRow | undefined;
    return { status: 200, body: { hold: hold ? holdView(hold, ctx.now) : null } };
  });

  // Выйти из записи (BOOK-M6): бронь снимается сразу, время освобождается, не дожидаясь срока.
  router.delete('/api/holds/current', (ctx): Result => {
    const user = requireRole(ctx, 'client', 'admin');
    ctx.db.prepare('DELETE FROM slot_holds WHERE owner_id = ?').run(user.id);
    return { status: 204 };
  });
}
