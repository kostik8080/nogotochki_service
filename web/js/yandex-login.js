// Кнопка «Войти через Яндекс» на AUTH-01 Вход и AUTH-03 Регистрация (docs/ui-map.md).
// POST /api/auth/yandex: cookie сессии ставит сервер, страница токенов не видит и ничего не сохраняет.
// В прототипе этой кнопки нет: функция появилась после него (docs/ui-map.md, список 2, пункт 7).
//
// Куда вести после входа, решает страница: с входа — туда же, куда вход по паролю (с учетом ?next=),
// с регистрации — в кабинет или обратно к начатой записи. Через внешний вход приходит только клиент:
// учетной записи сотрудника сервер отвечает 403, и этот текст показывается на экране.
import * as api from './api.js';
import { showAlert } from './form.js';

/**
 * Кнопка внешнего входа: нажатие → свой сеанс в сервисе → переход.
 * @param {object} options
 * @param {HTMLButtonElement | null} options.button кнопка «Войти через Яндекс»
 * @param {HTMLElement | null} options.alert плашка сообщений той же карточки
 * @param {(user: { roles: string[] }) => string} options.after куда перейти после входа
 */
export function bindYandexLogin({ button, alert, after }) {
  if (!button) return;
  button.addEventListener('click', async () => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Входим…';
    if (alert) alert.hidden = true;
    try {
      const { user } = await api.loginWithYandex();
      window.location.assign(after(user));
    } catch (error) {
      button.disabled = false;
      button.textContent = label;
      // Ошибку показываем текстом на экране, а не только в консоли (docs/frontend-rules.md, правило 7)
      const message = error instanceof api.ApiError ? error.message : 'Не удалось войти через Яндекс. Попробуйте еще раз.';
      if (alert) showAlert(alert, 'error', message);
    }
  });
}
