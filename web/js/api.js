// Все обращения к серверу API (docs/api.md) — только через этот файл (docs/frontend-rules.md, правило 3).
// Запросы идут на /api того же адреса, cookie сессии браузер присылает сам.
// Ошибка превращается в ApiError с кодом и текстом сервера, чтобы страница показала ее человеку.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP-код; 0 — нет соединения
   * @param {string} code постоянный код ошибки API (SLOT_TAKEN, VALIDATION_ERROR…)
   * @param {string} message текст для человека
   * @param {unknown} [details]
   * @param {number | null} [retryAfter] через сколько секунд можно повторить (заголовок Retry-After у 429)
   */
  constructor(status, code, message, details, retryAfter = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }

  /** Ошибки полей формы из ответа 400 VALIDATION_ERROR: [{ field, message }]. */
  get fields() {
    const fields = /** @type {any} */ (this.details)?.fields;
    return Array.isArray(fields) ? fields : [];
  }
}

async function request(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Нет соединения с сервером. Проверьте интернет и попробуйте еще раз.');
  }

  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error;
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN_ERROR',
      error?.message ?? 'Сервер не смог выполнить запрос. Попробуйте позже.',
      error?.details,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  return data;
}

// ---------- Витрина (вход не нужен) ----------

/** Название, адрес, телефон, ссылки, часовой пояс, режим работы, правила записи. */
export const getStudio = () => request('GET', '/api/studio');

/** Каталог: категории с услугами, правила опции, несовместимые пары. */
export const getServices = () => request('GET', '/api/services');

/**
 * Активные мастера. С `services` — только те, кто выполняет все услуги визита, и у каждого `visit`:
 * `{ durationMin, priceKop }` — длительность и стоимость визита у этого мастера (цена зависит от уровня).
 * Неверный набор — 400: SERVICES_INCOMPATIBLE, MAIN_SERVICE_REQUIRED, ADDON_NOT_ALLOWED, QUANTITY_TOO_LARGE.
 * @param {string} [services] услуги визита: «8,3:2» — номера через запятую, количество через двоеточие
 */
export async function getMasters(services) {
  const qs = services ? '?services=' + encodeURIComponent(services) : '';
  return request('GET', '/api/masters' + qs);
}

/**
 * Свободное время мастера на дату студии. Ответ: `{ day: { status, reason }, durationMin, priceKop, slots: [{ startsAt, endsAt }] }`.
 * Для переноса вместо услуг передается `bookingId`: длительность — из записи, сама запись не считается занятым временем;
 * тогда 403 CHANGE_DEADLINE_PASSED / 409 BOOKING_NOT_ACTIVE — перенести уже нельзя.
 * @param {number} masterId
 * @param {{ date: string, services?: string, bookingId?: number }} query дата — YYYY-MM-DD по календарю студии
 */
export function getMasterSlots(masterId, query) {
  const qs = new URLSearchParams({ date: query.date });
  if (query.bookingId !== undefined) qs.set('bookingId', String(query.bookingId));
  else qs.set('services', query.services);
  return request('GET', `/api/masters/${encodeURIComponent(String(masterId))}/slots?${qs}`);
}

/**
 * Опубликованные фото работ.
 * @param {{ masterId?: number, limit?: number }} [options]
 */
export function getGallery(options = {}) {
  const query = new URLSearchParams();
  if (options.masterId !== undefined) query.set('masterId', String(options.masterId));
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const qs = query.toString();
  return request('GET', '/api/gallery' + (qs ? '?' + qs : ''));
}

/**
 * «Любой свободный мастер»: свободное время всех подходящих мастеров на дату.
 * Ответ: `{ durationMin, masters: [{ id, name, level, priceKop }], slots: [{ startsAt, endsAt, masterIds }] }`.
 * @param {{ date: string, services: string }} query
 */
export function getSlots(query) {
  const qs = new URLSearchParams({ date: query.date, services: query.services });
  return request('GET', `/api/slots?${qs}`);
}

