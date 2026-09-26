// Состав визита: какие услуги можно объединить в одну запись, сколько визит длится и сколько стоит.
// Правила — docs/db-schema.md, раздел 5.20, и паспорт, функция 3. Часть из них повторяют триггеры базы
// (несовместимые услуги, мастер выполняет все услуги), но сервер проверяет их заранее, чтобы
// объяснить клиенту причину, а не ответить общим отказом.
import type { Db } from '../db/connection.js';
import { badRequest } from '../http/errors.js';
import type { Input, Parsed } from '../http/validate.js';
import { findMastersForServices, getVisitTiming } from './slots.js';

export type Level = 'master' | 'top_master';

export interface VisitItemInput {
  serviceId: number;
  quantity: number;
}

export interface VisitLine {
  serviceId: number;
  name: string;
  kind: 'main' | 'addon';
  quantity: number;
  durationMin: number;
  priceMasterKop: number;
  priceTopKop: number;
}

export interface Visit {
  /** Основные услуги в порядке выбора, затем опции: мастер выполняет их подряд. */
  lines: VisitLine[];
  serviceIds: number[];
  /** D — сумма длительностей (раздел 7). Клиент видит визит именно такой длины. */
  durationMin: number;
  /** C — уборка после визита, наибольшая среди услуг (решение 32). Клиент ее не видит. */
  cleanupMin: number;
}

/** Услуги визита из тела запроса: [{ "serviceId": 8 }, { "serviceId": 3, "quantity": 2 }]. */
export function readVisitItems(input: Input, key = 'services'): VisitItemInput[] {
  return input.objects(key, (item) => ({
    serviceId: item.id('serviceId'),
    quantity: item.int('quantity', { optional: true, min: 1, max: 100 }) ?? 1,
  }), { min: 1, max: 20 });
}

/** Услуги визита из строки запроса: ?services=8,3:2 — номер услуги и через двоеточие количество. */
export function readVisitItemsQuery(input: Input, key = 'services'): VisitItemInput[] {
  return input.field(key, undefined, (raw): Parsed<VisitItemInput[]> => {
    if (typeof raw !== 'string') return { error: 'Нужен список услуг' };
    const parts = raw.split(',');
    if (parts.length > 20) return { error: 'Не больше 20 услуг' };
    const items: VisitItemInput[] = [];
    for (const part of parts) {
      const m = /^(\d{1,9})(?::(\d{1,3}))?$/.exec(part.trim());
      if (!m || Number(m[1]) < 1 || (m[2] !== undefined && Number(m[2]) < 1)) {
        return { error: 'Нужен список услуг через запятую, количество — через двоеточие: 8,3:2' };
      }
      items.push({ serviceId: Number(m[1]), quantity: m[2] === undefined ? 1 : Number(m[2]) });
    }
    return { value: items };
  });
}

interface ServiceRow {
  id: number;
  name: string;
  kind: 'main' | 'addon';
  duration_min: number;
  price_master_kop: number;
  price_top_kop: number;
  max_quantity: number;
  is_active: number;
  category_active: number;
}

/**
 * Проверяет состав визита и считает длительность. Ошибки — 400 с объяснением для клиента:
 * услуга повторяется, отключена, количество больше допустимого, нет основной услуги,
 * опция без подходящей основной услуги, несовместимые услуги.
 * allowInactive — для уже созданной записи: отключенная услуга остается в ней (сценарий 7).
 */
