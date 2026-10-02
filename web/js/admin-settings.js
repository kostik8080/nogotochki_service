// A-26 Настройки студии (docs/ui-map.md, список 2, пункт 8): контакты и ссылки витрины, правила записи
// и режим технических работ. Экрана в прототипе нет — раньше эти настройки менялись только через API.
// Данные: GET /api/admin/settings (в ответе и режим работы студии по дням недели).
// Кнопка «Сохранить» — PATCH /api/admin/settings: отправляются только измененные поля, в ответе — новые настройки.
// Режим работы студии — PUT /api/admin/studio-hours, особые дни (A-20d) — GET, PUT и DELETE /api/admin/studio-days.
// И режим работы, и особый день сначала запрашиваются с dryRun: true: сервер отвечает записями, которые в новые
// часы не помещаются, экран их показывает, и только второе нажатие сохраняет. Сами записи сервер не трогает.
import { adminReady, handleAccessError } from './admin.js';
import * as api from './api.js';
import { clearErrors, clearOnInput, normalizePhone, setBusy, showAlert, showErrors, showServerError } from './form.js';
import { dateLabel, escapeHtml as esc, phone as formatPhone, timeLabel } from './format.js';

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

  renderHours();
  renderDays();
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

// ---------------------------------------------------------------------------
// Режим работы студии по дням недели (PUT /api/admin/studio-hours)
// ---------------------------------------------------------------------------

const hoursAlert = /** @type {HTMLElement} */ (form.querySelector('[data-hours-alert]'));
const hoursAffected = /** @type {HTMLElement} */ (form.querySelector('[data-hours-affected]'));
const hoursSave = /** @type {HTMLButtonElement} */ (form.querySelector('[data-hours-save]'));

/** Показаны ли записи, которые не помещаются в новый режим: второе нажатие сохраняет вместе с ними. */
let hoursConfirmed = false;

/** Строка на каждый день недели: работает ли студия и часы. Выключенный день — студия закрыта. */
function renderHours() {
  const byDay = new Map(settings.hours.map((h) => [h.weekday, h]));
  hoursSlot.innerHTML = [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const day = byDay.get(weekday);
    const open = day?.open ?? '10:00';
    const close = day?.close ?? '20:00';
    return `<div class="admin-hours__row">
      <label class="check__label admin-hours__day">
        <input type="checkbox" name="hoursOpen" value="${weekday}"${day ? ' checked' : ''} data-hours-day>
        <span>${WEEKDAYS[weekday]}</span>
      </label>
      <input class="input admin-hours__time" type="time" step="300" name="hoursFrom${weekday}" value="${open}"
        aria-label="${WEEKDAYS[weekday]}: открытие"${day ? '' : ' disabled'}>
      <input class="input admin-hours__time" type="time" step="300" name="hoursTo${weekday}" value="${close}"
        aria-label="${WEEKDAYS[weekday]}: закрытие"${day ? '' : ' disabled'}>
    </div>`;
  }).join('');
}

// Часы выключенного дня не трогаются: студия в этот день закрыта.
hoursSlot.addEventListener('change', (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  if (!input.matches('[data-hours-day]')) return;
  for (const time of input.closest('.admin-hours__row').querySelectorAll('input[type="time"]')) {
    /** @type {HTMLInputElement} */ (time).disabled = !input.checked;
  }
  hoursConfirmed = false;
  hoursSave.textContent = 'Сохранить режим работы';
  hoursAffected.hidden = true;
});

/** Дни, отмеченные как рабочие, в формате API. */
function hoursFromForm() {
  return [...hoursSlot.querySelectorAll('[data-hours-day]:checked')].map((input) => {
    const weekday = Number(/** @type {HTMLInputElement} */ (input).value);
    const row = input.closest('.admin-hours__row');
    const times = row.querySelectorAll('input[type="time"]');
    return { weekday, open: /** @type {HTMLInputElement} */ (times[0]).value, close: /** @type {HTMLInputElement} */ (times[1]).value };
  });
}

