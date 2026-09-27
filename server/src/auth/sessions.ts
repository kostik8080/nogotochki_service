// Серверные сессии (docs/db-schema.md, раздел 5.8, решение 17). Браузер получает случайный токен
// в cookie с флагом HttpOnly, а в базе лежит только его хеш SHA-256: украденными строками базы войти нельзя.
// Сессию можно закрыть сразу — при выходе, смене пароля, блокировке учетной записи.
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.js';

export const SESSION_COOKIE = 'nogotochki_session';
/** last_seen_at обновляется не на каждый запрос, а не чаще раза в 5 минут: лишние записи в базу не нужны. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export type Role = 'client' | 'admin' | 'master';

/**
 * Сколько дней действует сессия. У сотрудников срок короче: их учетная запись открывает записи и контакты
 * всех клиентов студии, а входят они с рабочего места, где чужая cookie достается проще. Клиентка
 * записывается со смартфона раз в месяц — ей вход на месяц.
 */
export const SESSION_TTL_DAYS: Record<Role, number> = { client: 30, admin: 7, master: 7 };

export interface SessionUser {
  id: number;
  role: Role;
  name: string;
  sessionId: number;
}

export type SessionLookup =
  | { status: 'ok'; user: SessionUser }
  /** Срок сессии вышел (экран SYS-03 «Сессия истекла»). */
  | { status: 'expired' }
  /** Токена нет в базе, сессия закрыта или учетная запись заблокирована и удалена. */
  | { status: 'invalid' };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Срок берется по роли из базы, а не из аргумента: иначе вызывающий код мог бы выдать сотруднику месяц. */
export function createSession(db: Db, userId: number, now: Date): { token: string; expiresAt: Date } {
  const owner = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: Role } | undefined;
  if (!owner) throw new Error(`Нельзя открыть сессию: пользователя ${userId} нет`);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS[owner.role] * 24 * 3600_000);
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)
  `).run(userId, hashToken(token), now.toISOString(), now.toISOString(), expiresAt.toISOString());
  return { token, expiresAt };
}

export function findSession(db: Db, token: string, now: Date): SessionLookup {
  const row = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, s.revoked_at, s.last_seen_at,
           u.id, u.role, u.name, u.blocked_at, u.deleted_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(hashToken(token)) as {
    session_id: number; expires_at: string; revoked_at: string | null; last_seen_at: string;
    id: number; role: Role; name: string; blocked_at: string | null; deleted_at: string | null;
  } | undefined;
  if (!row || row.revoked_at || row.blocked_at || row.deleted_at) return { status: 'invalid' };
  if (row.expires_at <= now.toISOString()) return { status: 'expired' };

  if (now.getTime() - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), row.session_id);
  }
  return { status: 'ok', user: { id: row.id, role: row.role, name: row.name, sessionId: row.session_id } };
}

export function revokeSession(db: Db, sessionId: number, now: Date): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now.toISOString(), sessionId);
}

/**
 * Cookie сессии. HttpOnly — скрипт страницы не прочитает токен; SameSite=Lax — браузер не отправит
 * cookie с POST-запросом с чужого сайта; Secure — только по HTTPS (в production).
 */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/**
 * Закрыть все сессии пользователя, кроме текущей (если указана): после смены или сброса пароля,
 * блокировки и удаления аккаунта вход с других устройств перестает действовать сразу (решение 17).
 */
export function revokeUserSessions(db: Db, userId: number, now: Date, exceptSessionId: number | null = null): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?')
    .run(now.toISOString(), userId, exceptSessionId);
}