export function resolveVisit(db: Db, items: VisitItemInput[], options: { allowInactive?: boolean } = {}): Visit {
  const ids = items.map((i) => i.serviceId);
  if (new Set(ids).size !== ids.length) {
    throw badRequest('DUPLICATE_SERVICE', 'Каждая услуга входит в визит один раз; количество задается полем quantity');
  }

  const rows = db.prepare(`
    SELECT s.id, s.name, s.kind, s.duration_min, s.price_master_kop, s.price_top_kop, s.max_quantity, s.is_active,
           c.is_active AS category_active
    FROM services s JOIN service_categories c ON c.id = s.category_id
    WHERE s.id IN (${ids.map(() => '?').join(', ')})
  `).all(...ids) as unknown as ServiceRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw badRequest('SERVICE_NOT_FOUND', 'Услуга не найдена', { serviceIds: missing });
  const inactive = rows.filter((r) => !r.is_active || !r.category_active);
  if (inactive.length > 0 && !options.allowInactive) {
    throw badRequest('SERVICE_INACTIVE', 'Услуга сейчас недоступна для записи', { serviceIds: inactive.map((r) => r.id) });
  }

  const lines: VisitLine[] = items.map((item) => {
    const s = byId.get(item.serviceId)!;
    if (item.quantity > s.max_quantity) {
      throw badRequest('QUANTITY_TOO_LARGE', `«${s.name}»: не больше ${s.max_quantity}`, { serviceId: s.id, maxQuantity: s.max_quantity });
    }
    return {
      serviceId: s.id, name: s.name, kind: s.kind, quantity: item.quantity, durationMin: s.duration_min,
      priceMasterKop: s.price_master_kop, priceTopKop: s.price_top_kop,
    };
  });

  const mains = lines.filter((l) => l.kind === 'main');
  const addons = lines.filter((l) => l.kind === 'addon');
  if (mains.length === 0) {
    throw badRequest('MAIN_SERVICE_REQUIRED', 'Опцию можно добавить только к основной услуге: выберите хотя бы одну основную');
  }

  // Опция доступна, если в визите есть хотя бы одна подходящая основная услуга (раздел 5.11).
  for (const addon of addons) {
    const allowed = db.prepare(`
      SELECT 1 FROM service_addon_rules
      WHERE addon_service_id = ? AND main_service_id IN (${mains.map(() => '?').join(', ')})
    `).get(addon.serviceId, ...mains.map((m) => m.serviceId));
    if (!allowed) {
      throw badRequest('ADDON_NOT_ALLOWED', `«${addon.name}» нельзя добавить к выбранным услугам`, { serviceId: addon.serviceId });
    }
  }

  // Несовместимые пары хранятся одной строкой с меньшим номером первым (раздел 5.12).
  const pair = db.prepare(`
    SELECT service_a_id, service_b_id, reason FROM service_incompatibilities
    WHERE service_a_id IN (${ids.map(() => '?').join(', ')}) AND service_b_id IN (${ids.map(() => '?').join(', ')})
    LIMIT 1
  `).get(...ids, ...ids) as { service_a_id: number; service_b_id: number; reason: string } | undefined;
  if (pair) throw badRequest('SERVICES_INCOMPATIBLE', pair.reason, { serviceIds: [pair.service_a_id, pair.service_b_id] });

  const ordered = [...mains, ...addons];
  const timing = getVisitTiming(db, ids);
  return { lines: ordered, serviceIds: ordered.map((l) => l.serviceId), ...timing };
}

/** Цена за единицу по уровню мастера (раздел 6). */
export const unitPrice = (line: VisitLine, level: Level) => (level === 'top_master' ? line.priceTopKop : line.priceMasterKop);

/** Стоимость визита в копейках у мастера этого уровня. */
export const visitPrice = (visit: Visit, level: Level) =>
  visit.lines.reduce((sum, l) => sum + unitPrice(l, level) * l.quantity, 0);

/** Активный мастер, который выполняет все услуги визита; иначе 400 с объяснением. */
export function requireMasterForVisit(db: Db, masterId: number, serviceIds: number[]): { id: number; name: string; level: Level } {
  const master = db.prepare('SELECT id, name, level, is_active FROM masters WHERE id = ?').get(masterId) as
    { id: number; name: string; level: Level; is_active: number } | undefined;
  if (!master) throw badRequest('MASTER_NOT_FOUND', 'Мастер не найден', { masterId });
  if (!master.is_active) throw badRequest('MASTER_INACTIVE', 'Мастер сейчас не принимает записи', { masterId });
  if (!findMastersForServices(db, serviceIds).includes(masterId)) {
    const missing = db.prepare(`
      SELECT id FROM services WHERE id IN (${serviceIds.map(() => '?').join(', ')})
        AND id NOT IN (SELECT service_id FROM master_services WHERE master_id = ?)
    `).all(...serviceIds, masterId) as { id: number }[];
    throw badRequest('MASTER_CANNOT_DO_SERVICE', 'Мастер не выполняет все выбранные услуги', {
      masterId, serviceIds: missing.map((r) => r.id),
    });
  }
  return { id: master.id, name: master.name, level: master.level };
}
