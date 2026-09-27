// Одноразовые коды и ссылки (docs/db-schema.md, раздел 5.7): подтверждение телефона и e-mail, сброс пароля.
// SMS в сервисе нет: код приходит на e-mail или его выдает администратор, убедившись по звонку, что это сам человек.
// Сам код, как и пароль, не хранится — в базе только хеш. Код перестает действовать после трех неверных
// попыток, по истечении срока и после использования (паспорт, риск «Подбор паролей, кодов»).
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/connection.js';

export type CodePurpose = 'verify_phone' | 'verify_email' | 'login' | 'reset_password';

/** Сколько неверных попыток выдерживает код. */
export const MAX_CODE_ATTEMPTS = 3;
/** Код из 6 цифр живет 15 минут, ссылка для сброса пароля — 60 минут. */
export const CODE_TTL_MIN = 15;
export const LINK_TTL_MIN = 60;
/** Не чаще одного кода той же цели в минуту: защита от рассылки писем и SMS на чужой адрес. */
export const RESEND_INTERVAL_MS = 60_000;

/**
 * Хеш кода. Короткий код смешивается с номером пользователя и целью: одинаковые коды разных людей
 * дают разные хеши. Токен ссылки — 32 случайных байта, его хеш подобрать нельзя.
 */
const hashCode = (userId: number, purpose: CodePurpose, code: string) =>
  createHash('sha256').update(`${userId}:${purpose}:${code}`).digest('hex');
const hashToken = (token: string) => createHash('sha256').update(`token:${token}`).digest('hex');

interface CodeRow {
  id: number;
  user_id: number;
  target: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  created_at: string;
}

/**
 * Адрес из последнего неиспользованного запроса кода этой цели за последние сутки — например, новый телефон,
 * который клиент попросил подтвердить. По нему администратор выдает код, если подтверждает сам.
 */
export function pendingTarget(db: Db, userId: number, purpose: CodePurpose, now: Date): { target: string; requestedAt: string } | null {
  const row = db.prepare(`
    SELECT target, created_at FROM auth_codes
    WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND created_at > ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(userId, purpose, new Date(now.getTime() - 86_400_000).toISOString()) as { target: string; created_at: string } | undefined;
  return row ? { target: row.target, requestedAt: row.created_at } : null;
}

/** Когда пользователь последний раз получал код этой цели — для ограничения повторной отправки. */
export function lastCodeAt(db: Db, userId: number, purpose: CodePurpose): number | null {
  const row = db.prepare('SELECT max(created_at) AS at FROM auth_codes WHERE user_id = ? AND purpose = ?').get(userId, purpose) as { at: string | null };
  return row.at ? Date.parse(row.at) : null;
}

/**
 * Новый код из 6 цифр. Прежние неиспользованные коды этой цели гасятся: действует только последний.
 * Возвращает открытый код — его отправляют пользователю и больше нигде не сохраняют.
 */
export function issueCode(db: Db, userId: number, purpose: CodePurpose, target: string, now: Date): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  insert(db, userId, purpose, target, hashCode(userId, purpose, code), CODE_TTL_MIN, now);
  return code;
}

/** Токен для ссылки в письме (сброс пароля по e-mail). */
export function issueLinkToken(db: Db, userId: number, purpose: CodePurpose, target: string, now: Date): string {
  const token = randomBytes(32).toString('base64url');
  insert(db, userId, purpose, target, hashToken(token), LINK_TTL_MIN, now);
  return token;
}

function insert(db: Db, userId: number, purpose: CodePurpose, target: string, codeHash: string, ttlMin: number, now: Date): void {
  db.prepare('UPDATE auth_codes SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL')
    .run(now.toISOString(), userId, purpose);
  db.prepare(`
    INSERT INTO auth_codes (user_id, purpose, target, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, purpose, target, codeHash, new Date(now.getTime() + ttlMin * 60_000).toISOString(), now.toISOString());
}

export type CodeCheck =
  | { ok: true; target: string }
  /** Кода нет, он использован, истек или исчерпал попытки. */
  | { ok: false; reason: 'invalid' | 'expired' | 'attempts' }
  | { ok: false; reason: 'wrong'; attemptsLeft: number };

/** Проверяет код пользователя и при успехе гасит его. Неверный код засчитывается как попытка. */
export function consumeCode(db: Db, userId: number, purpose: CodePurpose, code: string, now: Date): CodeCheck {
  const row = db.prepare(`
    SELECT id, user_id, target, code_hash, attempts, expires_at, created_at FROM auth_codes
    WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(userId, purpose) as CodeRow | undefined;
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.expires_at <= now.toISOString()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'attempts' };

  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(hashCode(userId, purpose, code), 'hex');
  if (!timingSafeEqual(expected, actual)) {
    db.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = MAX_CODE_ATTEMPTS - row.attempts - 1;
    return left > 0 ? { ok: false, reason: 'wrong', attemptsLeft: left } : { ok: false, reason: 'attempts' };
  }
  db.prepare('UPDATE auth_codes SET consumed_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return { ok: true, target: row.target };
}

/** Проверяет токен ссылки и гасит его. Возвращает пользователя и адрес, куда была отправлена ссылка. */
export function consumeLinkToken(db: Db, purpose: CodePurpose, token: string, now: Date): { userId: number; target: string } | null {
  const row = db.prepare(`
    SELECT id, user_id, target, expires_at FROM auth_codes
    WHERE code_hash = ? AND purpose = ? AND consumed_at IS NULL
  `).get(hashToken(token), purpose) as { id: number; user_id: number; target: string; expires_at: string } | undefined;
  if (!row || row.expires_at <= now.toISOString()) return null;
  db.prepare('UPDATE auth_codes SET consumed_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return { userId: row.user_id, target: row.target };
}
