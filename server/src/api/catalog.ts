// Публичная часть: студия, каталог услуг, мастера и свободное время. Вход не нужен.
import { hasRole } from '../auth/sessions.js';
import { loadBooking, pricesAtLevel } from '../booking/existing.js';
import { findMastersForServices, getMasterDay, getSlots, getSlotsAnyMaster } from '../booking/slots.js';
import { readVisitItemsQuery, requireMasterForVisit, resolveVisit, visitPrice, type Level, type Visit } from '../booking/visit.js';
import type { Db } from '../db/connection.js';
import { notFound } from '../http/errors.js';
import { pathId, type Context, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { readSettings } from '../studio/settings.js';
import { requireChangeableBooking, requireUser } from './guards.js';

interface MasterRow {
  id: number;
  name: string;
  level: Level;
  specialty: string | null;
  experience_years: number | null;
  bio: string | null;
  photo_url: string | null;
}

const MASTER_FIELDS = 'id, name, level, specialty, experience_years, bio, photo_url';

function masterView(db: Db, m: MasterRow) {
  const serviceIds = (db.prepare(`
    SELECT ms.service_id FROM master_services ms JOIN services s ON s.id = ms.service_id
    WHERE ms.master_id = ? AND s.is_active = 1 ORDER BY s.sort_order, s.id
  `).all(m.id) as { service_id: number }[]).map((r) => r.service_id);
  return {
    id: m.id, name: m.name, level: m.level, specialty: m.specialty,
    experienceYears: m.experience_years, bio: m.bio, photoUrl: m.photo_url, serviceIds,
  };
}

/** Активный мастер для публичных экранов; отключенного клиенты не видят (раздел 5.13). */
function activeMaster(db: Db, id: number): MasterRow {
  const master = db.prepare(`SELECT ${MASTER_FIELDS} FROM masters WHERE id = ? AND is_active = 1`).get(id) as MasterRow | undefined;
  if (!master) throw notFound('Мастер не найден');
  return master;
}

/** Кто смотрит расчет: администратор не связан минимальным временем до визита и горизонтом (раздел 7.3, шаг 6). */
const audienceOf = (ctx: Context) => (ctx.user && hasRole(ctx.user, 'admin') ? 'admin' : 'client') as 'admin' | 'client';

export function catalogRoutes(router: Router): void {
  // Контакты и правила записи: что показать на лендинге, на экранах ошибок и в подсказке о правиле 24 часов.
  router.get('/api/studio', (ctx): Result => {
    const s = readSettings(ctx.db);
    const hours = ctx.db.prepare('SELECT weekday, open_time, close_time FROM studio_hours ORDER BY weekday').all() as
      { weekday: number; open_time: string; close_time: string }[];
    return {
      status: 200,
      body: {
        name: s.studio_name, address: s.address, phone: s.phone,
        mapUrl: s.map_url, vkUrl: s.vk_url, telegramUrl: s.telegram_url,
        timezone: s.timezone,
        hours: hours.map((h) => ({ weekday: h.weekday, open: h.open_time, close: h.close_time })),
        rules: {
          slotStepMin: s.slot_step_min, bookingHorizonDays: s.booking_horizon_days, minLeadMin: s.min_lead_min,
          clientChangeDeadlineHours: s.client_change_deadline_hours, slotHoldMin: s.slot_hold_min,
        },
        isMaintenance: s.is_maintenance === 1,
      },
    };
  });

  // Каталог: активные услуги активных категорий, правила опции и несовместимые пары (BOOK-01).
  router.get('/api/services', (ctx): Result => {
    const categories = ctx.db.prepare(
      'SELECT id, name FROM service_categories WHERE is_active = 1 ORDER BY sort_order, id',
    ).all() as { id: number; name: string }[];
    const services = ctx.db.prepare(`
      SELECT s.id, s.category_id, s.kind, s.name, s.description, s.duration_min, s.price_master_kop, s.price_top_kop,
             s.price_unit, s.max_quantity, s.photo_url, s.is_featured
      FROM services s JOIN service_categories c ON c.id = s.category_id
      WHERE s.is_active = 1 AND c.is_active = 1
      ORDER BY s.sort_order, s.id
    `).all() as {
      id: number; category_id: number; kind: string; name: string; description: string | null; duration_min: number;
      price_master_kop: number; price_top_kop: number; price_unit: string | null; max_quantity: number;
      photo_url: string | null; is_featured: number;
    }[];
    const active = new Set(services.map((s) => s.id));
    const rules = ctx.db.prepare('SELECT addon_service_id, main_service_id FROM service_addon_rules ORDER BY 1, 2').all() as
      { addon_service_id: number; main_service_id: number }[];
    const pairs = ctx.db.prepare('SELECT service_a_id, service_b_id, reason FROM service_incompatibilities ORDER BY 1, 2').all() as
      { service_a_id: number; service_b_id: number; reason: string }[];

    return {
      status: 200,
      body: {
        categories: categories.map((c) => ({
          id: c.id,
          name: c.name,
          services: services.filter((s) => s.category_id === c.id).map((s) => ({
            id: s.id, kind: s.kind, name: s.name, description: s.description, durationMin: s.duration_min,
            // Цена «от» в каталоге — цена мастера, меньшая из двух (раздел 6).
            priceMasterKop: s.price_master_kop, priceTopKop: s.price_top_kop, priceUnit: s.price_unit,
            maxQuantity: s.max_quantity, photoUrl: s.photo_url, isFeatured: s.is_featured === 1,
          })),
        })),
        addonRules: [...new Set(rules.map((r) => r.addon_service_id))].filter((id) => active.has(id)).map((addonId) => ({
          addonServiceId: addonId,
          mainServiceIds: rules.filter((r) => r.addon_service_id === addonId && active.has(r.main_service_id)).map((r) => r.main_service_id),
        })),
        incompatibilities: pairs.filter((p) => active.has(p.service_a_id) && active.has(p.service_b_id))
          .map((p) => ({ serviceIds: [p.service_a_id, p.service_b_id], reason: p.reason })),
      },
    };
  });

  // Мастера. С ?services=… — только те, кто выполняет все услуги визита, со стоимостью визита у каждого (BOOK-02).
  router.get('/api/masters', (ctx): Result => {
    const input = Input.query(ctx.query);
    const items = input.has('services') ? readVisitItemsQuery(input) : undefined;
    input.done();

    const visit = items ? resolveVisit(ctx.db, items) : undefined;
    const ids = visit ? findMastersForServices(ctx.db, visit.serviceIds) : undefined;
    const rows = ctx.db.prepare(`SELECT ${MASTER_FIELDS} FROM masters WHERE is_active = 1 ORDER BY sort_order, id`).all() as unknown as MasterRow[];
    const masters = rows
      .filter((m) => !ids || ids.includes(m.id))
      .map((m) => ({
        ...masterView(ctx.db, m),
        ...(visit ? { visit: { durationMin: visit.durationMin, priceKop: visitPrice(visit, m.level) } } : {}),
      }));
    return { status: 200, body: { masters } };
  });

  // Профиль мастера (PUB-05): услуги с ценой по его уровню.
  router.get('/api/masters/:id', (ctx): Result => {
    const master = activeMaster(ctx.db, pathId(ctx));
    const services = ctx.db.prepare(`
      SELECT s.id, s.kind, s.name, s.duration_min, s.price_master_kop, s.price_top_kop, s.price_unit
      FROM master_services ms JOIN services s ON s.id = ms.service_id JOIN service_categories c ON c.id = s.category_id
      WHERE ms.master_id = ? AND s.is_active = 1 AND c.is_active = 1
      ORDER BY s.sort_order, s.id
    `).all(master.id) as { id: number; kind: string; name: string; duration_min: number; price_master_kop: number; price_top_kop: number; price_unit: string | null }[];
    return {
      status: 200,
      body: {
        master: {
          ...masterView(ctx.db, master),
          services: services.map((s) => ({
            id: s.id, kind: s.kind, name: s.name, durationMin: s.duration_min, priceUnit: s.price_unit,
            priceKop: master.level === 'top_master' ? s.price_top_kop : s.price_master_kop,
          })),
        },
      },
    };
  });

  // Свободное время мастера на дату (BOOK-03, CAB-04). Считается при каждом запросе из графика мастера,
  // режима студии, записей, блокировок и чужих действующих броней — готовых слотов нигде нет (раздел 7.5).
  // Для переноса вместо services передается bookingId: длительность и уборка берутся из записи.
  router.get('/api/masters/:id/slots', (ctx): Result => {
    const masterId = pathId(ctx);
    const input = Input.query(ctx.query);
    const date = input.date('date');
    const items = input.has('services') ? readVisitItemsQuery(input) : undefined;
    const bookingId = input.id('bookingId', { optional: true });
    if (!input.has('services') && !input.has('bookingId')) input.fail('services', 'Укажите услуги визита или запись для переноса');
    if (input.has('services') && input.has('bookingId')) input.fail('bookingId', 'Укажите либо услуги, либо запись для переноса');
    input.done();

    const audience = audienceOf(ctx);
    const master = audience === 'admin'
      ? ctx.db.prepare(`SELECT ${MASTER_FIELDS} FROM masters WHERE id = ?`).get(masterId) as MasterRow | undefined
      : activeMaster(ctx.db, masterId);
    if (!master) throw notFound('Мастер не найден');

    let timing: { durationMin: number; cleanupMin: number; priceKop: number };
    if (bookingId !== undefined) {
      timing = rescheduleTiming(ctx, bookingId, master);
    } else {
      const visit: Visit = resolveVisit(ctx.db, items!);
      requireMasterForVisit(ctx.db, masterId, visit.serviceIds);
      timing = { durationMin: visit.durationMin, cleanupMin: visit.cleanupMin, priceKop: visitPrice(visit, master.level) };
    }

    const { timezone } = readSettings(ctx.db);
    const day = getMasterDay(ctx.db, masterId, date);
    const slots = getSlots(ctx.db, {
      masterId, date, durationMin: timing.durationMin, cleanupMin: timing.cleanupMin, now: ctx.now, audience,
      viewerId: ctx.user?.id ?? null, excludeBookingId: bookingId ?? null,
    });
    return {
      status: 200,
      body: {
        date,
        timezone,
        masterId,
        day: { status: day.status, reason: day.status === 'studio_closed' ? day.reason : null },
        durationMin: timing.durationMin,
        priceKop: timing.priceKop,
        slots: slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
      },
    };
  });

  // Вариант «Любой свободный мастер» (BOOK-02, BOOK-03): слоты всех подходящих мастеров, в каждом — кто свободен.
  // Конкретного мастера сервис назначит при создании брони.
  router.get('/api/slots', (ctx): Result => {
    const input = Input.query(ctx.query);
    const date = input.date('date');
    const items = readVisitItemsQuery(input);
    input.done();

    const visit = resolveVisit(ctx.db, items);
    const { timezone } = readSettings(ctx.db);
    const masterIds = findMastersForServices(ctx.db, visit.serviceIds);
    const masters = masterIds.map((id) => {
      const m = ctx.db.prepare('SELECT id, name, level FROM masters WHERE id = ?').get(id) as { id: number; name: string; level: Level };
      return { id: m.id, name: m.name, level: m.level, priceKop: visitPrice(visit, m.level) };
    });
    const slots = getSlotsAnyMaster(ctx.db, {
      serviceIds: visit.serviceIds, date, now: ctx.now, audience: audienceOf(ctx), viewerId: ctx.user?.id ?? null,
    });
    return {
      status: 200,
      body: {
        date,
        timezone,
        durationMin: visit.durationMin,
        masters,
        slots: slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt, masterIds: s.masterIds })),
      },
    };
  });
}

/**
 * Длительность, уборка и цена для переноса записи: из самой записи, а не из текущего прайса.
 * Цена пересчитывается только у мастера другого уровня (решение 11). Смотреть слоты для переноса
 * может тот, кто вправе перенести запись: ее владелец до срока правила 24 часов или администратор.
 */
function rescheduleTiming(ctx: Context, bookingId: number, master: MasterRow) {
  const user = requireUser(ctx);
  const booking = loadBooking(ctx.db, bookingId);
  if (!booking) throw notFound('Запись не найдена');
  requireChangeableBooking(ctx, user, booking);
  requireMasterForVisit(ctx.db, master.id, booking.serviceIds);
  return {
    durationMin: booking.durationMin,
    cleanupMin: booking.cleanupMin,
    priceKop: pricesAtLevel(booking, master.level).totalKop,
  };
}
