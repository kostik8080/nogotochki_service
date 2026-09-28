// AUTH-03 Регистрация и AUTH-02 Подтверждение кодом (docs/ui-map.md).
// POST /api/auth/register { name, phone?, email?, password, pdConsent: true, marketingConsent }:
//   201 — аккаунт создан, сервер сам поставил cookie сессии → CAB-01 (пустой кабинет);
//   202 — номер уже в карточке клиента (сценарий 16): код на e-mail из карточки, тот же запрос повторяется с code;
//         delivery: studio — e-mail в карточке нет: просим позвонить в студию, поле кода не показываем;
//   409 PHONE_TAKEN / EMAIL_TAKEN — «Такой аккаунт уже есть» с «Войти»; 400 — ошибки полей.
// Данные формы на шаге кода живут только в памяти страницы: пароль никуда не сохраняется.
import * as api from './api.js';
import {
  bindPasswordHints, clearErrors, clearOnInput, hideAlert, isEmail, normalizePhone, passwordError, retryText,
  setBusy, setFieldError, showAlert, showErrors, showServerError,
} from './form.js';
import { phone as formatPhone, phoneHref, plural } from './format.js';
import { routes } from './routes.js';
import { getDraft } from './store.js';

const PREFILL_KEY = 'nog_login_prefill';

/** После регистрации — в пустой кабинет, а если клиент начал запись и выбрал время — обратно к ней (карта экранов) */
const afterRegister = () => (getDraft().startsAt ? routes.bookingTimeStep : routes.account);
const RESEND_SECONDS = 60;

const steps = {
  form: /** @type {HTMLElement} */ (document.querySelector('[data-step="form"]')),
  code: /** @type {HTMLElement} */ (document.querySelector('[data-step="code"]')),
  call: /** @type {HTMLElement} */ (document.querySelector('[data-step="call"]')),
};

const form = /** @type {HTMLFormElement} */ (document.querySelector('[data-register-form]'));
const alert = /** @type {HTMLElement} */ (form.querySelector('[data-alert]'));
const codeForm = /** @type {HTMLFormElement} */ (document.querySelector('[data-code-form]'));
const codeAlert = /** @type {HTMLElement} */ (codeForm.querySelector('[data-alert]'));
const resendButton = /** @type {HTMLButtonElement} */ (document.querySelector('[data-resend]'));

const input = (f, name) => /** @type {HTMLInputElement} */ (f.elements.namedItem(name));

bindPasswordHints(input(form, 'password'), form.querySelector('[data-password-rules]'));
clearOnInput(form);
clearOnInput(codeForm);

/** Тело запроса, отправленное последним: на шаге кода оно повторяется с полем code. */
let pending = null;
let resendTimer = 0;

function showStep(name) {
  for (const [key, section] of Object.entries(steps)) section.hidden = key !== name;
  // Фокус — на первое поле шага, а если полей нет — на заголовок, чтобы экранный диктор прочитал новый шаг
  const target = steps[name].querySelector('input') ?? steps[name].querySelector('h1');
  if (target instanceof HTMLElement) target.focus();
  window.scrollTo({ top: 0 });
}

// ---------- Шаг 1: форма ----------

/** Проверка до отправки — для удобства; настоящая проверка на сервере. */
function validate() {
  const name = input(form, 'name').value.trim();
  const phone = input(form, 'phone').value.trim();
  const email = input(form, 'email').value.trim();
  const noContact = !phone && !email;
  return showErrors(form, {
    name: name ? null : 'Как к вам обращаться?',
    phone: noContact ? 'Укажите телефон или e-mail'
      : phone && !normalizePhone(phone) ? 'Проверьте телефон: например, +7 911 222-33-44' : null,
    email: email && !isEmail(email) ? 'Проверьте e-mail: например, name@example.com' : null,
    password: passwordError(input(form, 'password').value),
    pdConsent: input(form, 'pdConsent').checked ? null : 'Без согласия на обработку персональных данных регистрация невозможна',
  });
}

function collect() {
  const phone = input(form, 'phone').value.trim();
  const email = input(form, 'email').value.trim();
  const body = {
    name: input(form, 'name').value.trim(),
    password: input(form, 'password').value,
    pdConsent: input(form, 'pdConsent').checked,
    marketingConsent: input(form, 'marketingConsent').checked,
  };
  if (phone) body.phone = normalizePhone(phone) ?? phone;
  if (email) body.email = email.toLowerCase();
  return body;
}

