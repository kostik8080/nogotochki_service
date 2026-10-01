// AUTH-06 Восстановление пароля (docs/ui-map.md). POST /api/auth/password-reset/request { login }:
// 202 с одинаковым ответом — по нему нельзя узнать, есть ли аккаунт; 429 — слишком много запросов с одного адреса.
// Исключение — аккаунт без пароля: ответ 200 с `provider`, письма нет, и экран объясняет, что вход
// выполняется через Яндекс. Сбрасывать там нечего, и ждать письмо человеку незачем.
// Телефон студии для подсказки — GET /api/studio.
import * as api from './api.js';
import {
  clearErrors, clearOnInput, isEmail, normalizePhone, retryText, setBusy, showAlert, showErrors, showServerError,
} from './form.js';
import { phone as formatPhone, phoneHref } from './format.js';

const form = /** @type {HTMLFormElement} */ (document.querySelector('[data-forgot-form]'));
const alert = /** @type {HTMLElement} */ (form.querySelector('[data-alert]'));
const loginInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('login'));
const formStep = /** @type {HTMLElement} */ (document.querySelector('[data-step="form"]'));
const sentStep = /** @type {HTMLElement} */ (document.querySelector('[data-step="sent"]'));
const providerStep = /** @type {HTMLElement} */ (document.querySelector('[data-step="provider"]'));

clearOnInput(form);

// Телефон студии грузится заранее: он понадобится в подсказке после отправки
const studio = api.getStudio().catch(() => null);

function validate() {
  const login = loginInput.value.trim();
  let error = null;
  if (!login) error = 'Введите телефон или e-mail';
  else if (login.includes('@') ? !isEmail(login) : !normalizePhone(login)) {
    error = login.includes('@')
      ? 'Проверьте e-mail: например, name@example.com'
      : 'Проверьте телефон: например, +7 911 222-33-44';
  }
  return showErrors(form, { login: error });
}

async function showSent() {
  formStep.hidden = true;
  sentStep.hidden = false;
  sentStep.querySelector('h1').focus();
  const data = await studio;
  if (!data) return;
  const link = /** @type {HTMLAnchorElement} */ (sentStep.querySelector('[data-studio-phone]'));
  link.href = phoneHref(data.phone);
  link.textContent = formatPhone(data.phone);
  link.setAttribute('aria-label', `Позвонить в студию: ${formatPhone(data.phone)}`);
  link.hidden = false;
}

/** Аккаунт без пароля: текст приходит от сервера — он знает, какой это внешний сервис. */
function showProvider(message) {
  formStep.hidden = true;
  providerStep.hidden = false;
  /** @type {HTMLElement} */ (providerStep.querySelector('[data-provider-message]')).textContent = message;
  /** @type {HTMLElement} */ (providerStep.querySelector('h1')).focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, alert);
  if (!validate()) return;

  const login = loginInput.value.trim();
  const done = setBusy(/** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')), 'Отправляем…');
  try {
    // Текст ответа сервера обещает код от администратора — его не показываем (docs/ui-map.md, пункт 10.1)
    const res = await api.requestPasswordReset({ login: login.includes('@') ? login : normalizePhone(login) ?? login });
    if (res?.provider) showProvider(res.message);
    else await showSent();
  } catch (error) {
    done();
    if (error instanceof api.ApiError && error.status === 429) {
      showAlert(alert, 'error', `Слишком много запросов. ${retryText(error.retryAfter)}`);
    } else {
      showServerError(form, alert, error);
    }
  }
});
