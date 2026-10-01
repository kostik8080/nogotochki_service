// Восстановление пароля (AUTH-06, AUTH-08; паспорт, функция 1 клиента). SMS в сервисе нет: пароль
// восстанавливается по ссылке на e-mail. Если в аккаунте нет e-mail, код для сброса выдает администратор,
// убедившись по звонку, что это сам человек (POST /api/admin/users/:id/password-reset-code).
// Ответ на запрос одинаковый, есть такой аккаунт или нет: иначе по нему можно было бы проверять,
// зарегистрирован ли чужой номер или адрес.
import { consumeCode, consumeLinkToken, issueLinkToken, lastCodeAt, RESEND_INTERVAL_MS, LINK_TTL_MIN } from '../auth/codes.js';
import { hashPassword } from '../auth/password.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { type Db, transaction } from '../db/connection.js';
import { badRequest } from '../http/errors.js';
import type { Context, Result, Router } from '../http/router.js';
import { Input, normalizePhone } from '../http/validate.js';

interface ResetUser {
  id: number;
  phone: string | null;
  email: string | null;
}

/** Пользователь по логину: только с паролем, не удаленный и не заблокированный. */
function findByLogin(db: Db, login: string): { user: ResetUser | undefined } {
  const value = loginValue(login);
  if (!value) return { user: undefined };
  const user = db.prepare(`
    SELECT id, phone, email FROM users
    WHERE ${value.field} = ? AND password_hash IS NOT NULL AND deleted_at IS NULL AND blocked_at IS NULL
  `).get(value.value) as ResetUser | undefined;
  return { user };
}

/** Логин — e-mail, если в нем есть «@», иначе телефон в формате базы. */
function loginValue(login: string): { field: 'phone' | 'email'; value: string } | null {
  if (login.includes('@')) return { field: 'email', value: login.trim().toLowerCase() };
  const phone = normalizePhone(login);
  return phone ? { field: 'phone', value: phone } : null;
}

/**
 * Внешний сервис, через который этот аккаунт входит, если пароля у него нет (users.provider).
 * Такому человеку сбрасывать нечего: письмо со ссылкой на новый пароль только сбило бы его с толку,
 * потому что в аккаунт он попадает кнопкой «Войти через Яндекс».
 */
function loginProvider(db: Db, login: string): string | null {
  const value = loginValue(login);
  if (!value) return null;
  const row = db.prepare(`
    SELECT provider FROM users
    WHERE ${value.field} = ? AND password_hash IS NULL AND provider IS NOT NULL
      AND deleted_at IS NULL AND blocked_at IS NULL
  `).get(value.value) as { provider: string } | undefined;
  return row?.provider ?? null;
}

const invalidCode = (details?: unknown) =>
  badRequest('INVALID_CODE', 'Код или ссылка недействительны или устарели. Запросите восстановление еще раз', details);

export function passwordResetRoutes(router: Router): void {
  // Запросить ссылку на e-mail. Войти можно и по телефону: ссылка уходит на e-mail аккаунта. Всегда 202.
  router.post('/api/auth/password-reset/request', async (ctx): Promise<Result> => {
    ctx.limit('code', ctx.ip);
    const input = Input.body(ctx.body);
    const login = input.string('login', { max: 254 });
    input.done();

    // У аккаунта с внешним входом пароля нет: вместо письма — объяснение, чем в него входить.
    // Это единственный ответ, по которому видно, что аккаунт есть, и он осознанный: без него человек
    // бесконечно ждал бы письмо, которого не будет (docs/api.md, «Вход»).
    const provider = loginProvider(ctx.db, login);
    if (provider !== null) {
      return {
        status: 200,
        body: {
          provider,
          message: 'В этот аккаунт вход выполняется через Яндекс, пароля у него нет. '
            + 'Вернитесь на страницу входа и нажмите «Войти через Яндекс»',
        },
      };
    }

    const { mailer, appUrl } = ctx.services;
    const { user } = findByLogin(ctx.db, login);
    const last = user ? lastCodeAt(ctx.db, user.id, 'reset_password') : null;
    if (user && user.email && mailer && (last === null || ctx.now.getTime() - last >= RESEND_INTERVAL_MS)) {
      // Сбой почты не меняет ответ: иначе по ошибке можно было бы понять, что аккаунт есть.
      try {
        const token = transaction(ctx.db, () => issueLinkToken(ctx.db, user.id, 'reset_password', user.email!, ctx.now));
        await mailer.send({
          to: user.email,
          subject: 'Восстановление пароля — Ноготочки',
          text: `Здравствуйте!

Чтобы задать новый пароль, откройте ссылку:
${appUrl}/reset-password?token=${token}

` +
            `Ссылка действует ${LINK_TTL_MIN} минут и работает один раз. Если вы не запрашивали восстановление, просто удалите это письмо.`,
        });
      } catch (error) {
        console.error('Не удалось отправить ссылку для восстановления пароля:', error);
      }
    }
    return {
      status: 202,
      body: {
        message: 'Если такой аккаунт есть и в нем указан e-mail, мы отправили на него ссылку. '
          + 'Если e-mail в аккаунте не указан, позвоните в студию: администратор убедится, что это вы, и продиктует код для сброса',
      },
    };
  });

  // Задать новый пароль: { token, password } по ссылке из письма или { login, code, password } по коду от администратора.
  // Все сессии пользователя закрываются: тот, кто знал старый пароль, больше не войдет.
  router.post('/api/auth/password-reset/confirm', (ctx: Context): Result => {
    ctx.limit('code', ctx.ip);
    const input = Input.body(ctx.body);
    const token = input.string('token', { optional: true, max: 200 });
    const login = input.string('login', { optional: true, max: 254 });
    const code = input.field<string>('code', { optional: true }, (raw) =>
      typeof raw === 'string' && /^\d{6}$/.test(raw.trim()) ? { value: raw.trim() } : { error: 'Код — 6 цифр' });
    const password = input.password('password');
    if (!input.has('token') && !(input.has('login') && input.has('code'))) input.fail('token', 'Нужна ссылка из письма или логин и код');
    if (input.has('token') && (input.has('login') || input.has('code'))) input.fail('token', 'Укажите либо ссылку, либо логин и код');
    input.done();

    const passwordHash = hashPassword(password);
    const now = ctx.now.toISOString();
    // Ошибка кода должна сохранить засчитанную попытку, поэтому проверка кода — отдельной транзакцией.
    const verified = transaction(ctx.db, () => {
      if (token !== undefined) {
        const found = consumeLinkToken(ctx.db, 'reset_password', token, ctx.now);
        return found ? { userId: found.userId, target: found.target } : { error: invalidCode() };
      }
      const { user } = findByLogin(ctx.db, login!);
      if (!user) return { error: invalidCode() };
      const check = consumeCode(ctx.db, user.id, 'reset_password', code!, ctx.now);
      if (!check.ok) return { error: invalidCode(check.reason === 'wrong' ? { attemptsLeft: check.attemptsLeft } : undefined) };
      return { userId: user.id, target: check.target };
    });
    if ('error' in verified) throw verified.error;

    transaction(ctx.db, () => {
      // Ссылка или код пришли на этот адрес — значит, он подтвержден.
      const verifiedField = verified.target.includes('@') ? 'email_verified_at' : 'phone_verified_at';
      ctx.db.prepare(`
        UPDATE users SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL,
                         ${verifiedField} = coalesce(${verifiedField}, ?), updated_at = ?
        WHERE id = ?
      `).run(passwordHash, now, now, verified.userId);
      revokeUserSessions(ctx.db, verified.userId, ctx.now);
    });
    return { status: 204 };
  });
}