/**
 * Особые дни студии: закрытые и сокращенные. `{ days: [{ date, isOpen, open, close, reason }] }`.
 * @param {{ from?: string, to?: string }} [range] по умолчанию — от сегодня на горизонт записи
 */
export function getStudioDays(range = {}) {
  const query = new URLSearchParams();
  if (range.from) query.set('from', range.from);
  if (range.to) query.set('to', range.to);
  const qs = query.toString();
  return request('GET', '/api/studio/days' + (qs ? '?' + qs : ''));
}

// ---------- Бронь времени ----------

/**
 * Закрепить время на 10 минут перед подтверждением (только после входа). `masterId: null` — «Любой мастер»:
 * мастера назначит сервер. Для переноса — `{ bookingId, startsAt, masterId? }` без услуг.
 * 201 — `{ hold: { id, master, startsAt, endsAt, expiresAt, secondsLeft, priceKop, durationMin } }`;
 * 401 — нужен вход; 409 SLOT_TAKEN — `details.alternatives`; 403 CHANGE_DEADLINE_PASSED; 503 MAINTENANCE.
 * @param {{ masterId?: number | null, startsAt: string, services?: { serviceId: number, quantity: number }[], bookingId?: number }} body
 */
export async function createHold(body) {
  return (await request('POST', '/api/holds', body)).hold;
}

/** Действующая бронь пользователя или null (нет или истекла). `{ id, masterId, startsAt, endsAt, bookingId, expiresAt, secondsLeft }` */
export async function getCurrentHold() {
  return (await request('GET', '/api/holds/current')).hold;
}

// ---------- Вход ----------

/** Один запрос на страницу: шапка и сама страница спрашивают «кто вошел» одновременно. */
let mePromise = null;

/** Текущий пользователь или null, если человек не вошел (401). Ответ запоминается до перезагрузки страницы. */
export function getMe() {
  mePromise ??= request('GET', '/api/auth/me').then(
    (data) => data.user,
    (error) => {
      if (error instanceof ApiError && error.status === 401) return null;
      // Сбой сети или сервера не запоминаем: следующий вызов спросит снова
      mePromise = null;
      throw error;
    },
  );
  return mePromise;
}

/** Выход: закрывает сессию и снимает бронь времени. */
export async function logout() {
  await request('POST', '/api/auth/logout');
  mePromise = Promise.resolve(null);
}

// Сессию ставит и снимает сервер cookie с флагом HttpOnly: скрипт страницы ее не видит и никуда не сохраняет.

/**
 * Вход по телефону или e-mail и паролю. 200 — { user }; 401 INVALID_CREDENTIALS; 429 LOGIN_LOCKED; 403 ACCOUNT_BLOCKED.
 * @param {{ login: string, password: string }} body
 */
export const login = (body) => request('POST', '/api/auth/login', body);

/**
 * Регистрация клиента. 201 — { user } и вход выполнен; 202 — номер уже в карточке клиента, нужен код
 * (сценарий 16): тогда тот же запрос повторяется с `code`. 409 PHONE_TAKEN / EMAIL_TAKEN.
 * @param {{ name: string, phone?: string, email?: string, password: string, pdConsent: true,
 *           marketingConsent: boolean, code?: string }} body
 * @returns {Promise<{ status: 201, user: object, linkedExistingClient?: boolean }
 *                 | { status: 202, delivery: 'email' | 'studio', sentTo?: string, expiresInMin: number }>}
 */
export async function register(body) {
  const data = await request('POST', '/api/auth/register', body);
  return data.status === 'phone_verification_required' ? { ...data, status: 202 } : { ...data, status: 201 };
}

/**
 * Ссылка для нового пароля на e-mail аккаунта. Ответ всегда одинаковый (202), есть такой аккаунт или нет.
 * @param {{ login: string }} body
 */
export const requestPasswordReset = (body) => request('POST', '/api/auth/password-reset/request', body);

/**
 * Новый пароль по ссылке из письма. 204 — пароль изменен, все сессии закрыты; 400 INVALID_CODE — ссылка не действует.
 * @param {{ token: string, password: string }} body
 */
