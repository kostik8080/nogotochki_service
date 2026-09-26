// Восстановление пароля (AUTH-06, AUTH-08; паспорт, функция 1 клиента). Пока SMS-шлюз не подключен,
// пароль восстанавливается по ссылке на e-mail; с подключенным шлюзом вход по телефону получает код в SMS.
// Ответ на запрос одинаковый, есть такой аккаунт или нет: иначе по нему можно было бы проверять,
// зарегистрирован ли чужой номер или адрес.
import { consumeCode, consumeLinkToken, issueCode, issueLinkToken, lastCodeAt, RESEND_INTERVAL_MS, LINK_TTL_MIN, CODE_TTL_MIN } from '../auth/codes.js';
import { hashPassword } from '../auth/password.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { type Db, transaction } from '../db/connection.js';
import { badRequest, HttpError } from '../http/errors.js';
import type { Context, Result, Router } from '../http/router.js';
import { Input, normalizePhone } from '../http/validate.js';

interface ResetUser {
  id: number;
  phone: string | null;
  email: string | null;
}

/** Пользователь по логину: только с паролем, не удаленный и не заблокированный. */
function findByLogin(db: Db, login: string): { user: ResetUser | undefined; byPhone: boolean } {
  const byPhone = !login.includes('@');
  const value = byPhone ? normalizePhone(login) : login.trim().toLowerCase();
  if (!value) return { user: undefined, byPhone };
  const user = db.prepare(`
    SELECT id, phone, email FROM users
    WHERE ${byPhone ? 'phone' : 'email'} = ? AND password_hash IS NOT NULL AND deleted_at IS NULL AND blocked_at IS NULL
  `).get(value) as ResetUser | undefined;
  return { user, byPhone };
}

const invalidCode = (details?: unknown) =>
  badRequest('INVALID_CODE', 'Код или ссылка недействительны или устарели. Запросите восстановление еще раз', details);

export function passwordResetRoutes(router: Router): void {
  // Запросить ссылку (на e-mail) или код (в SMS). Всегда 202, если данные верны по форме.
  router.post('/api/auth/password-reset/request', async (ctx): Promise<Result> => {
    ctx.limit('code', ctx.ip);
    const input = Input.body(ctx.body);
    const login = input.string('login', { max: 254 });
    input.done();

    const { mailer, sms, appUrl } = ctx.services;
    if (!mailer && !sms) {
      throw new HttpError(503, 'RECOVERY_UNAVAILABLE', 'Восстановление пароля временно недоступно. Обратитесь в студию');
    }

    const { user, byPhone } = findByLogin(ctx.db, login);
    const last = user ? lastCodeAt(ctx.db, user.id, 'reset_password') : null;
    if (user && (last === null || ctx.now.getTime() - last >= RESEND_INTERVAL_MS)) {
      // Сбой почты или SMS не меняет ответ: иначе по ошибке можно было бы понять, что аккаунт есть.
      try {
        if (byPhone && sms && user.phone) {
          const code = transaction(ctx.db, () => issueCode(ctx.db, user.id, 'reset_password', user.phone!, ctx.now));
          await sms.send(user.phone, `Ноготочки: код для восстановления пароля ${code}. Действует ${CODE_TTL_MIN} минут.`);
        } else if (mailer && user.email) {
          const token = transaction(ctx.db, () => issueLinkToken(ctx.db, user.id, 'reset_password', user.email!, ctx.now));
          await mailer.send({
            to: user.email,
            subject: 'Восстановление пароля — Ноготочки',
            text: `Здравствуйте!\n\nЧтобы задать новый пароль, откройте ссылку:\n${appUrl}/reset-password?token=${token}\n\n` +
              `Ссылка действует ${LINK_TTL_MIN} минут и работает один раз. Если вы не запрашивали восстановление, просто удалите это письмо.`,
          });
        }
      } catch (error) {
        console.error('Не удалось отправить ссылку или код для восстановления пароля:', error);
      }
    }
    return { status: 202, body: { message: 'Если такой аккаунт есть, мы отправили ссылку на e-mail или код в SMS' } };
  });

  // Задать новый пароль: { token, password } по ссылке из письма или { login, code, password } по коду из SMS.
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
