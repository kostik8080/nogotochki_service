// Клиентская база (паспорт, функция 9 администратора; экраны A-07, A-08, A-09, A-11): список с поиском
// и метками, карточка клиента со статистикой, историей визитов, фото и заметками, черный список.
// Метки, статистика и «любимый мастер» не хранятся, а считаются по записям при запросе (решение 19).
// Здесь же — закрытие доступа учетной записи (функция 1 администратора).
import { CODE_TTL_MIN, issueCode, pendingTarget } from '../auth/codes.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { type Db, transaction } from '../db/connection.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { pathId, type Context, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { zonedDate } from '../lib/studio-time.js';
import { readSettings } from '../studio/settings.js';
import { requireRole } from './guards.js';
import { bookingViews } from './views.js';

/**
 * Пороги меток. В паспорте и прототипе их нет (в прототипе метки — готовые моковые данные),
 * поэтому они заданы здесь и описаны в docs/api.md; поменять — одна строка.
 */
export const TAG_RULES = {
  /** «Давно не приходил»: последний завершенный визит раньше, чем столько дней назад. */
  lapsedAfterDays: 90,
  /** «Постоянный»: не меньше стольких завершенных визитов (и последний — не давно). */
  regularFromVisits: 5,
};

type Tag = 'new' | 'regular' | 'lapsed';

interface ClientRow {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  has_account: number;
  blocked_at: string | null;
  created_at: string;
  blacklisted_at: string | null;
  visits: number;
  first_visit: string | null;
  last_visit: string | null;
  total_spent_kop: number;
  favorite_master_id: number | null;
  favorite_master_name: string | null;
}

/** Одна метка на клиента: новый (0–1 визит), давно не приходил, постоянный — или никакой. */
function tagOf(c: Pick<ClientRow, 'visits' | 'last_visit'>, now: Date): Tag | null {
  const lapsed = c.last_visit !== null && now.getTime() - Date.parse(c.last_visit) > TAG_RULES.lapsedAfterDays * 86_400_000;
  if (lapsed) return 'lapsed';
  if (c.visits <= 1) return 'new';
  if (c.visits >= TAG_RULES.regularFromVisits) return 'regular';
  return null;
}

/** Клиенты со статистикой по завершенным визитам. Удаленные аккаунты в базу клиентов не попадают. */
function loadClients(db: Db, clientId?: number): ClientRow[] {
  return db.prepare(`
    SELECT u.id, u.name, u.phone, u.email, u.password_hash IS NOT NULL AS has_account, u.blocked_at, u.created_at,
           cp.blacklisted_at,
           count(b.id) AS visits, min(b.starts_at) AS first_visit, max(b.starts_at) AS last_visit,
           coalesce(sum((SELECT sum(price_kop) FROM booking_items WHERE booking_id = b.id)), 0) AS total_spent_kop,
           (SELECT b2.master_id FROM bookings b2 WHERE b2.client_id = u.id AND b2.status = 'completed'
            GROUP BY b2.master_id ORDER BY count(*) DESC, max(b2.starts_at) DESC LIMIT 1) AS favorite_master_id,
           (SELECT m.name FROM masters m WHERE m.id = (SELECT b3.master_id FROM bookings b3 WHERE b3.client_id = u.id AND b3.status = 'completed'
            GROUP BY b3.master_id ORDER BY count(*) DESC, max(b3.starts_at) DESC LIMIT 1)) AS favorite_master_name
    FROM users u
    LEFT JOIN client_profiles cp ON cp.user_id = u.id
    LEFT JOIN bookings b ON b.client_id = u.id AND b.status = 'completed'
    WHERE u.role = 'client' AND u.deleted_at IS NULL AND (@id IS NULL OR u.id = @id)
    GROUP BY u.id
  `).all({ id: clientId ?? null }) as unknown as ClientRow[];
}

function listView(c: ClientRow, now: Date) {
  const tag = tagOf(c, now);
  return {
    id: c.id, name: c.name, phone: c.phone, email: c.email, hasAccount: c.has_account === 1,
    visits: c.visits, lastVisit: c.last_visit, totalSpentKop: c.total_spent_kop,
    favoriteMaster: c.favorite_master_id === null ? null : { id: c.favorite_master_id, name: c.favorite_master_name },
    tags: tag ? [tag] : [], isBlacklisted: c.blacklisted_at !== null, isBlocked: c.blocked_at !== null,
  };
}

function requireClient(db: Db, id: number): void {
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'client' AND deleted_at IS NULL").get(id)) throw notFound('Клиент не найден');
}

/** Только цифры телефона: поиск «916 555» находит +79165551234. */
const digits = (s: string) => s.replace(/\D/g, '');

/** Карточка клиента (A-09). */
function cardView(ctx: Context, id: number) {
  const [c] = loadClients(ctx.db, id);
  if (!c) throw notFound('Клиент не найден');
  const user = ctx.db.prepare('SELECT phone_verified_at, email_verified_at, marketing_consent_at FROM users WHERE id = ?').get(id) as
    { phone_verified_at: string | null; email_verified_at: string | null; marketing_consent_at: string | null };
  const profile = ctx.db.prepare(`
    SELECT cp.birth_date, cp.acquisition_source, cp.important_note, cp.blacklisted_at, cp.blacklist_reason, cp.blacklisted_by, u.name AS blacklisted_by_name
    FROM client_profiles cp LEFT JOIN users u ON u.id = cp.blacklisted_by WHERE cp.user_id = ?
  `).get(id) as {
    birth_date: string | null; acquisition_source: string | null; important_note: string | null;
    blacklisted_at: string | null; blacklist_reason: string | null; blacklisted_by: number | null; blacklisted_by_name: string | null;
  } | undefined;
  const counts = ctx.db.prepare(`
    SELECT sum(status IN ('cancelled_by_client', 'cancelled_by_studio')) AS cancellations, sum(status = 'no_show') AS no_shows
    FROM bookings WHERE client_id = ?
  `).get(id) as { cancellations: number | null; no_shows: number | null };
  const bookingIds = (ctx.db.prepare('SELECT id FROM bookings WHERE client_id = ? ORDER BY starts_at DESC').all(id) as { id: number }[]).map((r) => r.id);
  const photoCounts = new Map((ctx.db.prepare(`
    SELECT bi.booking_id, count(p.id) AS n FROM work_photos p JOIN booking_items bi ON bi.id = p.booking_item_id
    JOIN bookings b ON b.id = bi.booking_id WHERE b.client_id = ? GROUP BY bi.booking_id
  `).all(id) as { booking_id: number; n: number }[]).map((r) => [r.booking_id, r.n]));
  const notes = ctx.db.prepare(`
    SELECT n.id, n.text, n.created_at, n.author_id, a.name AS author_name, n.master_id, m.name AS master_name
    FROM client_notes n JOIN users a ON a.id = n.author_id LEFT JOIN masters m ON m.id = n.master_id
    WHERE n.client_id = ? ORDER BY n.created_at DESC, n.id DESC
  `).all(id) as { id: number; text: string; created_at: string; author_id: number; author_name: string; master_id: number | null; master_name: string | null }[];

  return {
    ...listView(c, ctx.now),
    phoneVerified: user.phone_verified_at !== null,
    emailVerified: user.email_verified_at !== null,
    marketingConsent: user.marketing_consent_at !== null,
    // Человек запросил подтверждение телефона на сайте и ждет звонка в студию (POST /api/admin/users/:id/phone-code).
    pendingPhoneConfirmation: (() => {
      const pending = pendingTarget(ctx.db, id, 'verify_phone', ctx.now);
      return pending ? { phone: pending.target, requestedAt: pending.requestedAt } : null;
    })(),
    createdAt: c.created_at,
    profile: {
      birthDate: profile?.birth_date ?? null,
      acquisitionSource: profile?.acquisition_source ?? null,
      importantNote: profile?.important_note ?? null,
    },
    blacklist: profile?.blacklisted_at ? {
      at: profile.blacklisted_at, reason: profile.blacklist_reason, by: { id: profile.blacklisted_by, name: profile.blacklisted_by_name },
    } : null,
    stats: {
      visits: c.visits,
      cancellations: counts.cancellations ?? 0,
      noShows: counts.no_shows ?? 0,
      firstVisit: c.first_visit,
      lastVisit: c.last_visit,
      totalSpentKop: c.total_spent_kop,
      averageCheckKop: c.visits > 0 ? Math.round(c.total_spent_kop / c.visits) : null,
    },
    bookings: bookingViews(ctx.db, bookingIds, { viewer: 'admin', now: ctx.now })
      .map((b) => ({ ...b, photoCount: photoCounts.get(b.id) ?? 0 })),
    notes: notes.map((n) => ({
      id: n.id, text: n.text, createdAt: n.created_at, author: { id: n.author_id, name: n.author_name },
      master: n.master_id === null ? null : { id: n.master_id, name: n.master_name },
    })),
  };
}

/** Поля карточки: дата рождения, источник, «Важно». Строка client_profiles появляется при первом заполнении. */
function saveProfile(db: Db, id: number, fields: Record<string, string | number | null>, now: string): void {
  if (Object.keys(fields).length === 0) return;
  db.prepare('INSERT INTO client_profiles (user_id, updated_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING').run(id, now);
  const columns = Object.keys(fields);
  db.prepare(`UPDATE client_profiles SET ${columns.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE user_id = @id`)
    .run({ ...fields, now, id });
}

export function adminClientRoutes(router: Router): void {
  // Список клиентов (A-07): поиск по имени, телефону и e-mail, фильтр по метке и черному списку.
  // Поиск идет на сервере в JavaScript: LIKE в SQLite не учитывает регистр кириллицы, а клиентов у студии — сотни.
  router.get('/api/admin/clients', (ctx): Result => {
    requireRole(ctx, 'admin');
    const input = Input.query(ctx.query);
    const search = input.string('search', { optional: true, max: 100 });
    const filter = input.oneOf('filter', ['new', 'regular', 'lapsed', 'blacklist'] as const, { optional: true });
    const sort = input.oneOf('sort', ['name', 'lastVisit', 'visits'] as const, { optional: true }) ?? 'name';
    const limit = input.int('limit', { optional: true, min: 1, max: 500 }) ?? 50;
    const offset = input.int('offset', { optional: true, min: 0 }) ?? 0;
    input.done();

    const text = search?.toLocaleLowerCase('ru');
    const phoneDigits = search ? digits(search) : '';
    let clients = loadClients(ctx.db).map((c) => listView(c, ctx.now));
    if (text) {
      clients = clients.filter((c) => c.name.toLocaleLowerCase('ru').includes(text)
        || (c.email ?? '').includes(text)
        || (phoneDigits.length >= 3 && digits(c.phone ?? '').includes(phoneDigits)));
    }
    if (filter === 'blacklist') clients = clients.filter((c) => c.isBlacklisted);
    else if (filter) clients = clients.filter((c) => c.tags.includes(filter));
    clients.sort(sort === 'name'
      ? (a, b) => a.name.localeCompare(b.name, 'ru')
      : sort === 'visits' ? (a, b) => b.visits - a.visits : (a, b) => (b.lastVisit ?? '').localeCompare(a.lastVisit ?? ''));
    return { status: 200, body: { total: clients.length, limit, offset, clients: clients.slice(offset, offset + limit) } };
  });

  router.get('/api/admin/clients/:id', (ctx): Result => {
    requireRole(ctx, 'admin');
    return { status: 200, body: { client: cardView(ctx, pathId(ctx)) } };
  });

  // Новый клиент без учетной записи (A-02, сценарий 16): по имени и телефону, e-mail — по желанию.
  router.post('/api/admin/clients', (ctx): Result => {
    requireRole(ctx, 'admin');
    const input = Input.body(ctx.body);
    const name = input.string('name', { max: 100 });
    const phone = input.phone('phone');
    const email = input.email('email', { optional: true });
    input.done();
    const now = ctx.now.toISOString();
    const id = transaction(ctx.db, () => {
      const taken = ctx.db.prepare('SELECT id, role FROM users WHERE phone = ?').get(phone) as { id: number; role: string } | undefined;
      if (taken) throw conflict('PHONE_TAKEN', 'Клиент с этим телефоном уже есть', taken.role === 'client' ? { clientId: taken.id } : undefined);
      if (email && ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw conflict('EMAIL_TAKEN', 'Этот e-mail уже используется');
      return Number(ctx.db.prepare("INSERT INTO users (role, name, phone, email, created_at, updated_at) VALUES ('client', ?, ?, ?, ?, ?)")
        .run(name, phone, email ?? null, now, now).lastInsertRowid);
    });
    return { status: 201, body: { client: cardView(ctx, id) } };
  });

  // Изменение клиента: имя, контакты и поля карточки. Новый телефон или e-mail считается неподтвержденным.
  // Администратор меняет телефон, убедившись, что звонит сама клиентка: SMS-шлюз пока не подключен.
  router.patch('/api/admin/clients/:id', (ctx): Result => {
    requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const name = input.string('name', { optional: true, max: 100 });
    const phone = input.phone('phone', { optional: true, nullable: true });
    const email = input.email('email', { optional: true, nullable: true });
    const birthDate = input.date('birthDate', { optional: true, nullable: true });
    const acquisitionSource = input.string('acquisitionSource', { optional: true, nullable: true, max: 200 });
    const importantNote = input.string('importantNote', { optional: true, nullable: true, max: 1000 });
    input.done();
    if (birthDate && birthDate > zonedDate(ctx.now.getTime(), readSettings(ctx.db).timezone)) {
      throw badRequest('VALIDATION_ERROR', 'Дата рождения в будущем', { fields: [{ field: 'birthDate', message: 'Дата рождения в будущем' }] });
    }

    const now = ctx.now.toISOString();
    transaction(ctx.db, () => {
      requireClient(ctx.db, id);
      const current = ctx.db.prepare('SELECT phone, email FROM users WHERE id = ?').get(id) as { phone: string | null; email: string | null };
      const newPhone = phone === undefined ? current.phone : phone;
      const newEmail = email === undefined ? current.email : email;
      if (!newPhone && !newEmail) throw badRequest('CONTACT_REQUIRED', 'У клиента должен остаться телефон или e-mail');
      if (phone && phone !== current.phone && ctx.db.prepare('SELECT 1 FROM users WHERE phone = ? AND id <> ?').get(phone, id)) {
        throw conflict('PHONE_TAKEN', 'Этот телефон уже у другого клиента');
      }
      if (email && email !== current.email && ctx.db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(email, id)) {
        throw conflict('EMAIL_TAKEN', 'Этот e-mail уже у другого клиента');
      }
      if (name !== undefined) ctx.db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id);
      if (phone !== undefined && phone !== current.phone) {
        ctx.db.prepare('UPDATE users SET phone = ?, phone_verified_at = NULL, updated_at = ? WHERE id = ?').run(phone, now, id);
      }
      if (email !== undefined && email !== current.email) {
        ctx.db.prepare('UPDATE users SET email = ?, email_verified_at = NULL, updated_at = ? WHERE id = ?').run(email, now, id);
      }
      const profile: Record<string, string | number | null> = {};
      if (birthDate !== undefined) profile.birth_date = birthDate;
      if (acquisitionSource !== undefined) profile.acquisition_source = acquisitionSource;
      if (importantNote !== undefined) profile.important_note = importantNote;
      saveProfile(ctx.db, id, profile, now);
    });
    return { status: 200, body: { client: cardView(ctx, id) } };
  });

  // Подтверждение телефона администратором. SMS в сервисе нет, поэтому номер подтверждает администратор:
  // человек звонит в студию, администратор убеждается, что это он, и диктует код. Для чего код:
  //   * сценарий 16 — клиентка, которую записали по телефону, регистрируется на сайте с тем же номером;
  //   * новый телефон в профиле — клиент запросил смену номера (POST /api/profile/phone).
  // Номер берется из последнего запроса человека за сутки, а у карточки без пароля — из самой карточки.
  // Код показывается один раз и действует 15 минут; в базе — только его хеш, прежний код гасится.
  router.post('/api/admin/users/:id/phone-code', (ctx): Result => {
    requireRole(ctx, 'admin');
    const id = pathId(ctx);
    Input.body(ctx.body).done();
    const result = transaction(ctx.db, () => {
      const user = ctx.db.prepare('SELECT phone, password_hash FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as
        { phone: string | null; password_hash: string | null } | undefined;
      if (!user) throw notFound('Учетная запись не найдена');
      const pending = pendingTarget(ctx.db, id, 'verify_phone', ctx.now);
      const phone = pending?.target ?? (user.password_hash === null ? user.phone : null);
      if (!phone) {
        throw conflict('NO_PENDING_REQUEST', 'Подтверждать нечего: человек не запрашивал подтверждение телефона на сайте');
      }
      return {
        code: issueCode(ctx.db, id, 'verify_phone', phone, ctx.now),
        phone,
        purpose: user.password_hash === null ? 'link_account' : 'change_phone',
      };
    });
    return { status: 201, body: { ...result, expiresInMin: CODE_TTL_MIN } };
  });

  // Код для сброса пароля, если в аккаунте нет e-mail и ссылку прислать некуда. Администратор выдает его,
  // убедившись по звонку, что это сам владелец. Код вводится в POST /api/auth/password-reset/confirm
  // вместе с логином; после сброса все сессии закрываются.
  router.post('/api/admin/users/:id/password-reset-code', (ctx): Result => {
    requireRole(ctx, 'admin');
    const id = pathId(ctx);
    Input.body(ctx.body).done();
    const result = transaction(ctx.db, () => {
      const user = ctx.db.prepare('SELECT phone, email, password_hash, blocked_at FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as
        { phone: string | null; email: string | null; password_hash: string | null; blocked_at: string | null } | undefined;
      if (!user) throw notFound('Учетная запись не найдена');
      if (user.password_hash === null) throw conflict('NO_ACCOUNT', 'У клиента нет учетной записи: сбрасывать нечего');
      if (user.blocked_at) throw conflict('ACCOUNT_BLOCKED', 'Доступ к учетной записи закрыт: сначала откройте его');
      const login = user.phone ?? user.email!;
      return { code: issueCode(ctx.db, id, 'reset_password', login, ctx.now), login };
    });
    return { status: 201, body: { ...result, expiresInMin: CODE_TTL_MIN } };
  });

  // Черный список (A-11): причина обязательна, база хранит, кто и когда внес (раздел 5.5).
  router.put('/api/admin/clients/:id/blacklist', (ctx): Result => {
    const user = requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const reason = input.string('reason', { max: 500 });
    input.done();
    const now = ctx.now.toISOString();
    transaction(ctx.db, () => {
      requireClient(ctx.db, id);
      saveProfile(ctx.db, id, { blacklisted_at: now, blacklist_reason: reason, blacklisted_by: user.id }, now);
    });
    return { status: 200, body: { client: cardView(ctx, id) } };
  });

  router.delete('/api/admin/clients/:id/blacklist', (ctx): Result => {
    requireRole(ctx, 'admin');
    const id = pathId(ctx);
    requireClient(ctx.db, id);
    ctx.db.prepare(`
      UPDATE client_profiles SET blacklisted_at = NULL, blacklist_reason = NULL, blacklisted_by = NULL, updated_at = ? WHERE user_id = ?
    `).run(ctx.now.toISOString(), id);
    return { status: 200, body: { client: cardView(ctx, id) } };
  });

  // Заметки о клиенте. masterId — «со слов мастера»: у мастеров нет своего раздела, заметку вносит администратор.
  router.post('/api/admin/clients/:id/notes', (ctx): Result => {
    const user = requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const text = input.string('text', { max: 2000 });
    const masterId = input.id('masterId', { optional: true, nullable: true }) ?? null;
    input.done();
    const noteId = transaction(ctx.db, () => {
      requireClient(ctx.db, id);
      if (masterId !== null && !ctx.db.prepare('SELECT 1 FROM masters WHERE id = ?').get(masterId)) {
        throw badRequest('MASTER_NOT_FOUND', 'Мастер не найден', { masterId });
      }
      return Number(ctx.db.prepare('INSERT INTO client_notes (client_id, author_id, master_id, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, user.id, masterId, text, ctx.now.toISOString()).lastInsertRowid);
    });
    const note = cardView(ctx, id).notes.find((n) => n.id === noteId);
    return { status: 201, body: { note } };
  });

  router.delete('/api/admin/clients/:id/notes/:noteId', (ctx): Result => {
    requireRole(ctx, 'admin');
    const deleted = ctx.db.prepare('DELETE FROM client_notes WHERE id = ? AND client_id = ?').run(pathId(ctx, 'noteId'), pathId(ctx)).changes;
    if (deleted === 0) throw notFound('Заметка не найдена');
    return { status: 204 };
  });

  // Закрыть доступ учетной записи (функция 1 администратора, SYS-04): все сессии закрываются сразу,
  // бронь снимается. Записи и история остаются. Свою учетную запись закрыть нельзя.
  router.put('/api/admin/users/:id/block', (ctx): Result => {
    const user = requireRole(ctx, 'admin');
    const id = pathId(ctx);
    Input.body(ctx.body).done();
    if (id === user.id) throw forbidden('Нельзя закрыть доступ своей учетной записи');
    const now = ctx.now.toISOString();
    transaction(ctx.db, () => {
      const target = ctx.db.prepare('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!target) throw notFound('Учетная запись не найдена');
      ctx.db.prepare('UPDATE users SET blocked_at = coalesce(blocked_at, ?), updated_at = ? WHERE id = ?').run(now, now, id);
      revokeUserSessions(ctx.db, id, ctx.now);
      ctx.db.prepare('DELETE FROM slot_holds WHERE owner_id = ?').run(id);
    });
    return { status: 200, body: { userId: id, blocked: true } };
  });

  router.delete('/api/admin/users/:id/block', (ctx): Result => {
    requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const changed = ctx.db.prepare('UPDATE users SET blocked_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(ctx.now.toISOString(), id).changes;
    if (changed === 0) throw notFound('Учетная запись не найдена');
    return { status: 200, body: { userId: id, blocked: false } };
  });
}
