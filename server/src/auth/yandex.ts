// Вход через Яндекс в один клик (паспорт, функция 1 клиента — дополнение к входу по паролю).
//
// Как это устроено. Браузер уходит на страницу согласия Яндекса (yandexAuthorizeUrl), человек
// соглашается, и Яндекс возвращает его на наш адрес с одноразовым кодом. По этому коду сервер сам,
// без браузера, забирает у Яндекса профиль: адрес почты, имя и фамилию (fetchYandexProfile).
// Дальше сервис работает как при обычном входе: открывает свою серверную сессию (src/auth/sessions.ts)
// и ставит cookie со своим токеном.
//
// Токен Яндекса нигде не сохраняется: он живет внутри одного вызова fetchYandexProfile, нужен ровно
// на один запрос профиля и в сервисе никаких прав не дает. Ни в базу, ни в журнал, ни в ответ API
// он не попадает. Идентификатор и секрет приложения берутся только из переменных окружения
// (YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET) — в коде их нет даже как значений по умолчанию.
import { config } from '../config.js';
import { badRequest, HttpError } from '../http/errors.js';

/** Значение users.provider для Яндекса. Список допустимых значений ограничен и в базе (миграция 009). */
export const YANDEX_PROVIDER = 'yandex';

/** Страница согласия: сюда уходит браузер по кнопке «Войти через Яндекс». */
const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
/** Обмен кода на токен доступа. Запрос делает сервер, секрет приложения браузер не видит. */
const TOKEN_URL = 'https://oauth.yandex.ru/token';
/** Профиль по токену: адрес почты, имя и фамилия. */
const INFO_URL = 'https://login.yandex.ru/info?format=json';
/** Сколько ждать ответа Яндекса: человек стоит перед экраном и ждет вместе с нами. */
const TIMEOUT_MS = 10_000;

/** Что внешний сервис сообщает о человеке. Больше сервису ничего не нужно. */
export interface ExternalProfile {
  /** Номер учетной записи во внешнем сервисе: users.provider_id. */
  providerId: string;
  /** Подтвержденный внешним сервисом адрес, в нижнем регистре — как в users.email. */
  email: string;
  name: string;
}

/** Профиль от внешнего сервиса по одноразовому коду, который Яндекс вернул браузеру. */
export type ExternalLogin = (params: { code?: string }) => Promise<ExternalProfile>;

/** Адрес, на который Яндекс возвращает человека после согласия. Он же записан в настройках приложения. */
export const yandexRedirectUri = (): string => `${config.appUrl}/login.html`;

/** Настроено ли приложение: без идентификатора и секрета вход через Яндекс не работает. */
export const isYandexConfigured = (): boolean => Boolean(config.yandex.clientId && config.yandex.clientSecret);

const notConfigured = () => new HttpError(503, 'YANDEX_LOGIN_UNAVAILABLE',
  'Вход через Яндекс сейчас недоступен. Войдите по телефону или e-mail и паролю');

/**
 * Адрес страницы согласия Яндекса. `state` — случайная строка: Яндекс вернет ее вместе с кодом,
 * и по ней видно, что человек вернулся со своего же входа, а не пришел по чужой ссылке.
 * Права не запрашиваются: у приложения они уже заданы при регистрации — почта, имя и фамилия.
 */
export function yandexAuthorizeUrl(state: string): string {
  if (!isYandexConfigured()) throw notConfigured();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: config.yandex.clientId!,
    redirect_uri: yandexRedirectUri(),
    state,
  });
  return `${AUTHORIZE_URL}?${query}`;
}

/**
 * Профиль человека по одноразовому коду Яндекса: код меняется на токен доступа, токеном забирается
 * профиль, токен тут же забывается.
 *
 * Все, что происходит после — поиск человека по почте, привязка к существующему аккаунту, создание
 * нового пользователя, роль и своя сессия, — остается в src/api/auth.ts и этой функции не касается.
 */
export const fetchYandexProfile: ExternalLogin = async ({ code }) => {
  if (!isYandexConfigured()) throw notConfigured();
  if (!code) throw badRequest('YANDEX_CODE_REQUIRED', 'Вход через Яндекс не завершен: нет кода подтверждения. Попробуйте еще раз');

  const token = await exchangeCodeForToken(code);
  const info = await loadProfile(token);

  const email = typeof info.default_email === 'string' ? info.default_email.trim().toLowerCase() : '';
  if (!email) {
    // Без адреса сервис не сможет ни найти человека, ни завести его: по почте он ищет (миграция 009).
    throw badRequest('YANDEX_NO_EMAIL', 'Яндекс не передал адрес электронной почты. Войдите по телефону или e-mail и паролю');
  }
  const name = [info.first_name, info.last_name].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim()
    || (typeof info.real_name === 'string' ? info.real_name.trim() : '')
    || email;

  return { providerId: String(info.id), email, name };
};

/** Ответ Яндекса на обмен кода. Нужен только access_token; refresh_token сервису не нужен. */
interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

/** Профиль из login.yandex.ru/info. Берутся только адрес, имя, фамилия и номер учетной записи. */
interface InfoResponse {
  id?: string | number;
  default_email?: string;
  first_name?: string;
  last_name?: string;
  real_name?: string;
}

/** Шаг 1: одноразовый код → токен доступа. Секрет приложения уходит только отсюда, с сервера. */
async function exchangeCodeForToken(code: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.yandex.clientId!,
    client_secret: config.yandex.clientSecret!,
  });

  const response = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await readJson<TokenResponse>(response);

  if (!response.ok || !data.access_token) {
    // invalid_grant — код уже использован или устарел: человек открыл старую ссылку или нажал «Назад».
    // Это единственная ошибка, в которой виноват не сервис, и о ней честно пишем человеку.
    if (data.error === 'invalid_grant') {
      throw badRequest('YANDEX_CODE_INVALID', 'Ссылка входа через Яндекс устарела. Нажмите «Войти через Яндекс» еще раз');
    }
    // Остальное — наши настройки (invalid_client, неверный адрес возврата) или сбой у Яндекса.
    // Текст ошибки Яндекса наружу не отдается: в нем бывают служебные подробности, человеку они не помогут.
    console.error('Яндекс не обменял код на токен:', response.status, data.error ?? '');
    throw notConfigured();
  }
  return data.access_token;
}

/** Шаг 2: токен → профиль. Токен передается только в заголовке и дальше нигде не используется. */
async function loadProfile(token: string): Promise<InfoResponse> {
  const response = await request(INFO_URL, { headers: { Authorization: `OAuth ${token}` } });
  const data = await readJson<InfoResponse>(response);
  if (!response.ok || data.id === undefined) {
    console.error('Яндекс не отдал профиль:', response.status);
    throw notConfigured();
  }
  return data;
}

/** Запрос к Яндексу с ограничением по времени: сеть не должна держать человека на экране бесконечно. */
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    console.error('Яндекс не ответил:', error);
    throw new HttpError(503, 'YANDEX_LOGIN_UNAVAILABLE',
      'Яндекс сейчас не отвечает. Попробуйте еще раз или войдите по телефону или e-mail и паролю');
  }
}

/** Ответ Яндекса всегда разбирается как JSON; неразобранный ответ — это сбой на их стороне. */
async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}