export const confirmPasswordReset = (body) => request('POST', '/api/auth/password-reset/confirm', body);

// ---------- Профиль ----------

/**
 * Имя и согласие на новости. 200 — пользователь целиком, как в GET /api/auth/me.
 * @param {{ name?: string, marketingConsent?: boolean }} body
 */
export async function updateProfile(body) {
  const { user } = await request('PATCH', '/api/profile', body);
  mePromise = Promise.resolve(user);
  return user;
}

/**
 * Смена пароля. 204 — пароль изменен, остальные сессии закрыты; 403 WRONG_PASSWORD — неверный текущий пароль.
 * @param {{ currentPassword: string, newPassword: string }} body
 */
export const changePassword = (body) => request('POST', '/api/profile/password', body);

/**
 * Код на новый или неподтвержденный e-mail. 202 — `{ sentTo, expiresInMin }`; 409 EMAIL_TAKEN;
 * 429 CODE_RECENTLY_SENT — не чаще раза в минуту; 503 EMAIL_UNAVAILABLE / DELIVERY_FAILED — почта не работает.
 * @param {{ email: string }} body
 */
export const requestEmailCode = (body) => request('POST', '/api/profile/email', body);

/**
 * Код из письма: адрес записывается в профиль подтвержденным. 200 — пользователь целиком;
 * 400 INVALID_CODE — `details.attemptsLeft`, после трех ошибок и через 15 минут код не действует; 409 EMAIL_TAKEN.
 * @param {{ code: string }} body
 */
export async function confirmEmailCode(body) {
  const { user } = await request('POST', '/api/profile/email/confirm', body);
  mePromise = Promise.resolve(user);
  return user;
}

/**
 * Удалить аккаунт клиента. 204 — предстоящие записи отменены, данные обезличены, сессия закрыта;
 * 403 WRONG_PASSWORD — неверный пароль.
 * @param {{ password: string }} body
 */
export async function deleteAccount(body) {
  await request('DELETE', '/api/profile', body);
  mePromise = Promise.resolve(null);
}

// ---------- Записи клиента ----------

/**
 * Свои записи: предстоящие сверху (ближайшая первой), затем прошедшие и отмененные.
 * У каждой — услуги, мастер, сумма, отмена с причиной, canChange и changeDeadline (правило 24 часов),
 * studioChange — изменение студией, которое клиент еще не закрыл. Без входа — 401.
 * @param {{ period?: 'upcoming' | 'past', status?: string }} [filter]
 */
export async function getBookings(filter = {}) {
  const query = new URLSearchParams();
  if (filter.period) query.set('period', filter.period);
  if (filter.status) query.set('status', filter.status);
  const qs = query.toString();
  return (await request('GET', '/api/bookings' + (qs ? '?' + qs : ''))).bookings;
}

/** Клиент закрыл сообщение «Студия отменила / перенесла запись». */
export const acknowledgeBooking = (id) => request('POST', `/api/bookings/${encodeURIComponent(String(id))}/acknowledge`);

/**
 * Создать запись по действующей брони. 201 — запись целиком; 409 HOLD_EXPIRED / HOLD_NOT_FOUND — бронь истекла или ее нет;
 * 409 HOLD_MISMATCH — бронь на другое время или состав; 409 SLOT_TAKEN — `details.alternatives`; 401 SESSION_EXPIRED; 503 MAINTENANCE.
 * @param {{ masterId: number, startsAt: string, services: { serviceId: number, quantity: number }[], comment: string | null, isAnyMaster: boolean }} body
 */
export async function createBooking(body) {
  return (await request('POST', '/api/bookings', body)).booking;
}

/** Запись клиента целиком. 404 — нет такой, 403 — чужая. */
export async function getBooking(id) {
  return (await request('GET', `/api/bookings/${encodeURIComponent(String(id))}`)).booking;
}

