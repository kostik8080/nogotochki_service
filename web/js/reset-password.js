// AUTH-08 Новый пароль (docs/ui-map.md). Токен — из адреса ссылки в письме: /reset-password?token=…
// POST /api/auth/password-reset/confirm { token, password }: 204 — пароль изменен, все сессии закрыты;
// 400 INVALID_CODE — «Ссылка больше не действует». Токен нигде не сохраняется: он живет только в адресе.
import * as api from './api.js';
import {
  bindPasswordHints, clearErrors, clearOnInput, passwordError, setBusy, showErrors, showServerError,
} from './form.js';

const form = /** @type {HTMLFormElement} */ (document.querySelector('[data-reset-form]'));
const alert = /** @type {HTMLElement} */ (form.querySelector('[data-alert]'));
const passwordInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('password'));
const confirmInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('confirm'));

const token = new URLSearchParams(window.location.search).get('token')?.trim() ?? '';

function showStep(name) {
  for (const section of document.querySelectorAll('[data-step]')) {
    /** @type {HTMLElement} */ (section).hidden = section.getAttribute('data-step') !== name;
  }
  const heading = document.querySelector(`[data-step="${name}"] h1[tabindex]`);
  if (heading instanceof HTMLElement) heading.focus();
}

// Без токена в адресе форма бесполезна: сразу предлагаем запросить новую ссылку
if (!token) showStep('expired');

bindPasswordHints(passwordInput, form.querySelector('[data-password-rules]'));
clearOnInput(form);

function validate() {
  const password = passwordInput.value;
  return showErrors(form, {
    password: passwordError(password),
    confirm: !confirmInput.value ? 'Повторите пароль'
      : confirmInput.value !== password ? 'Пароли не совпадают' : null,
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, alert);
  if (!validate()) return;

  const done = setBusy(/** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')), 'Сохраняем…');
  try {
    await api.confirmPasswordReset({ token, password: passwordInput.value });
    showStep('done');
  } catch (error) {
    done();
    if (error instanceof api.ApiError && error.code === 'INVALID_CODE') showStep('expired');
    else showServerError(form, alert, error);
  }
});
