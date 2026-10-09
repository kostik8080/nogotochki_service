// Профиль (CAB-07, CAB-10; паспорт, функция 9 клиента): имя, согласие на новости, смена пароля,
// новый e-mail и телефон с подтверждением кодом, удаление аккаунта. Новый контакт записывается
// в users только после ввода кода: до этого он хранится в auth_codes.target (раздел 11.2).
import { consumeCode, issueCode, lastCodeAt, RESEND_INTERVAL_MS, CODE_TTL_MIN, type CodePurpose } from '../auth/codes.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { clearSessionCookie, revokeUserSessions } from '../auth/sessions.js';
import { transaction } from '../db/connection.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.js';
import { hasRole } from '../auth/sessions.js';
import { pathId, type Context, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { cancelBooking } from '../booking/booking-service.js';
import { deletePhotoFile, detectImageType, MAX_PHOTO_BYTES, PHOTO_TYPES, readPhoto, savePhoto } from '../storage/photos.js';
import { requireRole, requireUser } from './guards.js';
import { selfView } from './views.js';

/** Имя клиента после удаления аккаунта: по нему человека не узнать (решение 20). */
export const DELETED_CLIENT_NAME = 'Удаленный клиент';

function passwordHashOf(ctx: Context, userId: number): string | null {
  return (ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string | null }).password_hash;
}

/** Действие, которое можно подтвердить только паролем: неверный пароль — 403 (сессия есть, прав на действие нет). */
function requirePassword(ctx: Context, userId: number, password: string): void {
  const hash = passwordHashOf(ctx, userId);
  if (!hash || !verifyPassword(password, hash)) throw forbidden('Неверный текущий пароль', 'WRONG_PASSWORD');
}

const readCode = (input: Input) => input.field<string>('code', undefined, (raw) =>
  typeof raw === 'string' && /^\d{6}$/.test(raw.trim()) ? { value: raw.trim() } : { error: 'Код — 6 цифр' });

/** Карточка клиента заводится, когда понадобилась: до первого фото или заметки строки может не быть. */
function ensureClientProfile(ctx: Context, userId: number): void {
  ctx.db.prepare('INSERT INTO client_profiles (user_id, updated_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING')
    .run(userId, ctx.now.toISOString());
}

const clientPhotoPath = (ctx: Context, userId: number) =>
  (ctx.db.prepare('SELECT photo_path FROM client_profiles WHERE user_id = ?').get(userId) as { photo_path: string | null } | undefined)?.photo_path ?? null;