/** Записи, которые не помещаются в новый режим: сервер их не трогает, разбирает администратор. */
function showAffected(box, bookings, button, text) {
  const intro = document.createElement('p');
  intro.className = 'admin-panel__hint';
  intro.textContent = `${text} (${bookings.length}). Сами они не отменяются — перенесите или отмените их в разделе «Записи». Если менять все равно нужно, нажмите «${button.dataset.confirmLabel}»:`;
  const list = document.createElement('ul');
  list.className = 'admin-list';
  for (const b of bookings) {
    const item = document.createElement('li');
    item.textContent = `${dateLabel(b.startsAt, settings.timezone)}, ${timeLabel(b.startsAt, settings.timezone)} · ${b.master?.name ?? ''} · ${b.client?.name ?? ''}`;
    list.append(item);
  }
  box.replaceChildren(intro, list);
  box.hidden = false;
  button.textContent = button.dataset.confirmLabel;
}

hoursSave.dataset.confirmLabel = 'Сохранить всё равно';
hoursSave.addEventListener('click', async () => {
  hoursAlert.hidden = true;
  const days = hoursFromForm();
  const wrong = days.find((d) => !d.open || !d.close || d.close <= d.open);
  if (wrong) {
    showAlert(hoursAlert, 'error', `${WEEKDAYS[wrong.weekday]}: закрытие должно быть позже открытия.`);
    return;
  }

  const done = setBusy(hoursSave, hoursConfirmed ? 'Сохраняем…' : 'Проверяем…');
  try {
    if (!hoursConfirmed) {
      const preview = await api.setStudioHours({ days, dryRun: true });
      if (preview.affectedBookings?.length) {
        done();
        showAffected(hoursAffected, preview.affectedBookings, hoursSave, 'В новый режим работы не попадают записи');
        hoursConfirmed = true;
        return;
      }
    }
    const saved = await api.setStudioHours({ days });
    settings = { ...settings, hours: saved.hours ?? days };
    done();
    hoursConfirmed = false;
    hoursAffected.hidden = true;
    hoursSave.textContent = 'Сохранить режим работы';
    renderHours();
    showAlert(hoursAlert, 'success', days.length
      ? 'Режим работы сохранен.'
      : 'Режим работы сохранен: студия закрыта всю неделю, свободного времени не будет ни у кого.');
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(form, hoursAlert, error);
  }
});

// ---------------------------------------------------------------------------
// A-20d Особые дни студии
// ---------------------------------------------------------------------------

const daysSlot = /** @type {HTMLElement} */ (form.querySelector('[data-days]'));
const dayForm = /** @type {HTMLElement} */ (form.querySelector('[data-day-form]'));
const dayActions = /** @type {HTMLElement} */ (form.querySelector('[data-day-actions]'));
const dayAlert = /** @type {HTMLElement} */ (form.querySelector('[data-day-alert]'));
const dayAffected = /** @type {HTMLElement} */ (form.querySelector('[data-day-affected]'));
const daySave = /** @type {HTMLButtonElement} */ (form.querySelector('[data-day-save]'));

/** Особые дни студии от сегодня на горизонт записи. */
let specialDays = [];
let dayConfirmed = false;

const dayKind = () => /** @type {HTMLInputElement} */ (form.querySelector('input[name="dayKind"]:checked')).value;

/** Особые дни на год вперед: праздники студия заводит заранее, а горизонт записи короче. */
function loadSpecialDays() {
  const to = new Date();
  to.setUTCFullYear(to.getUTCFullYear() + 1);
  return api.getAdminStudioDays({ to: to.toISOString().slice(0, 10) });
}

/** Тип особого дня словами: «Доп. рабочий день» — особые часы там, где студия обычно закрыта. */
function dayType(day) {
  if (!day.isOpen) return 'Студия закрыта';
  const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay() || 7;
  const usual = settings.hours.some((h) => h.weekday === weekday);
  return `${usual ? 'Особые часы' : 'Доп. рабочий день'} · ${day.open}–${day.close}`;
}

function renderDays() {
  if (!specialDays.length) {
    daysSlot.innerHTML = '<p class="admin-panel__hint">Особых дней нет — студия работает по обычному режиму.</p>';
    return;
  }
  daysSlot.innerHTML = `<ul class="admin-days">${specialDays.map((day) => `
    <li class="admin-days__item">
      <span class="admin-days__date">${esc(dateLabel(day.date + 'T12:00:00Z', settings.timezone))}</span>
      <span class="admin-days__type">${esc(dayType(day))}</span>
      <span class="admin-days__reason">${esc(day.reason)}</span>
      <button class="text-link" type="button" data-day-delete="${esc(day.date)}">Удалить</button>
    </li>`).join('')}</ul>`;
}

