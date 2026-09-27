// Формы клиентских страниц: проверка полей до отправки, ошибки под полями и общее сообщение над формой.
// Проверка на странице — только для удобства клиента: настоящую делает сервер, и его ответ
// показывается так же — текстом, а поле из details.fields подсвечивается.
import { ApiError } from './api.js';
import { plural } from './format.js';

// ---------- Правила полей (повторяют сервер, server/src/http/validate.ts) ----------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Телефон к виду +79112223344, как его ждет сервер. Российский номер можно ввести с 8, с 7 без плюса
 * или без кода страны. Возвращает null, если это не похоже на телефон.
 */
export function normalizePhone(raw) {
  let value = String(raw).replace(/[\s()-]/g, '');
  if (/^8\d{10}$/.test(value) || /^7\d{10}$/.test(value)) value = '+7' + value.slice(1);
  else if (/^9\d{9}$/.test(value)) value = '+7' + value;
  return /^\+\d{7,15}$/.test(value) ? value : null;
}

export const isEmail = (value) => value.length <= 254 && EMAIL.test(value);

/** Правила пароля. Сервер проверяет только длину 8–128; «буква» и «цифра» — правило интерфейса (docs/ui-map.md). */
export const PASSWORD_RULES = [
  { key: 'length', label: 'минимум 8 символов', test: (p) => p.length >= 8 && p.length <= 128 },
  { key: 'letter', label: 'есть буква', test: (p) => /\p{L}/u.test(p) },
  { key: 'digit', label: 'есть цифра', test: (p) => /\d/.test(p) },
];

/** Текст ошибки пароля или null, если пароль подходит. */
export function passwordError(password) {
  if (!password) return 'Придумайте пароль';
  if (password.length > 128) return 'Пароль не длиннее 128 символов';
  const failed = PASSWORD_RULES.filter((rule) => !rule.test(password));
  return failed.length ? `Нужно: ${failed.map((rule) => rule.label).join(', ')}` : null;
}

/**
 * Живые подсказки под полем пароля: у выполненного правила — галочка.
 * @param {HTMLInputElement} input
 * @param {HTMLElement} list <ul> с элементами [data-rule="length|letter|digit"]
 */
export function bindPasswordHints(input, list) {
  const update = () => {
    for (const rule of PASSWORD_RULES) {
      const item = list.querySelector(`[data-rule="${rule.key}"]`);
      const ok = rule.test(input.value);
      item.classList.toggle('is-met', ok);
      item.querySelector('[data-mark]').textContent = ok ? '✓' : '○';
    }
  };
  input.addEventListener('input', update);
  update();
}

// ---------- Ошибки полей ----------

/** Поле формы по имени, которое сервер присылает в details.fields. */
const fieldOf = (form, name) => form.elements.namedItem(name);

function errorSlot(form, name) {
  return form.querySelector(`[data-error-for="${name}"]`);
}

/**
 * Подсветить поле и написать ошибку под ним. Возвращает false, если такого поля на форме нет.
 * @param {HTMLFormElement} form
 * @param {string} name
 * @param {string} message
 */
export function setFieldError(form, name, message) {
  const field = fieldOf(form, name);
  const slot = errorSlot(form, name);
  if (!(field instanceof HTMLElement) || !slot) return false;
  field.setAttribute('aria-invalid', 'true');
  field.closest('.field, .check')?.classList.add('is-invalid');
  slot.textContent = message;
  slot.hidden = false;
  return true;
}

export function clearFieldError(form, name) {
  const field = fieldOf(form, name);
  if (field instanceof HTMLElement) {
    field.removeAttribute('aria-invalid');
    field.closest('.field, .check')?.classList.remove('is-invalid');
  }
  const slot = errorSlot(form, name);
  if (slot) {
    slot.textContent = '';
    slot.hidden = true;
  }
}