/**
 * Отменить свою запись. 200 — запись; 403 CHANGE_DEADLINE_PASSED — меньше суток до визита (в тексте — телефон студии);
 * 409 BOOKING_NOT_ACTIVE — уже отменена; 409 VERSION_CONFLICT — запись успели изменить.
 * @param {number} id
 * @param {{ reason: string | null, version: number }} body
 */
export async function cancelBooking(id, body) {
  return (await request('POST', `/api/bookings/${encodeURIComponent(String(id))}/cancel`, body)).booking;
}

/**
 * Перенести ту же запись на время, закрепленное бронью с bookingId. 200 — запись; 409 HOLD_EXPIRED / HOLD_NOT_FOUND /
 * HOLD_MISMATCH / SLOT_TAKEN / VERSION_CONFLICT; 403 CHANGE_DEADLINE_PASSED.
 * @param {number} id
 * @param {{ startsAt: string, masterId?: number, reason: string | null, version: number }} body
 */
export async function rescheduleBooking(id, body) {
  return (await request('POST', `/api/bookings/${encodeURIComponent(String(id))}/reschedule`, body)).booking;
}

// ---------- Раздел администратора (/api/admin/*: гостю — 401, клиенту и мастеру — 403) ----------

const adminPath = (base, id) => `${base}/${encodeURIComponent(String(id))}`;

/** Все услуги, включая отключенные, категории и несовместимые пары: `{ categories, services, incompatibilities }`. */
export const getAdminServices = () => request('GET', '/api/admin/services');

/**
 * Новая услуга. 201 — услуга; 400 VALIDATION_ERROR (пустое название, цена или длительность не больше нуля,
 * цена у топ-мастера ниже цены у мастера — в details.fields); 409 SERVICE_NAME_TAKEN.
 * @param {Record<string, unknown>} body
 */
export async function createService(body) {
  return (await request('POST', '/api/admin/services', body)).service;
}

/** Изменить услугу: только переданные поля, `isActive: false` — отключить. Ошибки — как у createService. */
export async function updateService(id, body) {
  return (await request('PATCH', adminPath('/api/admin/services', id), body)).service;
}

/**
 * Удалить услугу. Решает сервер: `{ result: 'deleted' }` — удалена; `{ result: 'deactivated', message, service }` —
 * у услуги есть записи или фото, поэтому она только отключена (в message — объяснение для администратора).
 */
export const deleteService = (id) => request('DELETE', adminPath('/api/admin/services', id));

/** Новая категория услуг в конец списка. 409 CATEGORY_NAME_TAKEN. */
export async function createServiceCategory(body) {
  return (await request('POST', '/api/admin/service-categories', body)).category;
}

/** Все мастера, включая отключенных: уровень, услуги (`serviceIds`), недельный график, учетная запись. */
export async function getAdminMasters() {
  return (await request('GET', '/api/admin/masters')).masters;
}

/** Новый мастер. 201 — `{ master }`; 400 VALIDATION_ERROR. */
export const createMaster = (body) => request('POST', '/api/admin/masters', body);

/**
 * Изменить мастера: только переданные поля; `serviceIds` заменяет список услуг целиком.
 * При отключении в ответе еще `upcomingBookings` — предстоящие записи, которые нужно перенести или отменить.
 */
export const updateMaster = (id, body) => request('PATCH', adminPath('/api/admin/masters', id), body);

/**
 * Удалить мастера. Решает сервер: `{ result: 'deleted' }` — удален; `{ result: 'deactivated', message, master,
 * upcomingBookings }` — у мастера есть записи, фото, заметки или учетная запись, поэтому он только отключен.
 */
export const deleteMaster = (id) => request('DELETE', adminPath('/api/admin/masters', id));

/**
 * Записи студии за период (даты студии включительно). `{ timezone, total, bookings }`.
 * @param {{ dateFrom?: string, dateTo?: string, masterId?: number, status?: string, limit?: number }} [filter]
 */
export function getAdminBookings(filter = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined) query.set(key, String(value));
  const qs = query.toString();
  return request('GET', '/api/admin/bookings' + (qs ? '?' + qs : ''));
}
