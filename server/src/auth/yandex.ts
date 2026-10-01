// Вход через Яндекс в один клик (паспорт, функция 1 клиента — дополнение к входу по паролю).
//
// Как это устроено. Яндекс подтверждает, что человек — владелец своего ящика, и отдает сервису его
// адрес и имя. Дальше сервис работает как при обычном входе: открывает свою серверную сессию
// (src/auth/sessions.ts) и ставит cookie с нашим токеном. Токен Яндекса нигде не хранится и ни на что
// в сервисе не дает прав: он нужен только на время запроса профиля.
//
// Чего здесь пока нет. Приложение в Яндексе не зарегистрировано: сервис не опубликован, и постоянного
// адреса, на который Яндекс вернул бы человека, у него нет. Поэтому обращение к Яндексу собрано
// отдельной функцией fetchYandexProfile — после публикации сервиса меняется только ее тело, а остальной
// вход (поиск пользователя по e-mail, привязка, роль, сессия — src/api/auth.ts) остается как есть.
// Пока она не готова, профиль подставляет заглушка: включается YANDEX_LOGIN_STUB=1 и работает только
// при разработке (в production сервер с ней не запускается, src/config.ts).
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';

/** Значение users.provider для Яндекса. Список допустимых значений ограничен и в базе (миграция 009). */
export const YANDEX_PROVIDER = 'yandex';

/** Что внешний сервис сообщает о человеке. Больше сервису ничего не нужно. */
export interface ExternalProfile {
  /** Номер учетной записи во внешнем сервисе: users.provider_id. */
  providerId: string;
  /** Подтвержденный внешним сервисом адрес, в нижнем регистре — как в users.email. */
  email: string;
  name: string;
}

/**
 * Профиль от внешнего сервиса. `code` — одноразовый код, который Яндекс вернет браузеру после
 * согласия человека; у заглушки он не нужен.
 */
export type ExternalLogin = (params: { code?: string }) => Promise<ExternalProfile>;

/**
 * Настоящее подключение Яндекса. **Место для реальной интеграции: после публикации сервиса меняется
 * только это тело.** Шаги будут такие:
 *   1. зарегистрировать приложение на https://oauth.yandex.ru и получить YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET;
 *   2. обменять `code` на токен доступа: POST https://oauth.yandex.ru/token;
 *   3. запросить профиль: GET https://login.yandex.ru/info с этим токеном, взять `default_email`, `real_name`
 *      (или `first_name`) и `id`;
 *   4. вернуть их здесь как ExternalProfile и забыть токен Яндекса — дальше работает наша сессия.
 * Пока приложения нет, ответ честный: вход через Яндекс не подключен, остается вход по паролю.
 */
export const fetchYandexProfile: ExternalLogin = async () => {
  throw new HttpError(503, 'YANDEX_LOGIN_UNAVAILABLE',
    'Вход через Яндекс пока не подключен. Войдите по телефону или e-mail и паролю');
};

/**
 * Заглушка вместо Яндекса: подставляет адрес и имя из настроек (YANDEX_STUB_EMAIL, YANDEX_STUB_NAME).
 * Так можно проверить всю нашу часть входа, пока приложение в Яндексе не зарегистрировано.
 * Проверки человека здесь нет никакой — поэтому только для разработки.
 */
export function stubYandexLogin(profile: { email: string; name: string }): ExternalLogin {
  const email = profile.email.toLowerCase();
  // Номер учетной записи «в Яндексе» выводится из адреса: он постоянный, и повторный вход заглушкой
  // находит того же пользователя, что и первый.
  const providerId = `stub-${email}`;
  return async () => ({ providerId, email, name: profile.name });
}

/** Что подставить по настройкам: заглушку (YANDEX_LOGIN_STUB=1) или настоящий Яндекс. */
export function yandexLoginFromConfig(): ExternalLogin {
  return config.yandex.loginStub
    ? stubYandexLogin({ email: config.yandex.stubEmail, name: config.yandex.stubName })
    : fetchYandexProfile;
}