export function profileRoutes(router: Router): void {
  // ---------- Свое фото клиента ----------

  // Фото клиент ставит себе сам, без одобрения: на витрину студии оно не попадает. Видят его сам клиент,
  // администратор в карточке и мастер, у которого есть запись этого клиента (решение заказчика 08.10.2026).
  router.post('/api/profile/photo', (ctx): Result => {
    const user = requireRole(ctx, 'client');
    Input.query(ctx.query).done();
    const data = ctx.rawBody!.data;
    const type = detectImageType(data);
    if (!type) throw new HttpError(415, 'NOT_AN_IMAGE', 'Файл не похож на изображение JPEG, PNG или WebP');

    const previous = clientPhotoPath(ctx, user.id);
    const filePath = savePhoto(ctx.services.uploadsDir, data, type, ctx.now);
    try {
      transaction(ctx.db, () => {
        ensureClientProfile(ctx, user.id);
        ctx.db.prepare('UPDATE client_profiles SET photo_path = ?, updated_at = ? WHERE user_id = ?')
          .run(filePath, ctx.now.toISOString(), user.id);
      });
    } catch (error) {
      deletePhotoFile(ctx.services.uploadsDir, filePath);
      throw error;
    }
    // Прежнее фото больше нигде не показывается — убираем файл после фиксации
    if (previous !== null) deletePhotoFile(ctx.services.uploadsDir, previous);
    return { status: 200, body: { photoUrl: `/api/clients/${user.id}/photo` } };
  }, { types: PHOTO_TYPES, maxBytes: MAX_PHOTO_BYTES });

  router.delete('/api/profile/photo', (ctx): Result => {
    const user = requireRole(ctx, 'client');
    const previous = clientPhotoPath(ctx, user.id);
    if (previous === null) throw notFound('Фото нет');
    ctx.db.prepare('UPDATE client_profiles SET photo_path = NULL, updated_at = ? WHERE user_id = ?')
      .run(ctx.now.toISOString(), user.id);
    deletePhotoFile(ctx.services.uploadsDir, previous);
    return { status: 204 };
  });

  // Файл фото клиента. Это персональные данные, поэтому доступ узкий: сам клиент, администратор
  // и мастер, у которого есть запись этого клиента, — тот самый мастер, который и так видит его имя.
  router.get('/api/clients/:id/photo', (ctx): Result => {
    const user = requireUser(ctx);
    const clientId = pathId(ctx);
    if (user.id !== clientId && !hasRole(user, 'admin')) {
      const allowed = hasRole(user, 'master') && ctx.db.prepare(`
        SELECT 1 FROM bookings b JOIN masters m ON m.id = b.master_id
        WHERE b.client_id = ? AND m.user_id = ? LIMIT 1
      `).get(clientId, user.id) !== undefined;
      if (!allowed) throw forbidden('Это фото чужого клиента');
    }
    const path = clientPhotoPath(ctx, clientId);
    if (path === null) throw notFound('Фото нет');
    const file = readPhoto(ctx.services.uploadsDir, path);
    if (!file) throw notFound('Файл фото не найден');
    return { status: 200, file: { ...file, cache: 'private' } };
  });

  router.patch('/api/profile', (ctx): Result => {
    const user = requireUser(ctx);
    const input = Input.body(ctx.body);
    const name = input.string('name', { optional: true, max: 100 });
    const marketingConsent = input.bool('marketingConsent', { optional: true });
    input.done();

    const now = ctx.now.toISOString();
    if (name !== undefined) ctx.db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(name, now, user.id);
    if (marketingConsent !== undefined) {
      ctx.db.prepare('UPDATE users SET marketing_consent_at = ?, updated_at = ? WHERE id = ?')
        .run(marketingConsent ? now : null, now, user.id);
    }
    return { status: 200, body: { user: selfView(ctx.db, user.id) } };
  });

  // Смена пароля. Остальные сессии закрываются, текущая остается.
  router.post('/api/profile/password', (ctx): Result => {
    const user = requireUser(ctx);
    const input = Input.body(ctx.body);
    const currentPassword = input.field<string>('currentPassword', undefined, (raw) =>
      typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? { value: raw } : { error: 'Введите текущий пароль' });
    const newPassword = input.password('newPassword');
    input.done();

    // У аккаунта с внешним входом (Яндекс) пароля нет — менять нечего, и «неверный текущий пароль»
    // здесь только запутало бы.
    if (passwordHashOf(ctx, user.id) === null) {
      throw forbidden('В этот аккаунт вход выполняется через Яндекс: пароля у него нет', 'EXTERNAL_LOGIN_ONLY');
    }
    requirePassword(ctx, user.id, currentPassword);
    const hash = hashPassword(newPassword);
    transaction(ctx.db, () => {
      ctx.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, ctx.now.toISOString(), user.id);
      revokeUserSessions(ctx.db, user.id, ctx.now, user.sessionId);
    });
    return { status: 204 };
  });

  // Новый или неподтвержденный e-mail: код приходит на этот адрес, в профиль адрес попадет после ввода кода.
  router.post('/api/profile/email', async (ctx): Promise<Result> => {
    const user = requireUser(ctx);
    ctx.limit('code', ctx.ip);
    const input = Input.body(ctx.body);
    const email = input.email('email');
    input.done();

    const { mailer } = ctx.services;
    if (!mailer) throw new HttpError(503, 'EMAIL_UNAVAILABLE', 'Отправка писем временно недоступна. Попробуйте позже');
    const code = issueContactCode(ctx, user.id, 'verify_email', 'email', email);
    await deliver(() => mailer.send({
      to: email,
      subject: 'Код подтверждения — Ноготочки',
      text: `Ваш код подтверждения e-mail: ${code}\n\nКод действует ${CODE_TTL_MIN} минут. Если вы его не запрашивали, просто удалите это письмо.`,
    }));
    return { status: 202, body: { sentTo: email, expiresInMin: CODE_TTL_MIN } };
  });

  router.post('/api/profile/email/confirm', (ctx): Result => {
    const user = requireUser(ctx);
    const input = Input.body(ctx.body);
    const code = readCode(input);
    input.done();
    confirmContact(ctx, user.id, 'verify_email', 'email', code);
    return { status: 200, body: { user: selfView(ctx.db, user.id) } };
  });

  // Новый телефон. SMS в сервисе нет, поэтому номер подтверждает администратор: запрос запоминается,
  // клиент звонит в студию, администратор убеждается, что это он, и диктует код
  // (POST /api/admin/users/:id/phone-code). Код вводится здесь же — в /api/profile/phone/confirm.
  router.post('/api/profile/phone', (ctx): Result => {
    const user = requireUser(ctx);
    ctx.limit('code', ctx.ip);
    const input = Input.body(ctx.body);
    const phone = input.phone('phone');
    input.done();

    // Код создается, но никуда не отправляется: он только отмечает запрос. Администратор выдаст новый.
    issueContactCode(ctx, user.id, 'verify_phone', 'phone', phone);
    return {
      status: 202,
      body: {
        requested: phone,
        delivery: 'studio',
        message: 'Позвоните в студию: администратор убедится, что это вы, и продиктует код подтверждения нового номера',
      },
    };
  });

  router.post('/api/profile/phone/confirm', (ctx): Result => {
    const user = requireUser(ctx);
    const input = Input.body(ctx.body);
    const code = readCode(input);
    input.done();
    confirmContact(ctx, user.id, 'verify_phone', 'phone', code);
    return { status: 200, body: { user: selfView(ctx.db, user.id) } };
  });

  // Удаление аккаунта (CAB-10, сценарий 17, решение 20) — обезличивание: предстоящие записи отменяются,
  // имя, контакты, пароль, карточка, заметки и уведомления стираются, неопубликованные фото визитов удаляются.
  // Прошедшие визиты остаются в истории студии без связи с человеком.
  router.delete('/api/profile', (ctx): Result => {
    const user = requireRole(ctx, 'client');
    const input = Input.body(ctx.body);
    const password = input.field<string>('password', { optional: true }, (raw) =>
      typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? { value: raw } : { error: 'Введите пароль' });
    // Удаление подтверждается паролем. У аккаунта с внешним входом (Яндекс) пароля нет, и требовать его
    // было бы тупиком: отозвать свои данные человек должен иметь возможность всегда (152-ФЗ). Там
    // подтверждение — сама сессия: ее открывает только внешний сервис после проверки владельца ящика.
    const byPassword = passwordHashOf(ctx, user.id) !== null;
    if (byPassword && password === undefined) input.fail('password', 'Введите пароль');
    input.done();
    if (byPassword) requirePassword(ctx, user.id, password!);

    const now = ctx.now.toISOString();
    const files = transaction(ctx.db, () => {
      const upcoming = ctx.db.prepare("SELECT id FROM bookings WHERE client_id = ? AND status = 'active' AND starts_at > ?")
        .all(user.id, now) as { id: number }[];
      // Та же отмена, что по кнопке «Отменить», только без правила 24 часов: клиент отзывает свои данные целиком.
      // Внутри этой транзакции cancelBooking работает в точке сохранения (SAVEPOINT).
      for (const { id } of upcoming) {
        cancelBooking(ctx.db, user, id, { reason: 'Клиент удалил аккаунт' }, ctx.now, { accountDeletion: true });
      }
      // Комментарии к записям пишет сам клиент — в них могут быть его данные.
      ctx.db.prepare('UPDATE bookings SET comment = NULL WHERE client_id = ? AND comment IS NOT NULL').run(user.id);

      const photos = ctx.db.prepare(`
        SELECT p.id, p.file_path FROM work_photos p
        JOIN booking_items bi ON bi.id = p.booking_item_id JOIN bookings b ON b.id = bi.booking_id
        WHERE b.client_id = ? AND p.is_published = 0
      `).all(user.id) as { id: number; file_path: string }[];
      for (const p of photos) ctx.db.prepare('DELETE FROM work_photos WHERE id = ?').run(p.id);

      // В тексте уведомления есть время визита клиента — оно стирается вместе с остальными его данными
      ctx.db.prepare('DELETE FROM notifications WHERE user_id = ?').run(user.id);
      ctx.db.prepare('DELETE FROM client_notes WHERE client_id = ?').run(user.id);
      // Фото клиента — его персональные данные: удаляется вместе с карточкой (152-ФЗ, сценарий 17)
      const ownPhoto = clientPhotoPath(ctx, user.id);
      ctx.db.prepare('DELETE FROM client_profiles WHERE user_id = ?').run(user.id);
      ctx.db.prepare('DELETE FROM auth_codes WHERE user_id = ?').run(user.id);
      ctx.db.prepare('DELETE FROM slot_holds WHERE owner_id = ?').run(user.id);
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      ctx.db.prepare(`
        UPDATE users SET name = ?, phone = NULL, email = NULL, password_hash = NULL, provider = NULL, provider_id = NULL,
                         phone_verified_at = NULL,
                         email_verified_at = NULL, pd_consent_at = NULL, pd_consent_version = NULL, marketing_consent_at = NULL,
                         failed_login_attempts = 0, locked_until = NULL, deleted_at = ?, updated_at = ?
        WHERE id = ?
      `).run(DELETED_CLIENT_NAME, now, now, user.id);
      return [...photos.map((p) => p.file_path), ...(ownPhoto === null ? [] : [ownPhoto])];
    });
    // Файлы удаляются после фиксации: если транзакция откатится, строки и файлы останутся согласованными.
    for (const file of files) deletePhotoFile(ctx.services.uploadsDir, file);
    ctx.setCookie(clearSessionCookie(ctx.services.secureCookies));
    return { status: 204 };
  });
}

