// Кнопка «Войти с Яндекс ID» на AUTH-01 Вход и AUTH-03 Регистрация (docs/ui-map.md).
// В прототипе этой кнопки нет: функция появилась после него (docs/ui-map.md, список 2, пункт 7).
//
// Как идет вход:
//   1. нажатие → GET /api/auth/yandex/start: сервер отдает адрес страницы согласия Яндекса
//      и случайную строку state; страница запоминает state у себя и уходит на этот адрес;
//   2. Яндекс возвращает человека на страницу входа с ?code=… и тем же state;
//   3. страница сверяет state и отправляет код в POST /api/auth/yandex — дальше сервер сам
//      находит человека по почте и ставит cookie сессии; токены Яндекса страница не видит.
//
// Если человек на экране согласия нажал «Отмена», Яндекс возвращает его сюда же с ?error=access_denied:
// белого экрана не будет — страница входа покажет, что вход не завершен, и предложит войти по паролю.
import * as api from './api.js';
import { showAlert } from './form.js';

/** Случайная строка последнего входа и адрес возврата: живут только до возвращения из Яндекса. */
const STATE_KEY = 'nog_yandex_state';
const NEXT_KEY = 'nog_yandex_next';

const store = {
  get(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null; // приватный режим: вход все равно пройдет, просто без сверки state
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // хранилище недоступно — не страшно
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(NEXT_KEY);
    } catch {
      // нечего убирать
    }
  },
};

/**
 * Кнопка Яндекса на время запроса только выключается: менять ее содержимое — текст и иконку —
 * Яндекс запрещает (css/auth.css), поэтому о ходе входа говорит плашка сообщений карточки.
 * @param {HTMLButtonElement | null} button
 * @param {boolean} busy
 */
function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

/** Убрать code, state и error из адреса: при обновлении страницы они уже не нужны и сбивают с толку. */
function cleanUrl() {
  window.history.replaceState(null, '', window.location.pathname);
}

/**
 * Кнопка внешнего входа и возвращение из Яндекса.
 * @param {object} options
 * @param {HTMLButtonElement | null} options.button кнопка «Войти с Яндекс ID»
 * @param {HTMLElement | null} options.alert плашка сообщений той же карточки
 * @param {(user: { roles: string[] }) => string} options.after куда перейти после входа
 */
export function bindYandexLogin({ button, alert, after }) {
  finishLogin({ button, alert, after });

  if (!button) return;
  button.addEventListener('click', async () => {
    setBusy(button, true);
    if (alert) showAlert(alert, 'warning', 'Открываем Яндекс…');
    try {
      const { url, state } = await api.startYandexLogin();
      store.set(STATE_KEY, state);
      // Куда человек шел до входа (?next=страница): после возвращения из Яндекса адрес будет другим.
      const next = new URLSearchParams(window.location.search).get('next');
      if (next) store.set(NEXT_KEY, next);
      window.location.assign(url);
    } catch (error) {
      setBusy(button, false);
      // Ошибку показываем текстом на экране, а не только в консоли (docs/frontend-rules.md, правило 7)
      const message = error instanceof api.ApiError ? error.message : 'Не удалось открыть вход через Яндекс. Попробуйте еще раз.';
      if (alert) showAlert(alert, 'error', message);
    }
  });
}

/** Возвращение из Яндекса: код, отказ или ошибка в адресе страницы. */
async function finishLogin({ button, alert, after }) {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return;

  const savedState = store.get(STATE_KEY);
  const savedNext = store.get(NEXT_KEY);
  store.clear();
  cleanUrl();

  if (error) {
    // «Отмена» на экране согласия — это не поломка: человек передумал.
    const text = error === 'access_denied'
      ? 'Вход через Яндекс не завершен: вы не дали согласие. Попробуйте еще раз или войдите по телефону или e-mail и паролю.'
      : 'Вход через Яндекс не завершен: Яндекс вернул ошибку. Попробуйте еще раз или войдите по телефону или e-mail и паролю.';
    if (alert) showAlert(alert, 'warning', text);
    return;
  }

  // Код пришел не с нашего входа: так бывает по чужой ссылке. Вход не начинаем.
  if (savedState && params.get('state') !== savedState) {
    if (alert) showAlert(alert, 'error', 'Вход через Яндекс не завершен: ссылка не совпадает с начатым входом. Нажмите «Войти с Яндекс ID» еще раз.');
    return;
  }

  setBusy(button, true);
  if (alert) showAlert(alert, 'warning', 'Завершаем вход через Яндекс…');
  try {
    const { user } = await api.loginWithYandex({ code });
    // Адрес возврата из начатой записи: after() читает его из строки запроса.
    if (savedNext) window.history.replaceState(null, '', `${window.location.pathname}?next=${encodeURIComponent(savedNext)}`);
    window.location.assign(after(user));
  } catch (failure) {
    setBusy(button, false);
    const message = failure instanceof api.ApiError ? failure.message : 'Не удалось завершить вход через Яндекс. Попробуйте еще раз.';
    if (alert) showAlert(alert, 'error', message);
  }
}
