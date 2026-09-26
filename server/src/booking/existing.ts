// Существующая запись для переноса и отмены: ее длительность, уборка и цены — значения на момент записи
// (booking_items, bookings.busy_until), а не текущий прайс (docs/db-schema.md, разделы 5.20 и 11.2).
import type { Db } from '../db/connection.js';
import type { Level } from './visit.js';

export interface ExistingItem {
  service_id: number;
  quantity: number;
  duration_min: number;
  unit_price_kop: number;
  price_kop: number;
  /** Текущие цены услуги — для пересчета при переносе к мастеру другого уровня. */
  price_master_kop: number;
  price_top_kop: number;
}

export interface ExistingBooking {
  id: number;
  client_id: number;
  master_id: number;
  status: string;
  starts_at: string;
  ends_at: string;
  busy_until: string;
  price_level: Level;
  version: number;
  items: ExistingItem[];
  serviceIds: number[];
  durationMin: number;
  /** Уборка, скопированная в момент записи: busy_until − ends_at. */
  cleanupMin: number;
  totalKop: number;
}

export function loadBooking(db: Db, id: number): ExistingBooking | undefined {
  const b = db.prepare(`
    SELECT id, client_id, master_id, status, starts_at, ends_at, busy_until, price_level, version FROM bookings WHERE id = ?
  `).get(id) as Omit<ExistingBooking, 'items' | 'serviceIds' | 'durationMin' | 'cleanupMin' | 'totalKop'> | undefined;
  if (!b) return undefined;
  const items = db.prepare(`
    SELECT bi.service_id, bi.quantity, bi.duration_min, bi.unit_price_kop, bi.price_kop, s.price_master_kop, s.price_top_kop
    FROM booking_items bi JOIN services s ON s.id = bi.service_id
    WHERE bi.booking_id = ? ORDER BY bi.position
  `).all(id) as unknown as ExistingItem[];
  return {
    ...b,
    items,
    serviceIds: items.map((i) => i.service_id),
    durationMin: items.reduce((sum, i) => sum + i.duration_min, 0),
    cleanupMin: (Date.parse(b.busy_until) - Date.parse(b.ends_at)) / 60_000,
    totalKop: items.reduce((sum, i) => sum + i.price_kop, 0),
  };
}

/**
 * Цены записи у мастера этого уровня (решение 11): тот же уровень — цены записи не меняются,
 * даже если прайс вырос; другой уровень — пересчет по текущему прайсу.
 */
export function pricesAtLevel(b: ExistingBooking, level: Level): { changed: boolean; totalKop: number; units: number[] } {
  if (level === b.price_level) return { changed: false, totalKop: b.totalKop, units: b.items.map((i) => i.unit_price_kop) };
  const units = b.items.map((i) => (level === 'top_master' ? i.price_top_kop : i.price_master_kop));
  return { changed: true, totalKop: units.reduce((sum, u, k) => sum + u * b.items[k]!.quantity, 0), units };
}
