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

/** Активные мастера. */
export const getMasters = () => request('GET', '/api/masters');

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