/** Отправка кода: сбой почты — 503, а не «что-то пошло не так». */
async function deliver(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error('Не удалось отправить код подтверждения:', error);
    throw new HttpError(503, 'DELIVERY_FAILED', 'Не удалось отправить код. Попробуйте через несколько минут');
  }
}

/** Новый код на контакт: адрес не занят другим пользователем, код не чаще раза в минуту. */
function issueContactCode(ctx: Context, userId: number, purpose: CodePurpose, field: 'email' | 'phone', value: string): string {
  return transaction(ctx.db, () => {
    const owner = ctx.db.prepare(`SELECT id, password_hash FROM users WHERE ${field} = ?`).get(value) as { id: number; password_hash: string | null } | undefined;
    if (owner && owner.id !== userId) {
      throw conflict(field === 'email' ? 'EMAIL_TAKEN' : 'PHONE_TAKEN', field === 'email'
        ? 'Этот e-mail уже используется другим аккаунтом'
        : owner.password_hash === null
          ? 'Этот номер уже есть в базе студии: вас записывали по телефону. Обратитесь к администратору студии'
          : 'Этот телефон уже используется другим аккаунтом');
    }
    const last = lastCodeAt(ctx.db, userId, purpose);
    if (last !== null && ctx.now.getTime() - last < RESEND_INTERVAL_MS) {
      const retryAfter = Math.ceil((last + RESEND_INTERVAL_MS - ctx.now.getTime()) / 1000);
      throw new HttpError(429, 'CODE_RECENTLY_SENT', 'Код уже отправлен. Запросить новый можно через минуту', undefined, { 'Retry-After': String(retryAfter) });
    }
    return issueCode(ctx.db, userId, purpose, value, ctx.now);
  });
}

