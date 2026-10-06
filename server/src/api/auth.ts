// Регистрация, вход и выход (паспорт, функция 1 клиента и функция 1 администратора).
// Вход — по телефону или e-mail и паролю, один для всех ролей; права определяет роль учетной записи.
import { randomBytes } from 'node:crypto';
import { CODE_TTL_MIN, consumeCode, issueCode, lastCodeAt, RESEND_INTERVAL_MS } from '../auth/codes.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { clearSessionCookie, createSession, revokeSession, sessionCookie } from '../auth/sessions.js';
import { YANDEX_PROVIDER, yandexAuthorizeUrl } from '../auth/yandex.js';
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
  // в кабинете. SMS в сервисе нет: код приходит на e-mail из карточки клиентки, а если его там нет — его выдает
  // администратор после звонка (POST /api/admin/users/:id/phone-code). Без кода привязка не выполняется:
  // иначе любой, кто знает чужой номер, получил бы доступ к чужим записям.
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
      ? ctx.db.prepare('SELECT id, role, password_hash, provider, deleted_at FROM users WHERE phone = ?').get(phone) as
        { id: number; role: string; password_hash: string | null; provider: string | null; deleted_at: string | null } | undefined
      : undefined;
    // Карточка — это клиент без пароля, которого завел администратор. У клиента, который входит через
    // Яндекс, пароля тоже нет, но это зарегистрированный аккаунт: его отличает provider (миграция 009).
    const card = owner && owner.role === 'client' && owner.password_hash === null && owner.provider === null
      && owner.deleted_at === null ? owner : undefined;
    if (owner && !card) throw conflict('PHONE_TAKEN', 'Этот телефон уже зарегистрирован. Войдите или восстановите пароль');
    if (email && ctx.db.prepare('SELECT 1 FROM users WHERE email = ? AND id IS NOT ?').get(email, card?.id ?? null)) {
      throw conflict('EMAIL_TAKEN', 'Этот e-mail уже зарегистрирован. Войдите или восстановите пароль');
    }

    if (card && code === undefined) {
      // Шаг 1 сценария 16: нужен код. SMS в сервисе нет. Если в карточке есть e-mail, который студия записала
      // со слов клиентки, код уходит туда; иначе его продиктует администратор после звонка. Код создается
      // в любом случае (не чаще раза в минуту): он отмечает запрос, по которому администратор выдаст свой код.
      const { mailer } = ctx.services;
      const cardEmail = (ctx.db.prepare('SELECT email FROM users WHERE id = ?').get(card.id) as { email: string | null }).email;
      const byEmail = mailer !== null && cardEmail !== null;
      const last = lastCodeAt(ctx.db, card.id, 'verify_phone');
      // Сколько ждать до следующего кода. Код этой цели создается не чаще раза в минуту, и письмо
      // уходит только вместе с новым кодом: старый мы отправить не можем, в базе лежит лишь его хеш.
      const waitMs = last === null ? 0 : Math.max(0, RESEND_INTERVAL_MS - (ctx.now.getTime() - last));
      // Ушло ли письмо именно сейчас. Раньше ответ обещал письмо всегда, даже когда его не отправляли:
      // внутри минуты после прошлого запроса и когда почтовый сервер не принял письмо. Человек ждал
      // письма, которого не будет, — теперь ответ говорит, что произошло на самом деле.
      let sent = false;
      if (waitMs === 0) {
        const code = transaction(ctx.db, () => issueCode(ctx.db, card.id, 'verify_phone', phone!, ctx.now));
        if (byEmail) {
          try {
            await mailer!.send({
              to: cardEmail!,
              subject: 'Код подтверждения — Ноготочки',
              text: `Код для доступа к вашим записям в студии «Ноготочки»: ${code}

Код действует ${CODE_TTL_MIN} минут. Если вы не регистрировались на сайте, просто удалите это письмо.`,
            });
            sent = true;
          } catch (error) {
            console.error('Не удалось отправить код подтверждения номера:', error);
          }
        }
      }
      const masked = cardEmail === null ? null : maskEmail(cardEmail);
      const retryAfterSec = Math.ceil(waitMs / 1000);
      const emailMessage = sent
        ? `Этот номер уже есть в базе студии: вас записывали по телефону. Мы отправили код на e-mail ${masked} — введите его, и прежние записи появятся в кабинете`
        : waitMs > 0
          // «Если письмо не пришло» — не вежливость: прошлый запрос мог прийтись на момент, когда e-mail
          // в карточке еще не было, и тогда письма не было вовсе. Обещать, что оно уже в почте, нельзя.
          ? `Этот номер уже есть в базе студии: вас записывали по телефону. Код запрашивали меньше минуты назад. Если письмо на ${masked} не пришло, запросите новый код через ${retryAfterSec} с`
          : `Этот номер уже есть в базе студии, но письмо с кодом на ${masked} отправить не удалось. Попробуйте запросить код еще раз или позвоните в студию`;
      return {
        status: 202,
        body: {
          status: 'phone_verification_required',
          delivery: byEmail ? 'email' : 'studio',
          ...(byEmail ? { sentTo: masked, sent } : {}),
          ...(waitMs > 0 ? { retryAfterSec } : {}),
          message: byEmail
            ? emailMessage
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

  /**
   * Куда отправить человека на страницу согласия Яндекса. Секрет приложения сюда не попадает:
   * в адресе только идентификатор (он не секретный), адрес возврата и случайная строка state.
   * State браузер запоминает у себя и сверяет, когда Яндекс вернет человека обратно: так видно,
   * что человек вернулся со своего же входа, а не пришел по чужой ссылке.
   */
  router.get('/api/auth/yandex/start', (ctx): Result => {
    ctx.limit('login', ctx.ip);
    const state = randomBytes(16).toString('base64url');
    return { status: 200, body: { url: yandexAuthorizeUrl(state), state } };
  });

  /**
   * Вход через Яндекс в один клик. Браузер только нажимает кнопку: e-mail и имя сервер берет
   * у внешнего сервиса сам (ctx.services.yandexLogin — настоящий Яндекс или заглушка,
   * src/auth/yandex.ts). **Эти поля нельзя принимать из тела запроса**: тогда любой прислал бы чужой
   * адрес и вошел бы в чужой кабинет без пароля. `code` — одноразовый код Яндекса, он понадобится,
   * когда приложение в Яндексе будет зарегистрировано; заглушка его не использует.
   *
   * Что дальше (порядок важен):
   *   1. пользователь ищется по e-mail из профиля;
   *   2. нашелся — внешний вход привязывается к нему, второй аккаунт не создается: иначе записи
   *      одной клиентки разъехались бы по двум кабинетам;
   *   3. не нашелся — создается новый аккаунт;
   *   4. роль всегда client: она записана в INSERT строкой, из запроса не читается, а база не даст
   *      поставить provider учетной записи администратора или мастера (миграция 009);
   *   5. выдается своя сессия сервиса — та же cookie, тот же срок, что при входе по паролю;
   *   6. токен Яндекса не сохраняется и в сервисе ничего не открывает.
   */
  router.post('/api/auth/yandex', async (ctx): Promise<Result> => {
    ctx.limit('login', ctx.ip);
    const input = Input.body(ctx.body);
    const code = input.string('code', { optional: true, max: 500 });
    input.done();

    const profile = await ctx.services.yandexLogin({ code });
    const now = ctx.now.toISOString();
    const existing = ctx.db.prepare(`
      SELECT id, role, blocked_at FROM users WHERE email = ? AND deleted_at IS NULL
    `).get(profile.email) as { id: number; role: string; blocked_at: string | null } | undefined;

    // Учетную запись сотрудника внешний вход не открывает: администратор и мастер входят по паролю
    // (паспорт: роль после создания не меняется, сотруднику для записи нужен отдельный аккаунт клиента).
    if (existing && existing.role !== 'client') {
      throw forbidden('Это учетная запись сотрудника: войдите по телефону или e-mail и паролю', 'STAFF_PASSWORD_LOGIN_ONLY');
    }
    if (existing?.blocked_at) throw forbidden('Доступ к учетной записи закрыт. Обратитесь в студию', 'ACCOUNT_BLOCKED');

    const { userId, created } = transaction(ctx.db, () => {
      if (existing) {
        // Адрес подтвержден Яндексом, поэтому e-mail считается подтвержденным. Согласие на обработку
        // данных записывается, если его еще не было: под кнопкой на экране входа об этом сказано.
        // Если этот provider_id уже привязан к другому аккаунту (в Яндексе сменили адрес), UNIQUE даст 409.
        ctx.db.prepare(`
          UPDATE users SET provider = ?, provider_id = ?, email_verified_at = coalesce(email_verified_at, ?),
                           pd_consent_at = coalesce(pd_consent_at, ?), pd_consent_version = coalesce(pd_consent_version, ?),
                           failed_login_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE id = ?
        `).run(YANDEX_PROVIDER, profile.providerId, now, now, config.pdPolicyVersion, now, existing.id);
        startSession(ctx, existing.id);
        return { userId: existing.id, created: false };
      }
      const id = Number(ctx.db.prepare(`
        INSERT INTO users (role, name, email, provider, provider_id, email_verified_at,
                           pd_consent_at, pd_consent_version, created_at, updated_at)
        VALUES ('client', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(profile.name, profile.email, YANDEX_PROVIDER, profile.providerId, now, now,
        config.pdPolicyVersion, now, now).lastInsertRowid);
      startSession(ctx, id);
      return { userId: id, created: true };
    });

    return { status: created ? 201 : 200, body: { user: selfView(ctx.db, userId), provider: YANDEX_PROVIDER, registered: created } };
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

/** Адрес для подсказки «код отправлен на m***@mail.ru»: ровно столько, чтобы узнать свой, но не чужой. */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
