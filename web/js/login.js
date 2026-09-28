// AUTH-01 Вход (docs/ui-map.md). POST /api/auth/login { login, password }.
// Сессию сервер ставит сам — cookie HttpOnly; страница ее не читает и ничего не сохраняет.
// Успех → CAB-01 «Мои записи» (или страница из ?next=).
import * as api from './api.js';
import {
  bindPasswordToggle, clearErrors, clearOnInput, isEmail, normalizePhone, retryText, safeNext, setBusy,
  showAlert, showErrors, showServerError,
} from './form.js';
import { routes } from './routes.js';

// Логин, подставленный с регистрации («Такой аккаунт уже есть» → «Войти»). Сразу удаляется.
const PREFILL_KEY = 'nog_login_prefill';

const form = /** @type {HTMLFormElement} */ (document.querySelector('[data-login-form]'));
const alert = /** @type {HTMLElement} */ (form.querySelector('[data-alert]'));
const loginInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('login'));
const passwordInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('password'));

// Пришли с шага «Время»: бронь бывает только после входа (docs/ui-map.md, список 1, пункт 7)
if (safeNext('') === routes.bookingTimeStep) {
  showAlert(alert, 'warning', 'Войдите, чтобы закрепить время и завершить запись. Выбранное время мы запомнили.');
}

bindPasswordToggle(passwordInput, form.querySelector('[data-password-toggle]'));
clearOnInput(form);

try {
  const prefill = sessionStorage.getItem(PREFILL_KEY);
  sessionStorage.removeItem(PREFILL_KEY);
  if (prefill) {
    loginInput.value = prefill;
    passwordInput.focus();
  }
} catch {
  // Хранилище недоступно (приватный режим) — логин просто не подставится
}

/** Проверка до отправки — для удобства; сервер проверит все сам. */
function validate() {
  const login = loginInput.value.trim();
  let loginError = null;
  if (!login) loginError = 'Введите телефон или e-mail';
  else if (login.includes('@') ? !isEmail(login) : !normalizePhone(login)) {
    loginError = login.includes('@')
      ? 'Проверьте e-mail: например, name@example.com'
      : 'Проверьте телефон: например, +7 911 222-33-44';
  }
  return showErrors(form, {
    login: loginError,
    password: passwordInput.value ? null : 'Введите пароль',
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, alert);
  if (!validate()) return;

  const login = loginInput.value.trim();
  const done = setBusy(/** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')), 'Входим…');
  try {
    const { user } = await api.login({
      // Телефон — к виду +79112223344: так же его приведет и сервер
      login: login.includes('@') ? login : normalizePhone(login) ?? login,
      password: passwordInput.value,
    });
    // Клиента — в кабинет. У сотрудника своего раздела в web/ пока нет — на главную.
    window.location.assign(user.role === 'client' ? safeNext(routes.account) : routes.home);
  } catch (error) {
    done();
    if (error instanceof api.ApiError && error.code === 'LOGIN_LOCKED') {
      showAlert(alert, 'error', `Слишком много неверных попыток, вход временно закрыт. ${retryText(error.retryAfter)}`);
    } else {
      showServerError(form, alert, error);
    }
    if (error instanceof api.ApiError && error.code === 'INVALID_CREDENTIALS') {
      passwordInput.value = '';
      passwordInput.focus();
    }
  }
});