daysSlot.addEventListener('click', async (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('[data-day-delete]');
  if (!button) return;
  const date = /** @type {HTMLElement} */ (button).dataset.dayDelete;
  const done = setBusy(/** @type {HTMLButtonElement} */ (button), 'Убираем…');
  try {
    await api.deleteStudioDay(date);
    specialDays = specialDays.filter((d) => d.date !== date);
    done();
    renderDays();
    showAlert(alert, 'success', `Особый день ${dateLabel(date + 'T12:00:00Z', settings.timezone)} убран: студия работает по обычному режиму.`);
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showAlert(alert, 'error', error instanceof api.ApiError ? error.message : 'Не удалось убрать особый день.');
  }
});

/** @type {HTMLInputElement} */ (form.querySelector('[data-day-open]')).addEventListener('click', () => {
  const today = new Date().toISOString().slice(0, 10);
  field('dayDate').value = '';
  field('dayDate').min = today;
  field('dayReason').value = '';
  /** @type {HTMLInputElement} */ (form.querySelector('input[name="dayKind"][value="closed"]')).checked = true;
  form.querySelector('[data-day-hours]').hidden = true;
  dayConfirmed = false;
  daySave.textContent = 'Добавить день';
  dayAffected.hidden = true;
  dayAlert.hidden = true;
  dayActions.hidden = true;
  dayForm.hidden = false;
  field('dayDate').focus();
});

/** @type {HTMLButtonElement} */ (form.querySelector('[data-day-cancel]')).addEventListener('click', () => {
  clearErrors(form, dayAlert);
  dayForm.hidden = true;
  dayActions.hidden = false;
});

// Часы нужны только у дня, когда студия работает.
for (const radio of form.querySelectorAll('input[name="dayKind"]')) {
  radio.addEventListener('change', () => {
    form.querySelector('[data-day-hours]').hidden = dayKind() !== 'open';
    dayConfirmed = false;
    daySave.textContent = 'Добавить день';
    dayAffected.hidden = true;
  });
}

daySave.dataset.confirmLabel = 'Добавить всё равно';
daySave.addEventListener('click', async () => {
  clearErrors(form, dayAlert);
  const date = field('dayDate').value;
  const reason = field('dayReason').value.trim();
  const isOpen = dayKind() === 'open';
  const open = field('dayOpen').value;
  const close = field('dayClose').value;
  const today = new Date().toISOString().slice(0, 10);
  const valid = showErrors(form, {
    dayDate: !date ? 'Укажите дату' : date < today ? 'Прошедший день изменить нельзя' : null,
    dayReason: reason ? null : 'Укажите причину — ее видят клиенты',
    dayOpen: isOpen && !open ? 'Укажите время открытия' : null,
    dayClose: isOpen && (!close || close <= open) ? 'Закрытие должно быть позже открытия' : null,
  });
  if (!valid) return;

  const body = isOpen ? { isOpen: true, open, close, reason } : { isOpen: false, reason };
  const done = setBusy(daySave, dayConfirmed ? 'Сохраняем…' : 'Проверяем…');
  try {
    if (!dayConfirmed) {
      const preview = await api.setStudioDay(date, { ...body, dryRun: true });
      if (preview.affectedBookings?.length) {
        done();
        showAffected(dayAffected, preview.affectedBookings, daySave, 'В этот день не помещаются записи');
        dayConfirmed = true;
        return;
      }
    }
    await api.setStudioDay(date, body);
    specialDays = (await loadSpecialDays()).days;
    done();
    renderDays();
    dayForm.hidden = true;
    dayActions.hidden = false;
    showAlert(alert, 'success', `Особый день ${dateLabel(date + 'T12:00:00Z', settings.timezone)} сохранен.`);
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(form, dayAlert, error);
  }
});

clearOnInput(form);

async function load() {
  loading.hidden = false;
  pageError.hidden = true;
  form.hidden = true;
  try {
    const [data, days] = await Promise.all([api.getAdminSettings(), loadSpecialDays()]);
    settings = data.settings;
    specialDays = days.days;
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