/** «Такой аккаунт уже есть» с кнопкой «Войти»: логин подставится на странице входа. */
function showAccountExists(error, body) {
  const field = error.code === 'PHONE_TAKEN' ? 'phone' : 'email';
  const login = body[field];
  const box = document.createElement('div');
  box.textContent = 'Такой аккаунт уже есть.';
  const button = document.createElement('a');
  button.className = 'btn btn--primary btn--small';
  button.href = routes.login;
  button.textContent = 'Войти';
  button.addEventListener('click', () => {
    try {
      sessionStorage.setItem(PREFILL_KEY, login);
    } catch {
      // Без хранилища логин просто не подставится
    }
  });
  const wrap = document.createDocumentFragment();
  wrap.append(box, button);
  showAlert(alert, 'warning', wrap);
  // Сервер не прислал details.fields, но по коду ясно, какое поле занято
  setFieldError(form, field, error.message);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, alert);
  if (!validate()) return;

  const body = collect();
  const done = setBusy(/** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')), 'Регистрируем…');
  try {
    const result = await api.register(body);
    if (result.status === 201) {
      window.location.assign(afterRegister());
      return;
    }
    done();
    pending = body;
    await openCodeStep(result);
  } catch (error) {
    done();
    if (error instanceof api.ApiError && (error.code === 'PHONE_TAKEN' || error.code === 'EMAIL_TAKEN')) {
      showAccountExists(error, body);
    } else {
      showServerError(form, alert, error);
    }
  }
});

// ---------- Шаг 2: код из письма (сценарий 16) ----------

async function openCodeStep(result) {
  if (result.delivery !== 'email') {
    // E-mail в карточке нет. Текст ответа API обещает код от администратора — его не показываем (пункт 13.1)
    showStep('call');
    await showStudioPhone();
    return;
  }
  const minutes = result.expiresInMin;
  document.querySelector('[data-code-hint]').textContent =
    `Код отправлен на ${result.sentTo}, действует ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}.`;
  input(codeForm, 'code').value = '';
  clearErrors(codeForm, codeAlert);
  showStep('code');
  startResendTimer();
}

async function showStudioPhone() {
  const link = /** @type {HTMLAnchorElement} */ (document.querySelector('[data-studio-phone]'));
  try {
    const studio = await api.getStudio();
    link.href = phoneHref(studio.phone);
    link.textContent = formatPhone(studio.phone);
    link.setAttribute('aria-label', `Позвонить в студию: ${formatPhone(studio.phone)}`);
    link.hidden = false;
  } catch {
    // Телефон студии не загрузился — остается текст; телефон есть на главной
    link.hidden = true;
  }
}

function startResendTimer() {
  clearInterval(resendTimer);
  let left = RESEND_SECONDS;
  const tick = () => {
    resendButton.disabled = left > 0;
    resendButton.textContent = left > 0 ? `Отправить код повторно через ${left} с` : 'Отправить код повторно';
    left -= 1;
    if (left < 0) clearInterval(resendTimer);
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

codeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(codeForm, codeAlert);
  const code = input(codeForm, 'code').value.replace(/\s/g, '');
  if (!showErrors(codeForm, { code: /^\d{6}$/.test(code) ? null : 'Введите 6 цифр из письма' })) return;

  const done = setBusy(/** @type {HTMLButtonElement} */ (codeForm.querySelector('[type=submit]')), 'Проверяем…');
  try {
    const result = await api.register({ ...pending, code });
    if (result.status === 201) {
      // Карточка привязана, прежние записи уже в кабинете
      window.location.assign(afterRegister());
      return;
    }
    done();
    await openCodeStep(result);
  } catch (error) {
    done();
    if (error instanceof api.ApiError && error.code === 'INVALID_CODE') {
      const left = /** @type {any} */ (error.details)?.attemptsLeft;
      const message = typeof left === 'number' && left > 0
        ? `Неверный код. ${plural(left, 'Осталась', 'Осталось', 'Осталось')} ${left} ${plural(left, 'попытка', 'попытки', 'попыток')}.`
        : error.message;
      showErrors(codeForm, { code: message });
    } else {
      showServerError(codeForm, codeAlert, error);
    }
  }
});

resendButton.addEventListener('click', async () => {
  clearErrors(codeForm, codeAlert);
  const done = setBusy(resendButton, 'Отправляем…');
  try {
    const result = await api.register(pending);
    done();
    if (result.status === 201) {
      window.location.assign(afterRegister());
      return;
    }
    await openCodeStep(result);
    showAlert(codeAlert, 'success', 'Новый код отправлен.');
  } catch (error) {
    done();
    if (error instanceof api.ApiError && error.status === 429) {
      showAlert(codeAlert, 'error', `Слишком много запросов. ${retryText(error.retryAfter)}`);
    } else {
      showServerError(codeForm, codeAlert, error);
    }
  }
});

document.querySelectorAll('[data-back]').forEach((button) => {
  button.addEventListener('click', () => {
    clearInterval(resendTimer);
    hideAlert(codeAlert);
    showStep('form');
  });
});
