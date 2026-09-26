// Регистрация, вход и выход (паспорт, функция 1 клиента и функция 1 администратора).
// Вход — по телефону или e-mail и паролю, один для всех ролей; права определяет роль учетной записи.
import { CODE_TTL_MIN, consumeCode, issueCode, lastCodeAt, RESEND_INTERVAL_MS } from '../auth/codes.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { clearSessionCookie, createSession, revokeSession, sessionCookie } from '../auth/sessions.js';
import { config } from '../config.js';
import { transaction } from '../db/connection.js';
import { badRequest, conflict, forbidden, HttpError, unauthorized } from '../http/errors.js';
import type { Context, Result, Router } from '../http/router.js';
import { Input, normalizePhone } from '../http/validate.js';
import { requireUser } from './guards.js';
import { selfView } from './views.js';

/** После стольких неверных паролей подряд вход временно запрещен (паспорт, риск «Подбор паролей»). */
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

/**
 * Хеш для сравнения, когда пользователя нет: вход по чужому логину занимает столько же времени,
 * сколько по существующему, и по задержке ответа нельзя узнать, зарегистрирован ли номер.
 */
let dummyHash: string | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing'));

export function authRoutes(router: Router, options: { secureCookies: boolean }): void {
  const { secureCookies } = options;

  const startSession = (ctx: Context, userId: number): void => {
    const { token, expiresAt } = createSession(ctx.db, userId, ctx.now);
    ctx.setCookie(sessionCookie(token, expiresAt, secureCookies));
  };

  // Регистрация клиента. Сотрудников заводит администратор (npm run admin:create), поэтому роль всегда client.
  //
  // Сценарий 16: номер уже есть в карточке клиента, которого администратор записал по телефону (без пароля).
  // Второй клиент не создается: первый запрос отвечает 202 и требует код подтверждения номера, повторный
  // запрос с тем же набором полей и code добавляет пароль к существующей карточке — ее записи сразу видны
  // в кабинете. Код приходит в SMS; пока шлюз не подключен, его выдает администратор после звонка клиентки
  // (POST /api/admin/clients/:id/phone-code). Без кода привязка не выполняется: иначе любой, кто знает
  // чужой номер, получил бы доступ к чужим записям.
  router.post('/api/auth/register', async (ctx): Promise<Result> => {
    ctx.limit('register', ctx.ip);
    const input = Input.body(ctx.body);
    const name = input.string('name', { max: 100 });
    const phone = input.phone('phone', { optional: true });
    const email = input.email('email', { optional: true });
    const password = input.password('password');
    const pdConsent = input.bool('pdConsent');
    const marketingConsent = input.bool('marketingConsent', { optional: true }) ?? false;
    const code = input.field<string>('code', { optional: true }, (raw) =>
      typeof raw === 'string' && /^\d{6}$/.test(raw.trim()) ? { value: raw.trim() } : { error: 'Код — 6 цифр' });
    if (!input.has('phone') && !input.has('email')) input.fail('phone', 'Укажите телефон или e-mail');
    if (pdConsent === false) input.fail('pdConsent', 'Без согласия на обработку персональных данных регистрация невозможна');
    if (input.has('code') && !input.has('phone')) input.fail('code', 'Код подтверждает телефон — укажите его');
    input.done();

    const now = ctx.now.toISOString();
    const owner = phone
      ? ctx.db.prepare('SELECT id, role, password_hash, deleted_at FROM users WHERE phone = ?').get(phone) as
        { id: number; role: string; password_hash: string | null; deleted_at: string | null } | undefined
      : undefined;
    const card = owner && owner.role === 'client' && owner.password_hash === null && owner.deleted_at === null ? owner : undefined;
    if (owner && !card) throw conflict('PHONE_TAKEN', 'Этот телефон уже зарегистрирован. Войдите или восстановите пароль');
    if (email && ctx.db.prepare('SELECT 1 FROM users WHERE email = ? AND id IS NOT ?').get(email, card?.id ?? null)) {
      throw conflict('EMAIL_TAKEN', 'Этот e-mail уже зарегистрирован. Войдите или восстановите пароль');
    }

    if (card && code === undefined) {
      // Шаг 1 сценария 16: нужен код. С SMS-шлюзом — отправляем (не чаще раза в минуту), без него код выдаст администратор.
      const { sms } = ctx.services;
      if (sms) {
        const last = lastCodeAt(ctx.db, card.id, 'verify_phone');
        if (last === null || ctx.now.getTime() - last >= RESEND_INTERVAL_MS) {
          const sent = transaction(ctx.db, () => issueCode(ctx.db, card.id, 'verify_phone', phone!, ctx.now));
          await sms.send(phone!, `Ноготочки: код подтверждения номера ${sent}. Действует ${CODE_TTL_MIN} минут.`);
        }
      }
      return {
        status: 202,
        body: {
          status: 'phone_verification_required',
          delivery: sms ? 'sms' : 'studio',
          message: sms
            ? 'Этот номер уже есть в базе студии: вас записывали по телефону. Мы отправили код в SMS — введите его, и прежние записи появятся в кабинете'
            : 'Этот номер уже есть в базе студии: вас записывали по телефону. Позвоните в студию — администратор убедится, что это вы, и продиктует код',
          expiresInMin: CODE_TTL_MIN,
        },
      };
    }

    // Хеш считается до транзакции: argon2id занимает заметное время, а блокировку базы держать незачем.
    const passwordHash = hashPassword(password);

    if (card) {
      // Шаг 2 сценария 16: проверка кода — отдельной транзакцией, чтобы неверная попытка сохранилась.
      const check = transaction(ctx.db, () => consumeCode(ctx.db, card.id, 'verify_phone', code!, ctx.now));
      if (!check.ok || check.target !== phone) {
        throw badRequest('INVALID_CODE', check.ok || check.reason !== 'wrong' ? 'Код недействителен или устарел. Запросите новый' : 'Неверный код',
          !check.ok && check.reason === 'wrong' ? { attemptsLeft: check.attemptsLeft } : undefined);
      }
      transaction(ctx.db, () => {
        const linked = ctx.db.prepare(`
          UPDATE users SET name = ?, email = coalesce(?, email), password_hash = ?, phone_verified_at = ?,
                           pd_consent_at = ?, pd_consent_version = ?, marketing_consent_at = ?, updated_at = ?
          WHERE id = ? AND password_hash IS NULL
        `).run(name, email ?? null, passwordHash, now, now, config.pdPolicyVersion, marketingConsent ? now : null, now, card.id);
        // Пока проверялся код, карточку мог привязать параллельный запрос.
        if (linked.changes !== 1) throw conflict('PHONE_TAKEN', 'Этот телефон уже зарегистрирован. Войдите или восстановите пароль');
        startSession(ctx, card.id);
      });
      return { status: 201, body: { user: selfView(ctx.db, card.id), linkedExistingClient: true } };
    }

    const userId = transaction(ctx.db, () => {
      // Номер или адрес могли занять между проверкой и вставкой: тогда UNIQUE даст 409.
      const id = Number(ctx.db.prepare(`
        INSERT INTO users (role, name, phone, email, password_hash, pd_consent_at, pd_consent_version,
                           marketing_consent_at, created_at, updated_at)
        VALUES ('client', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, phone ?? null, email ?? null, passwordHash, now, config.pdPolicyVersion,
        marketingConsent ? now : null, now, now).lastInsertRowid);
      startSession(ctx, id);
      return id;
    });
    return { status: 201, body: { user: selfView(ctx.db, userId) } };
  });

  router.post('/api/auth/login', (ctx): Result => {
    ctx.limit('login', ctx.ip);
    const input = Input.body(ctx.body);
    const login = input.string('login', { max: 254 });
    // Пароль не обрезается и не проверяется на длину 8+: как при регистрации, пробелы по краям — часть пароля,
    // а короткий неверный пароль — это «неверный пароль» (401), а не ошибка формы.
    const password = input.field<string>('password', undefined, (raw) =>
      typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? { value: raw } : { error: 'Введите пароль' });
    input.done();

    // Логин — e-mail, если в нем есть @, иначе телефон. Телефон приводится к E.164, как при регистрации.
    let where: string;
    let value: string;
    if (login.includes('@')) {
      [where, value] = ['email', login.toLowerCase()];
    } else {
      const phone = normalizePhone(login);
      if (!phone) throw badRequest('VALIDATION_ERROR', 'Введите телефон или e-mail', { fields: [{ field: 'login', message: 'Введите телефон или e-mail' }] });
      [where, value] = ['phone', phone];
    }

    const user = ctx.db.prepare(`
      SELECT id, password_hash, failed_login_attempts, locked_until, blocked_at FROM users WHERE ${where} = ? AND deleted_at IS NULL
    `).get(value) as { id: number; password_hash: string | null; failed_login_attempts: number; locked_until: string | null; blocked_at: string | null } | undefined;

    const now = ctx.now.toISOString();
    if (user?.locked_until && user.locked_until > now) {
      const retryAfter = Math.ceil((Date.parse(user.locked_until) - ctx.now.getTime()) / 1000);
      throw new HttpError(429, 'LOGIN_LOCKED', 'Слишком много неверных попыток. Попробуйте позже', undefined, { 'Retry-After': String(retryAfter) });
    }
    const ok = verifyPassword(password, user?.password_hash ?? getDummyHash());
    if (!user || !user.password_hash || !ok) {
      if (user) {
        const attempts = user.failed_login_attempts + 1;
        const lock = attempts >= MAX_FAILED_LOGINS;
        ctx.db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(
          lock ? 0 : attempts, lock ? new Date(ctx.now.getTime() + LOCK_MINUTES * 60_000).toISOString() : user.locked_until, now, user.id);
      }
      throw unauthorized('Неверный логин или пароль', 'INVALID_CREDENTIALS');
    }
    // О закрытом доступе сообщается только после верного пароля: иначе ответ выдавал бы, что аккаунт существует.
    if (user.blocked_at) throw forbidden('Доступ к учетной записи закрыт. Обратитесь в студию', 'ACCOUNT_BLOCKED');

    transaction(ctx.db, () => {
      ctx.db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(now, user.id);
      startSession(ctx, user.id);
    });
    return { status: 200, body: { user: selfView(ctx.db, user.id) } };
  });

  // Выход закрывает сессию и снимает бронь времени, чтобы слот освободился сразу (раздел 8, шаг 5).
  // Без сессии — тоже 204: результат тот же, пользователь не вошел.
  router.post('/api/auth/logout', (ctx): Result => {
    const user = ctx.user;
    if (user) {
      transaction(ctx.db, () => {
        revokeSession(ctx.db, user.sessionId, ctx.now);
        ctx.db.prepare('DELETE FROM slot_holds WHERE owner_id = ?').run(user.id);
      });
    }
    ctx.setCookie(clearSessionCookie(secureCookies));
    return { status: 204 };
  });

  router.get('/api/auth/me', (ctx): Result => {
    const user = requireUser(ctx);
    return { status: 200, body: { user: selfView(ctx.db, user.id) } };
  });
}
