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

/** Запрос с готовым телом: отсюда идут и JSON-запросы, и загрузка файла. */
async function send(method, url, init) {
  let response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', ...init });
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

function request(method, url, body) {
  return send(method, url, {
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Загрузка изображения: в теле запроса — сам файл, параметры — в адресе.
 * Так сервер обходится без разбора multipart (server/src/api/photos.ts).
 * @param {string} url
 * @param {File} file
 */
function requestFile(url, file) {
  return send('POST', url, {
    headers: { Accept: 'application/json', 'Content-Type': file.type },
    body: file,
  });
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
 * Профиль мастера (PUB-05): `{ master }` — уровень, специализация, опыт, рассказ и услуги
 * с ценой уже по его уровню (`services[].priceKop`). 404 — такого мастера нет или он отключен.
 * @param {number} id
 */
export const getMaster = (id) => request('GET', `/api/masters/${encodeURIComponent(String(id))}`);

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
 * Вход через Яндекс: в теле только одноразовый код с адреса возврата. E-mail и имя сервер забирает
 * у Яндекса сам по этому коду (server/src/auth/yandex.ts), поэтому в запросе их нет и быть не должно. 201 — аккаунт создан, 200 — вход в существующий; оба раза сервер
 * ставит свою cookie сессии, как при входе по паролю. 503 YANDEX_LOGIN_UNAVAILABLE — вход через Яндекс
 * не подключен; 403 STAFF_PASSWORD_LOGIN_ONLY — это учетная запись сотрудника, ей нужен пароль;
 * 403 ACCOUNT_BLOCKED — доступ закрыт студией.
 * @returns {Promise<{ user: object, provider: string, registered: boolean }>}
 */
export const loginWithYandex = (body) => request('POST', '/api/auth/yandex', body);

/**
 * Куда отправить человека на страницу согласия Яндекса: `{ url, state }`. Секрета приложения в адресе
 * нет, строку `state` страница запоминает и сверяет, когда Яндекс вернет человека обратно.
 * 503 `YANDEX_LOGIN_UNAVAILABLE` — вход через Яндекс не настроен.
 */
export const startYandexLogin = () => request('GET', '/api/auth/yandex/start');

/**
 * Регистрация клиента. 201 — { user } и вход выполнен; 202 — номер уже в карточке клиента, нужен код
 * (сценарий 16): тогда тот же запрос повторяется с `code`. 409 PHONE_TAKEN / EMAIL_TAKEN.
 * @param {{ name: string, phone?: string, email?: string, password: string, pdConsent: true,
 *           marketingConsent: boolean, code?: string }} body
 * У ответа 202 с `delivery: 'email'` есть `sent`: ушло ли письмо именно сейчас. Внутри минуты после
 * прошлого запроса новый код не создается и письмо не уходит (`sent: false`, `retryAfterSec` — сколько
 * ждать), а прежний код еще действует. Обещать письмо в этом случае нельзя.
 * @returns {Promise<{ status: 201, user: object, linkedExistingClient?: boolean }
 *                 | { status: 202, delivery: 'email' | 'studio', sentTo?: string, sent?: boolean,
 *                     retryAfterSec?: number, expiresInMin: number }>}
 */
export async function register(body) {
  const data = await request('POST', '/api/auth/register', body);
  return data.status === 'phone_verification_required' ? { ...data, status: 202 } : { ...data, status: 201 };
}

/**
 * Ссылка для нового пароля на e-mail аккаунта. Ответ всегда одинаковый (202), есть такой аккаунт или нет.
 * Исключение — аккаунт без пароля: ответ 200 с `provider: 'yandex'`, письма нет, в такой аккаунт входят
 * кнопкой «Войти с Яндекс ID».
 * @param {{ login: string }} body
 * @returns {Promise<{ message: string, provider?: string }>}
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
 * Новый недельный график мастера с даты (A-22p): прежний закрывается днем накануне, новая запись
 * графика не создается у каждого дня отдельно. `dryRun: true` — только предпросмотр, график не сохраняется.
 * В ответе `master` и `affectedBookings` — действующие записи с этой даты, которые в новый график не попадают.
 * 400 `DATE_IN_PAST` — дата раньше сегодняшнего дня студии.
 * @param {number} id
 * @param {{ validFrom: string, days: { weekday: number, start: string, end: string }[], dryRun?: boolean }} body
 */
export const setMasterSchedule = (id, body) => request('PUT', adminPath('/api/admin/masters', id) + '/schedule', body);

/** Настройки студии и режим работы по дням недели (A-26). */
export const getAdminSettings = () => request('GET', '/api/admin/settings');

/**
 * Изменить настройки студии: передаются только те поля, которые меняются.
 * @param {{ studioName?: string, address?: string, phone?: string, mapUrl?: string | null, vkUrl?: string | null,
 *           telegramUrl?: string | null, timezone?: string, slotStepMin?: number, bookingHorizonDays?: number,
 *           minLeadMin?: number, clientChangeDeadlineHours?: number, slotHoldMin?: number, isMaintenance?: boolean }} body
 */
export const updateAdminSettings = (body) => request('PATCH', '/api/admin/settings', body);

/**
 * Режим работы студии по дням недели: дня нет в списке — студия в этот день закрыта.
 * `dryRun: true` — только предпросмотр: в ответе `affectedBookings` — предстоящие записи вне нового режима.
 * @param {{ days: { weekday: number, open: string, close: string }[], dryRun?: boolean }} body
 */
export const setStudioHours = (body) => request('PUT', '/api/admin/studio-hours', body);

/**
 * Особые дни студии с автором: закрытые дни, особые часы и дополнительные рабочие дни (A-20d).
 * По умолчанию — от сегодня на горизонт записи.
 * @param {{ from?: string, to?: string }} [range]
 */
export function getAdminStudioDays(range = {}) {
  const query = new URLSearchParams();
  if (range.from) query.set('from', range.from);
  if (range.to) query.set('to', range.to);
  const qs = query.toString();
  return request('GET', '/api/admin/studio-days' + (qs ? '?' + qs : ''));
}

/**
 * Особый день студии: `isOpen: false` — закрыта весь день, `isOpen: true` с часами — особые часы.
 * Действует на всех мастеров и важнее их графика. `dryRun: true` — предпросмотр задетых записей.
 * 400 `DATE_IN_PAST` — прошедший день изменить нельзя.
 * @param {string} date дата студии, ГГГГ-ММ-ДД
 * @param {{ isOpen: boolean, open?: string, close?: string, reason: string, dryRun?: boolean }} body
 */
export const setStudioDay = (date, body) => request('PUT', `/api/admin/studio-days/${encodeURIComponent(date)}`, body);

/** Убрать особый день: студия снова работает по обычному режиму. В ответе — задетые записи. */
export const deleteStudioDay = (date) => request('DELETE', `/api/admin/studio-days/${encodeURIComponent(date)}`);

// ---------- Раздел администратора: записи, блокировки времени ----------

/**
 * Записи студии за период и с фильтрами. Ответ: `{ timezone, total, limit, offset, bookings }`.
 * У каждой записи — клиент с контактами, мастер, услуги, статус, `cancellation` (кто и почему отменил),
 * `isOverbooking` (наложение), `busyUntil` (конец уборки), `version`.
 * @param {{ dateFrom?: string, dateTo?: string, masterId?: number, serviceId?: number, clientId?: number,
 *   status?: string, limit?: number, offset?: number }} [filter] даты — по календарю студии (YYYY-MM-DD)
 */
export function getAdminBookings(filter = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined) query.set(key, String(value));
  const qs = query.toString();
  return request('GET', '/api/admin/bookings' + (qs ? '?' + qs : ''));
}

/**
 * Запись за клиента: `clientId` — клиент из базы, `newClient` — новый по имени и телефону.
 * `isOverbooking: true` — осознанное наложение поверх записи другого клиента или блокировки мастера:
 * рабочее время и чужие брони им не перекрываются. 201 — запись; 409 SLOT_TAKEN с `details.alternatives`;
 * 409 PHONE_TAKEN (`details.clientId`); 400 CLIENT_NOT_FOUND / MASTER_INACTIVE / MASTER_CANNOT_DO_SERVICE.
 * @param {{ masterId: number, startsAt: string, services: { serviceId: number, quantity?: number }[],
 *   comment?: string | null, clientId?: number, newClient?: { name: string, phone: string }, isOverbooking?: boolean }} body
 */
export async function createAdminBooking(body) {
  return (await request('POST', '/api/bookings', body)).booking;
}

/**
 * Перенос той же записи администратором: без брони и без правила 24 часов. Старое и новое время, мастер
 * и суммы попадают в историю записи. `isOverbooking: true` — перенос поверх занятого времени.
 * 200 — запись; 409 SLOT_TAKEN / VERSION_CONFLICT / BOOKING_NOT_ACTIVE; 400 NOTHING_TO_CHANGE.
 * @param {number} id
 * @param {{ startsAt: string, masterId?: number, reason: string | null, version: number, isOverbooking?: boolean }} body
 */
export async function rescheduleAdminBooking(id, body) {
  return (await request('POST', `/api/bookings/${encodeURIComponent(String(id))}/reschedule`, body)).booking;
}

/**
 * Отмена записи администратором: `by` — кто отменил («studio» или «client»), `reason` — причина.
 * Строка записи остается в истории со статусом отмены, время мастера освобождается сразу.
 * @param {number} id
 * @param {{ reason: string | null, by: 'client' | 'studio', version: number }} body
 */
export async function cancelAdminBooking(id, body) {
  return (await request('POST', `/api/bookings/${encodeURIComponent(String(id))}/cancel`, body)).booking;
}

/**
 * Итог визита: `completed` — «Визит завершен», `no_show` — «Клиент не пришел». Только для начавшегося визита
 * (иначе 409 VISIT_NOT_STARTED); отмененную запись отметить нельзя (409 BOOKING_NOT_ACTIVE).
 * @param {number} id
 * @param {{ status: 'completed' | 'no_show', reason?: string | null, version: number }} body
 */
export async function setBookingResult(id, body) {
  return (await request('POST', `/api/bookings/${encodeURIComponent(String(id))}/status`, body)).booking;
}

/**
 * Блокировки времени мастеров за период: `{ timeBlocks }` — `id`, `masterId`, `type`, `startsAt`, `endsAt`, `comment`.
 * @param {{ from?: string, to?: string, masterId?: number }} [filter] даты студии
 */
export async function getTimeBlocks(filter = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined) query.set(key, String(value));
  const qs = query.toString();
  return (await request('GET', '/api/admin/time-blocks' + (qs ? '?' + qs : ''))).timeBlocks;
}

/**
 * Блокировка времени мастера: обед, личное время, выходной, отпуск, больничный. Слоты на это время
 * пропадают у клиентов сразу. В ответе `affectedBookings` — действующие записи под блокировкой:
 * база их не трогает, администратор переносит или отменяет их сам. `dryRun: true` — только показать их.
 * @param {{ masterId: number, type: 'lunch' | 'personal' | 'day_off' | 'vacation' | 'sick_leave' | 'other',
 *   startsAt: string, endsAt: string, comment?: string | null, dryRun?: boolean }} body
 */
export const createTimeBlock = (body) => request('POST', '/api/admin/time-blocks', body);

/** Снять блокировку: 204, время снова свободно. */
export const deleteTimeBlock = (id) => request('DELETE', `/api/admin/time-blocks/${encodeURIComponent(String(id))}`);

/** Клиенты студии для поиска при записи: `{ total, clients }` — имя, телефон, метки, черный список. */
export async function findAdminClients(search, limit = 8) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (search) query.set('search', search);
  return (await request('GET', '/api/admin/clients?' + query.toString())).clients;
}

// ---------- Клиентская база и доступ к учетным записям ----------

/**
 * Клиенты студии (A-07): `{ total, limit, offset, clients }`. У клиента — `name`, `phone`, `email`,
 * `hasAccount`, `visits` (завершенные визиты), `lastVisit`, `totalSpentKop`, `favoriteMaster`,
 * `tags` (`new`, `regular`, `lapsed`), `isBlacklisted`, `isBlocked` (доступ закрыт администратором).
 * @param {{ search?: string, filter?: 'new' | 'regular' | 'lapsed' | 'blacklist',
 *   sort?: 'name' | 'lastVisit' | 'visits', limit?: number, offset?: number }} [params]
 */
export function getAdminClients(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const qs = query.toString();
  return request('GET', '/api/admin/clients' + (qs ? '?' + qs : ''));
}

/**
 * Карточка клиента (A-09): контакты и подтверждены ли они, `profile` (дата рождения, источник, «Важно»),
 * `blacklist` (причина, дата, автор), `stats` (визиты, отмены, неявки, первый и последний визит, средний чек),
 * `bookings` — все записи клиента, `notes` — заметки, у заметки со слов мастера заполнен `master`.
 * 404 — такого клиента нет.
 * @param {number} id
 */
export async function getAdminClient(id) {
  return (await request('GET', adminPath('/api/admin/clients', id))).client;
}

/**
 * Новый клиент без учетной записи (A-02, сценарий 16): имя и телефон, e-mail по желанию.
 * 409 PHONE_TAKEN — такой номер уже есть.
 * @param {{ name: string, phone?: string, email?: string }} body
 */
export async function createAdminClient(body) {
  return (await request('POST', '/api/admin/clients', body)).client;
}

/**
 * Изменить карточку: `name`, `phone`, `email`, `birthDate`, `acquisitionSource`, `importantNote`.
 * Новый контакт считается неподтвержденным. В ответе — обновленная карточка.
 * @param {number} id
 * @param {Record<string, unknown>} body только измененные поля
 */
export async function updateAdminClient(id, body) {
  return (await request('PATCH', adminPath('/api/admin/clients', id), body)).client;
}

/**
 * Внести в черный список. `reason` обязательна — ее видит администратор в карточке.
 * @param {number} id
 * @param {string} reason
 */
export async function blacklistClient(id, reason) {
  return (await request('PUT', adminPath('/api/admin/clients', id) + '/blacklist', { reason })).client;
}

/** Убрать из черного списка. */
export async function unblacklistClient(id) {
  return (await request('DELETE', adminPath('/api/admin/clients', id) + '/blacklist')).client;
}

/**
 * Заметка о клиенте. `masterId` — заметка «со слов мастера»: вносит ее все равно администратор.
 * @param {number} id
 * @param {{ text: string, masterId?: number }} body
 */
export const addClientNote = (id, body) => request('POST', adminPath('/api/admin/clients', id) + '/notes', body);

/** Удалить заметку: 204. */
export const deleteClientNote = (id, noteId) =>
  request('DELETE', `${adminPath('/api/admin/clients', id)}/notes/${encodeURIComponent(String(noteId))}`);

/**
 * Закрыть доступ учетной записи (паспорт, функция 1 администратора): все ее сессии закрываются сразу,
 * бронь времени снимается, записи и история остаются. 403 — свою учетную запись закрыть нельзя;
 * 404 — такой учетной записи нет.
 * @param {number} userId номер пользователя, а не клиента в карточке: у мастера это `account.userId`
 */
export const blockUser = (userId) => request('PUT', adminPath('/api/admin/users', userId) + '/block');

/** Открыть доступ обратно: 200. Прежние сессии не возвращаются — человек входит заново. */
export const unblockUser = (userId) => request('DELETE', adminPath('/api/admin/users', userId) + '/block');

// ---------- Фото работ (паспорт, функция 8 администратора) ----------

/** Сколько байт принимает сервер в одном фото — столько же проверяет MAX_PHOTO_BYTES. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Какие типы принимает сервер (PHOTO_TYPES в server/src/storage/photos.ts). */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Все фото, включая неопубликованные: `url`, `title`, `isPublished`, `publishConsentAt`,
 * `bookingId`, `bookingItemId`, `master`, `service`, `createdAt`. Файл — по `url`
 * (`GET /api/photos/:id/file`): неопубликованное отдается только администратору.
 * @param {{ masterId?: number, bookingId?: number, clientId?: number, published?: boolean }} [filters]
 */
export async function getAdminPhotos(filters = {}) {
  const query = new URLSearchParams();
  if (filters.masterId !== undefined) query.set('masterId', String(filters.masterId));
  if (filters.bookingId !== undefined) query.set('bookingId', String(filters.bookingId));
  if (filters.clientId !== undefined) query.set('clientId', String(filters.clientId));
  if (filters.published !== undefined) query.set('published', String(filters.published));
  const qs = query.toString();
  return (await request('GET', '/api/admin/photos' + (qs ? '?' + qs : ''))).photos;
}

/**
 * Загрузить фото: прямо в галерею (`masterId`, при желании `serviceId`) или к услуге завершенного
 * визита (`bookingItemId`). Одно из двух обязательно, вместе они не передаются.
 * Отказы: 413 — файл больше 10 МБ; 415 NOT_AN_IMAGE; 409 VISIT_NOT_COMPLETED — визит не завершен.
 * Загруженное фото в галерее еще не показывается: публикует его updatePhoto.
 * @param {File} file
 * @param {{ masterId?: number, serviceId?: number, bookingItemId?: number, title?: string }} target
 */
export async function uploadPhoto(file, target) {
  const query = new URLSearchParams();
  if (target.bookingItemId !== undefined) query.set('bookingItemId', String(target.bookingItemId));
  if (target.masterId !== undefined) query.set('masterId', String(target.masterId));
  if (target.serviceId !== undefined) query.set('serviceId', String(target.serviceId));
  if (target.title) query.set('title', target.title);
  return (await requestFile('/api/admin/photos?' + query.toString(), file)).photo;
}

/**
 * Подпись, публикация в галерее, согласие клиента и порядок. Снятое согласие снимает и публикацию.
 * Отказы: 409 CONSENT_REQUIRED — фото с визита без согласия клиента публиковать нельзя;
 * 400 CONSENT_NOT_APPLICABLE — у фото галереи согласия не бывает.
 * @param {number} id
 * @param {{ title?: string | null, isPublished?: boolean, publishConsent?: boolean, sortOrder?: number }} body
 */
export async function updatePhoto(id, body) {
  return (await request('PATCH', adminPath('/api/admin/photos', id), body)).photo;
}

/** Удалить фото вместе с файлом: 204. Это не история записей, фото удаляются по-настоящему. */
export const deletePhoto = (id) => request('DELETE', adminPath('/api/admin/photos', id));

// ---------- Уведомления клиента в кабинете ----------

/**
 * Свои уведомления и число непрочитанных одним ответом: `{ unreadCount, notifications }`.
 * У уведомления — `id`, `type` (`booking_cancelled`, `booking_rescheduled`, `booking_overbooked`),
 * готовый `text`, `bookingId` (по нему открывается карточка записи), `isRead`, `createdAt`.
 * Отдельного запроса ради счетчика не нужно.
 * @param {{ unread?: boolean, limit?: number }} [filter] `unread: true` — только непрочитанные
 */
export function getNotifications(filter = {}) {
  const query = new URLSearchParams();
  if (filter.unread) query.set('unread', 'true');
  if (filter.limit !== undefined) query.set('limit', String(filter.limit));
  const qs = query.toString();
  return request('GET', '/api/notifications' + (qs ? '?' + qs : ''));
}

/** Отметить уведомление прочитанным. Ответ — новый `{ unreadCount }`. 404 — чужое или несуществующее. */
export const markNotificationRead = (id) =>
  request('POST', `/api/notifications/${encodeURIComponent(String(id))}/read`);

// ---------- Раздел мастера: свое расписание и свои заявки ----------

/**
 * Свое расписание мастера на период (до 31 дня, по умолчанию неделя): по дням — рабочее окно или причина
 * закрытого дня, записи (время, услуги, комментарий, имя клиента и его «Важно») и блокировки.
 * Цен и контактов клиентов мастеру не отдают. 403 MASTER_NOT_LINKED — учетная запись не связана с профилем.
 * @param {{ from?: string, to?: string }} [range] даты студии
 */
export function getMasterSchedule(range = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(range)) if (value !== undefined) query.set(key, String(value));
  const qs = query.toString();
  return request('GET', '/api/master/schedule' + (qs ? '?' + qs : ''));
}

/** Свои заявки мастера, новые сверху: тип, период или график, состояние и решение администратора. */
export async function getMyRequests() {
  return (await request('GET', '/api/master/requests')).requests;
}

/**
 * Новая заявка. Отпуск, отгул и больничный — `{ type, startsOn, endsOn }`; новый график —
 * `{ type: 'schedule', validFrom, days: [{ weekday, start, end }] }`; свободная просьба — `{ type: 'other', comment }`.
 * 400 DATE_IN_PAST — дата уже прошла; 400 VALIDATION_ERROR — ошибки полей.
 */
export async function createMyRequest(body) {
  return (await request('POST', '/api/master/requests', body)).request;
}

/** Отозвать свою заявку, пока она на рассмотрении. 409 REQUEST_ALREADY_DECIDED — ее уже рассмотрели. */
export async function cancelMyRequest(id) {
  return (await request('POST', `/api/master/requests/${encodeURIComponent(String(id))}/cancel`)).request;
}

// ---------- Заявки мастеров у администратора ----------

/** Все заявки и число новых одним ответом: `{ pendingCount, requests }`. `status` — фильтр по состоянию. */
export function getRequests(filter = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) query.set(key, String(value));
  const qs = query.toString();
  return request('GET', '/api/admin/requests' + (qs ? '?' + qs : ''));
}

/** Записи, которые заденет одобрение заявки: их показывают до нажатия «Одобрить». */
export async function getRequestAffected(id) {
  return (await request('GET', `/api/admin/requests/${encodeURIComponent(String(id))}/affected`)).affectedBookings;
}

/**
 * Одобрить заявку: отпуск, отгул и больничный станут блокировкой времени, график — новым недельным графиком.
 * В ответе `affectedBookings` — записи, которые не помещаются в изменение: база их не трогает.
 * `dryRun: true` — только показать их, ничего не меняя. 409 REQUEST_ALREADY_DECIDED.
 */
export const approveRequest = (id, body = {}) =>
  request('POST', `/api/admin/requests/${encodeURIComponent(String(id))}/approve`, body);

/** Отклонить заявку с причиной — мастер увидит ее в своих заявках. Расписание не меняется. */
export const rejectRequest = (id, body) =>
  request('POST', `/api/admin/requests/${encodeURIComponent(String(id))}/reject`, body);