/** Снять все ошибки полей и общее сообщение. */
export function clearErrors(form, alert) {
  form.querySelectorAll('[data-error-for]').forEach((slot) => clearFieldError(form, slot.dataset.errorFor));
  if (alert) hideAlert(alert);
}

/** Ошибка поля уходит, как только клиент начал его исправлять. */
export function clearOnInput(form) {
  form.addEventListener('input', (event) => {
    const name = /** @type {HTMLInputElement} */ (event.target).name;
    if (name) clearFieldError(form, name);
  });
}

/**
 * Показать ошибки проверки на странице. Фокус — на первое поле с ошибкой.
 * @param {HTMLFormElement} form
 * @param {Record<string, string | null>} errors имя поля → текст ошибки или null
 * @returns {boolean} true, если ошибок нет
 */
export function showErrors(form, errors) {
  let first = null;
  for (const [name, message] of Object.entries(errors)) {
    if (!message) continue;
    setFieldError(form, name, message);
    first ??= fieldOf(form, name);
  }
  if (first instanceof HTMLElement) first.focus();
  return first === null;
}

// ---------- Общее сообщение над формой ----------

/**
 * @param {HTMLElement} alert блок [role=alert] над формой
 * @param {'error' | 'warning' | 'success'} kind
 * @param {string | Node} content текст или готовая разметка
 */
export function showAlert(alert, kind, content) {
  alert.className = `alert alert--${kind}`;
  alert.replaceChildren(content);
  alert.hidden = false;
}

export function hideAlert(alert) {
  alert.hidden = true;
  alert.replaceChildren();
}

/** «Попробуйте через 15 минут» по заголовку Retry-After. */
export function retryText(seconds) {
  if (!seconds) return 'Попробуйте позже.';
  const minutes = Math.ceil(seconds / 60);
  return minutes > 1
    ? `Попробуйте через ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}.`
    : 'Попробуйте через минуту.';
}

/**
 * Ответ сервера с ошибкой — на форму: ошибки полей из details.fields под полями, остальное — текстом над формой.
 * @param {HTMLFormElement} form
 * @param {HTMLElement} alert
 * @param {unknown} error
 */
export function showServerError(form, alert, error) {
  if (!(error instanceof ApiError)) {
    showAlert(alert, 'error', 'Что-то пошло не так. Обновите страницу и попробуйте еще раз.');
    return;
  }
  let first = null;
  const unplaced = [];
  for (const { field, message } of error.fields) {
    if (setFieldError(form, field, message)) first ??= fieldOf(form, field);
    else unplaced.push(message);
  }
  // Общий текст сервера («Проверьте введенные данные») и ошибки полей, которых нет на форме
  let text = error.message;
  if (unplaced.length) text += ': ' + unplaced.join('; ');
  if (error.status === 429) text += ' ' + retryText(error.retryAfter);
  showAlert(alert, 'error', text);
  if (first instanceof HTMLElement) first.focus();
}

// ---------- Кнопка отправки ----------

/**
 * Кнопка на время запроса: недоступна, с текстом «Входим…». Возвращает функцию, которая вернет все как было.
 * @param {HTMLButtonElement} button
 * @param {string} busyLabel
 */
export function setBusy(button, busyLabel) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  button.closest('form')?.setAttribute('aria-busy', 'true');
  return () => {
    button.disabled = false;
    button.textContent = label;
    button.closest('form')?.setAttribute('aria-busy', 'false');
  };
}

/** Кнопка «Показать» / «Скрыть» у поля пароля. */
export function bindPasswordToggle(input, button) {
  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Скрыть' : 'Показать';
    button.setAttribute('aria-pressed', String(show));
  });
}

// ---------- Адрес возврата после входа ----------

/**
 * Куда вернуть после входа: ?next=account.html. Только своя страница из web/ — иначе по чужой ссылке
 * человек после входа попал бы на чужой сайт.
 */
export function safeNext(fallback) {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && /^[a-z0-9-]+\.html(\?[\w=&%.-]*)?$/.test(next) ? next : fallback;
}