/** Проверяет код и записывает подтвержденный контакт в профиль. */
function confirmContact(ctx: Context, userId: number, purpose: CodePurpose, field: 'email' | 'phone', code: string): void {
  // Неверная попытка должна сохраниться, поэтому проверка кода и запись контакта — разные транзакции.
  const check = transaction(ctx.db, () => consumeCode(ctx.db, userId, purpose, code, ctx.now));
  if (!check.ok) {
    throw badRequest('INVALID_CODE', check.reason === 'wrong' ? 'Неверный код' : 'Код недействителен или устарел. Запросите новый',
      check.reason === 'wrong' ? { attemptsLeft: check.attemptsLeft } : undefined);
  }
  const now = ctx.now.toISOString();
  transaction(ctx.db, () => {
    // Пока пользователь вводил код, адрес мог занять другой аккаунт.
    const owner = ctx.db.prepare(`SELECT id FROM users WHERE ${field} = ? AND id <> ?`).get(check.target, userId);
    if (owner) throw conflict(field === 'email' ? 'EMAIL_TAKEN' : 'PHONE_TAKEN', 'Этот адрес уже используется другим аккаунтом');
    ctx.db.prepare(`UPDATE users SET ${field} = ?, ${field}_verified_at = ?, updated_at = ? WHERE id = ?`)
      .run(check.target, now, now, userId);
  });
}

