// Настройки студии — одна строка settings (docs/db-schema.md, раздел 5.1).
import type { Db } from '../db/connection.js';

export interface StudioSettings {
  studio_name: string;
  address: string;
  phone: string;
  map_url: string | null;
  vk_url: string | null;
  telegram_url: string | null;
  timezone: string;
  slot_step_min: number;
  booking_horizon_days: number;
  min_lead_min: number;
  client_change_deadline_hours: number;
  slot_hold_min: number;
  is_maintenance: number;
}

export function readSettings(db: Db): StudioSettings {
  const row = db.prepare(`
    SELECT studio_name, address, phone, map_url, vk_url, telegram_url, timezone, slot_step_min, booking_horizon_days,
           min_lead_min, client_change_deadline_hours, slot_hold_min, is_maintenance
    FROM settings WHERE id = 1
  `).get() as StudioSettings | undefined;
  if (!row) throw new Error('Нет строки настроек студии: примените миграции (npm run db:migrate)');
  return row;
}

/**
 * Телефон студии для текста, который читает человек: «+7 (999) 123-45-67» вместо «+79991234567».
 * Такой же формат показывает интерфейс (web/js/format.js), и в сообщениях сервера он должен совпадать.
 * Непохожий на российский номер возвращается как есть: придумывать за студию формат незачем.
 */
export function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11 || !/^[78]/.test(digits)) return value;
  return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
}
