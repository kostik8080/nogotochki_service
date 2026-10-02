// A-26 Настройки студии (docs/ui-map.md, список 2, пункт 8): контакты и ссылки витрины, правила записи
// и режим технических работ. Экрана в прототипе нет — раньше эти настройки менялись только через API.
// Данные: GET /api/admin/settings (в ответе и режим работы студии по дням недели).
// Кнопка «Сохранить» — PATCH /api/admin/settings: отправляются только измененные поля, в ответе — новые настройки.
// Режим работы студии и особые дни этот экран не меняет: PUT /api/admin/studio-hours затрагивает все записи,
// и для него нужен отдельный экран с предпросмотром задетых записей.
import { adminReady, handleAccessError } from './admin.js';
import * as api from './api.js';
import { clearErrors, clearOnInput, normalizePhone, setBusy, showAlert, showErrors, showServerError } from './form.js';
import { escapeHtml as esc, phone as formatPhone } from './format.js';

const form = /** @type {HTMLFormElement} */ (document.querySelector('[data-form]'));
const alert = /** @type {HTMLElement} */ (form.querySelector('[data-alert]'));
const loading = /** @type {HTMLElement} */ (document.querySelector('[data-page-loading]'));
const pageError = /** @type {HTMLElement} */ (document.querySelector('[data-page-error]'));
const statusSlot = /** @type {HTMLElement} */ (document.querySelector('[data-status]'));
const hoursSlot = /** @type {HTMLElement} */ (form.querySelector('[data-hours]'));
const field = (name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name));

const WEEKDAYS = ['', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

/** Настройки, какими их отдал сервер последним ответом: с ними сравниваются поля при сохранении. */
let settings = null;

/** Текстовые поля формы и соответствующие им поля API. */
const TEXT_FIELDS = ['studioName', 'address', 'timezone'];
const LINK_FIELDS = ['mapUrl', 'vkUrl', 'telegramUrl'];
const NUMBER_FIELDS = ['slotStepMin', 'bookingHorizonDays', 'minLeadMin', 'clientChangeDeadlineHours', 'slotHoldMin'];

function render() {
  for (const name of [...TEXT_FIELDS, ...LINK_FIELDS]) field(name).value = settings[name] ?? '';
  for (const name of NUMBER_FIELDS) field(name).value = String(settings[name]);
  field('phone').value = settings.phone ? formatPhone(settings.phone) : '';
  /** @type {HTMLInputElement} */ (form.querySelector('[data-maintenance]')).checked = settings.isMaintenance;

  statusSlot.innerHTML = settings.isMaintenance
    ? '<span class="admin-badge admin-badge--off">Запись закрыта</span>'
    : '<span class="admin-badge admin-badge--on">Запись открыта</span>';

  hoursSlot.innerHTML = settings.hours.length
    ? `<dl class="admin-schedule">${settings.hours.map((h) => `
        <dt>${esc(WEEKDAYS[h.weekday] ?? '')}</dt>
        <dd>${esc(h.open)} – ${esc(h.close)}</dd>`).join('')}</dl>`
    : '<p class="admin-panel__hint">Рабочих дней не задано: студия закрыта всю неделю, и свободного времени не будет ни у кого.</p>';
}

/** Что изменилось по сравнению с настройками сервера. Неизмененные поля не отправляются. */
function changes() {
  const body = {};
  for (const name of TEXT_FIELDS) {
    const value = field(name).value.trim();
    if (value !== (settings[name] ?? '')) body[name] = value;
  }
  // Пустая ссылка очищает значение: API принимает null.
  for (const name of LINK_FIELDS) {
    const value = field(name).value.trim();
    if (value !== (settings[name] ?? '')) body[name] = value === '' ? null : value;
  }
  for (const name of NUMBER_FIELDS) {
    const value = Number(field(name).value);
    if (Number.isFinite(value) && value !== settings[name]) body[name] = value;
  }
  // Телефон — к виду +79112223344, как в базе: так же его приведет и сервер.
  const phone = normalizePhone(field('phone').value.trim()) ?? field('phone').value.trim();
  if (phone !== (settings.phone ?? '')) body.phone = phone;

  const maintenance = /** @type {HTMLInputElement} */ (form.querySelector('[data-maintenance]')).checked;
  if (maintenance !== settings.isMaintenance) body.isMaintenance = maintenance;
  return body;
}

/** Проверка до отправки — для удобства; настоящая проверка на сервере. */
function validate(body) {
  const errors = {};
  if ('studioName' in body && !body.studioName) errors.studioName = 'Как называется студия?';
  if ('address' in body && !body.address) errors.address = 'Укажите адрес студии';
  if ('phone' in body && !normalizePhone(field('phone').value)) {
    errors.phone = 'Проверьте телефон: например, +7 911 222-33-44';
  }
  for (const name of LINK_FIELDS) {
    if (body[name] && !/^https?:\/\/\S+$/.test(body[name])) errors[name] = 'Ссылка начинается с https://';
  }
  return showErrors(form, errors);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, alert);
  const body = changes();
  if (!Object.keys(body).length) {
    showAlert(alert, 'warning', 'Менять нечего: настройки не изменились.');
    return;
  }
  if (!validate(body)) return;

  const done = setBusy(/** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')), 'Сохраняем…');
  try {
    const data = await api.updateAdminSettings(body);
    settings = data.settings;
    done();
    render();
    // О включении и выключении приема записей сообщаем отдельно: это видят клиенты.
    if ('isMaintenance' in body) {
      showAlert(alert, body.isMaintenance ? 'warning' : 'success', body.isMaintenance
        ? 'Настройки сохранены. Режим технических работ включен — клиенты записаться не могут.'
        : 'Настройки сохранены. Запись открыта: клиенты видят свободное время и могут записаться.');
    } else {
      showAlert(alert, 'success', 'Настройки сохранены.');
    }
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(form, alert, error);
  }
});

/** «Отменить изменения» — вернуть поля к тому, что сейчас на сервере, без перезагрузки страницы. */
/** @type {HTMLButtonElement} */ (form.querySelector('[data-reset]')).addEventListener('click', () => {
  clearErrors(form, alert);
  render();
});

clearOnInput(form);

async function load() {
  loading.hidden = false;
  pageError.hidden = true;
  form.hidden = true;
  try {
    const data = await api.getAdminSettings();
    settings = data.settings;
    render();
    loading.hidden = true;
    form.hidden = false;
  } catch (error) {
    loading.hidden = true;
    if (handleAccessError(error)) return;
    pageError.hidden = false;
    pageError.textContent = error instanceof api.ApiError
      ? error.message
      : 'Не удалось загрузить настройки. Обновите страницу.';
  }
}

if (await adminReady) load();
