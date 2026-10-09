// «Мои заявки» мастера (/master/requests): список своих заявок и форма новой.
// Мастер просит, а расписание меняет администратор, когда одобрит: отпуск, отгул и больничный станут
// блокировкой времени, новый график — недельным графиком с даты. Пока заявка на рассмотрении,
// расписание не меняется, и мастер может ее отозвать.
//
// Здесь же мастер меняет свое фото в профиле: на сайте оно видно всем, поэтому проходит через
// администратора и отправляется такой же заявкой (тип photo). Пока она на рассмотрении, на сайте
// остается прежний портрет или инициалы.
//
// Данные: GET /api/master/requests, GET /api/master/schedule (имя и свое текущее фото).
// Кнопки: «Отправить заявку» — POST /api/master/requests; «Отозвать» — POST /api/master/requests/:id/cancel;
// «Отправить на одобрение» — POST /api/master/photo (файл в теле); «Убрать фото» — DELETE /api/master/photo.
import * as api from './api.js';
import { clearErrors, clearOnInput, setBusy, setFieldError, showErrors, showServerError } from './form.js';
import { escapeHtml as esc, initials, plural, studioDate } from './format.js';
import { handleAccessError, masterReady, setFlash } from './master-shell.js';
import { dayLabel, decisionText, periodText, photoPreview, statusBadge, TYPE_LABEL, WEEKDAYS } from './requests-view.js';

const $ = (selector, root = document) => /** @type {HTMLElement} */ (root.querySelector(selector));

const list = $('[data-list]');
const pageLoading = $('[data-page-loading]');
const pageError = $('[data-page-error]');
const dialog = /** @type {HTMLDialogElement} */ ($('[data-request-dialog]'));
const form = /** @type {HTMLFormElement} */ ($('[data-request-form]'));
const alert = $('[data-request-alert]', form);
const typeSelect = /** @type {HTMLSelectElement} */ ($('[data-type]', form));
const fromInput = /** @type {HTMLInputElement} */ ($('[data-from]', form));
const toInput = /** @type {HTMLInputElement} */ ($('[data-to]', form));
const validFromInput = /** @type {HTMLInputElement} */ ($('[data-valid-from]', form));
const commentInput = /** @type {HTMLTextAreaElement} */ ($('[data-comment]', form));

const photoForm = /** @type {HTMLFormElement} */ ($('[data-photo-form]'));
const photoCurrent = $('[data-photo-current]', photoForm);
const photoFile = /** @type {HTMLInputElement} */ ($('[data-photo-file]', photoForm));
const photoSubmit = /** @type {HTMLButtonElement} */ ($('[data-photo-submit]', photoForm));
const photoRemove = /** @type {HTMLButtonElement} */ ($('[data-photo-remove]', photoForm));
const photoAlert = $('[data-photo-alert]', photoForm);

/** Сегодняшняя дата студии: раньше нее заявку подавать нельзя, это же проверяет сервер. */
let today = studioDate(Date.now(), 'Europe/Moscow');
const isPeriod = (type) => ['vacation', 'day_off', 'sick_leave'].includes(type);

// ---------------------------------------------------------------------------
// Список своих заявок
// ---------------------------------------------------------------------------

function requestCard(r) {
  const period = periodText(r);
  const decision = decisionText(r);
  return `
    <article class="day-row" data-request="${r.id}">
      <p class="day-row__time">${esc(TYPE_LABEL[r.type] ?? r.type)}</p>
      <div class="day-row__main">
        ${period ? `<p class="day-row__client">${esc(period)}</p>` : ''}
        ${r.comment ? `<p class="day-row__meta">${esc(r.comment)}</p>` : ''}
        <p class="day-row__muted">Подана ${esc(dayLabel(r.createdAt.slice(0, 10)))}</p>
        ${decision ? `<p class="day-row__muted">${esc(decision)}</p>` : ''}
        ${photoPreview(r)}
      </div>
      <p class="day-row__status">${statusBadge(r.status)}</p>
      <div class="day-row__actions">
        ${r.status === 'pending' ? '<button class="btn btn--outline btn--small" type="button" data-cancel>Отозвать</button>' : ''}
      </div>
    </article>`;
}

async function load() {
  pageLoading.hidden = false;
  pageError.hidden = true;
  try {
    const requests = await api.getMyRequests();
    const pending = requests.filter((r) => r.status === 'pending').length;
    list.innerHTML = requests.length
      ? `<p class="admin-head__summary">${requests.length} ${plural(requests.length, 'заявка', 'заявки', 'заявок')}` +
        `${pending ? `, ${pending} на рассмотрении` : ''}</p>` + requests.map(requestCard).join('')
      : `<div class="admin-state">
           <p class="admin-state__title">Заявок пока нет</p>
           <p class="admin-state__text">Подайте заявку, если нужен отпуск, отгул, больничный или другой график работы.</p>
         </div>`;
  } catch (error) {
    if (handleAccessError(error)) return;
    list.innerHTML = '';
    pageError.textContent = `Не удалось загрузить заявки. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    pageLoading.hidden = true;
  }
}

list.addEventListener('click', async (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('[data-cancel]');
  if (!(button instanceof HTMLButtonElement)) return;
  const id = Number(/** @type {HTMLElement} */ (button.closest('[data-request]')).dataset.request);
  if (!window.confirm('Отозвать заявку? Администратор ее больше не увидит.')) return;
  const done = setBusy(button, 'Отзываем…');
  try {
    await api.cancelMyRequest(id);
    await load();
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    pageError.textContent = `Не удалось отозвать заявку. ${error instanceof api.ApiError ? error.message : ''}`;
    pageError.hidden = false;
  }
});

// ---------------------------------------------------------------------------
// Новая заявка
// ---------------------------------------------------------------------------

/** Дни недели с часами: отмеченные дни попадут в новый график. */
function renderDays() {
  $('[data-days]', form).innerHTML = WEEKDAYS.map((name, i) => `
    <label class="week-day">
      <input type="checkbox" name="weekday" value="${i + 1}">
      <span class="week-day__name">${name}</span>
      <span class="week-day__hours">
        <input class="input" type="time" step="300" name="start" value="10:00" aria-label="Начало, ${name}">
        <input class="input" type="time" step="300" name="end" value="18:00" aria-label="Конец, ${name}">
      </span>
    </label>`).join('');
}

/** Поля зависят от типа: период дат, график или только текст. */
function applyType() {
  const type = typeSelect.value;
  $('[data-period]', form).hidden = !isPeriod(type);
  $('[data-schedule]', form).hidden = type !== 'schedule';
  $('[data-comment-hint]', form).textContent = type === 'other'
    ? 'Опишите просьбу: администратор решает по тексту.'
    : 'Необязательно.';
}

typeSelect.addEventListener('change', applyType);
clearOnInput(form);

$('[data-open-new]').addEventListener('click', () => {
  clearErrors(form, alert);
  form.reset();
  renderDays();
  applyType();
  fromInput.min = today;
  toInput.min = today;
  validFromInput.min = today;
  dialog.showModal();
  typeSelect.focus();
});

dialog.querySelectorAll('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => dialog.close()));
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

/** Отмеченные дни нового графика в формате API. */
const chosenDays = () => [...form.querySelectorAll('input[name="weekday"]:checked')].map((box) => {
  const row = /** @type {HTMLElement} */ (box.closest('.week-day'));
  return {
    weekday: Number(/** @type {HTMLInputElement} */ (box).value),
    start: /** @type {HTMLInputElement} */ ($('input[name="start"]', row)).value,
    end: /** @type {HTMLInputElement} */ ($('input[name="end"]', row)).value,
  };
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, alert);
  const type = typeSelect.value;
  const comment = commentInput.value.trim();
  const days = type === 'schedule' ? chosenDays() : [];

  const ok = showErrors(form, {
    startsOn: !isPeriod(type) || (fromInput.value && fromInput.value >= today) ? null
      : fromInput.value ? 'Эта дата уже прошла' : 'Укажите дату',
    endsOn: !isPeriod(type) || (toInput.value && toInput.value >= fromInput.value) ? null
      : toInput.value ? 'Последний день раньше первого' : 'Укажите дату',
    validFrom: type !== 'schedule' || (validFromInput.value && validFromInput.value >= today) ? null
      : validFromInput.value ? 'Эта дата уже прошла' : 'Укажите дату',
    days: type !== 'schedule' || (days.length && days.every((d) => d.end > d.start)) ? null
      : days.length ? 'Конец смены должен быть позже начала' : 'Отметьте хотя бы один рабочий день',
    comment: type !== 'other' || comment ? null : 'Опишите просьбу',
  });
  if (!ok) return;

  const body = {
    type,
    comment: comment || null,
    ...(isPeriod(type) ? { startsOn: fromInput.value, endsOn: toInput.value } : {}),
    ...(type === 'schedule' ? { validFrom: validFromInput.value, days } : {}),
  };
  const done = setBusy(/** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')), 'Отправляем…');
  try {
    await api.createMyRequest(body);
    dialog.close();
    setFlash('success', 'Заявка отправлена. Администратор рассмотрит ее, расписание пока не изменилось.');
    window.location.reload();
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(form, alert, error);
  }
});

// ---------------------------------------------------------------------------
// Свое фото в профиле
// ---------------------------------------------------------------------------

/** Что стоит в профиле сейчас: одобренный портрет или инициалы, как на сайте. */
function showMyPhoto(master) {
  const has = Boolean(master.photoUrl);
  photoCurrent.innerHTML = has
    ? `<img class="photo-me__image" src="${esc(master.photoUrl)}" alt="Ваше фото в профиле" width="120" height="120">`
    : `<span class="avatar" aria-hidden="true">${esc(initials(master.name))}</span>`;
  photoRemove.hidden = !has;
}

function showPhotoAlert(kind, text) {
  photoAlert.className = `alert alert--${kind}`;
  photoAlert.textContent = text;
  photoAlert.hidden = false;
}

photoForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(photoForm);
  photoAlert.hidden = true;
  const file = photoFile.files?.[0];
  if (!file) {
    setFieldError(photoForm, 'photo', 'Выберите файл');
    return;
  }
  // Тип и размер сервер проверит еще раз; здесь — чтобы не отправлять зря большой файл
  if (!api.PHOTO_TYPES.includes(file.type)) {
    setFieldError(photoForm, 'photo', 'Подойдет JPEG, PNG или WebP');
    return;
  }
  if (file.size > api.MAX_PHOTO_BYTES) {
    setFieldError(photoForm, 'photo', 'Файл больше 10 МБ');
    return;
  }
  const done = setBusy(photoSubmit, 'Отправляем…');
  try {
    await api.uploadMyPhoto(file);
    setFlash('success', 'Фото отправлено администратору. Пока он не одобрит, в профиле остается прежнее.');
    window.location.reload();
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showPhotoAlert('error', error instanceof api.ApiError ? error.message : 'Не удалось отправить фото. Попробуйте еще раз.');
  }
});

photoRemove.addEventListener('click', async () => {
  const done = setBusy(photoRemove, 'Убираем…');
  photoAlert.hidden = true;
  try {
    await api.deleteMyPhoto();
    setFlash('success', 'Фото убрано: в профиле снова ваши инициалы.');
    window.location.reload();
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showPhotoAlert('error', error instanceof api.ApiError ? error.message : 'Не удалось убрать фото.');
  }
});

clearOnInput(photoForm);

async function start() {
  try {
    today = studioDate(Date.now(), (await api.getStudio()).timezone);
  } catch {
    // Часовой пояс не загрузился — даты проверит сервер
  }
  try {
    // Имя и свое текущее фото: расписание отдает профиль мастера, отдельного эндпоинта для него нет
    const { master } = await api.getMasterSchedule();
    showMyPhoto(master);
  } catch (error) {
    if (handleAccessError(error)) return;
    showPhotoAlert('error', 'Не удалось загрузить ваше фото. Отправить новое все равно можно.');
  }
  load();
}

if (await masterReady) start();
