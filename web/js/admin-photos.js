// Фото работ в разделе администратора (паспорт, функция 8 администратора; сценарий 13).
//
// Зачем экран. Эндпоинты фото были с самого начала (`POST`, `PATCH`, `DELETE /api/admin/photos`),
// а интерфейса к ним не было вовсе: загрузить снимок в галерею можно было только запросом к API.
// В прототипе фото живут модалкой A-12 у завершенного визита (docs/ui-map.md), отдельного экрана там нет.
//
// Что здесь есть: загрузка снимков прямо в галерею (`?masterId=…&serviceId=…`), подпись, показ в галерее
// «Наши работы» и в профиле мастера, удаление. Фото, которые уже привязаны к визиту, в списке тоже видны:
// у них можно поправить подпись, отметить согласие клиента и опубликовать.
//
// Чего здесь нет: загрузки фото к услуге конкретного визита. Для нее нужен `bookingItemId` — номер строки
// услуги в записи, а записи его не отдают (docs/ui-map.md, список 3, пункт 6). Пока сервер его не отдает,
// снимок визита загружается как фото галереи: мастер и услуга выбираются руками.
//
// Данные: GET /api/admin/photos?masterId=&published= — `url`, `title`, `isPublished`, `publishConsentAt`,
// `bookingId`, `bookingItemId`, `master`, `service`, `createdAt`. Мастера — GET /api/admin/masters
// (вместе с `serviceIds`: из них собирается список услуг мастера), услуги — GET /api/admin/services.
import { adminReady, handleAccessError } from './admin.js';
import * as api from './api.js';
import { dateLabel, escapeHtml as esc, plural } from './format.js';

const $ = (selector, root = document) => /** @type {HTMLElement} */ (root.querySelector(selector));

const list = $('[data-list]');
const loading = $('[data-page-loading]');
const pageError = $('[data-page-error]');
const summary = $('[data-summary]');
const actionAlert = $('[data-action-alert]');

const uploadForm = /** @type {HTMLFormElement} */ ($('[data-upload-form]'));
const uploadMaster = /** @type {HTMLSelectElement} */ ($('[data-upload-master]'));
const uploadService = /** @type {HTMLSelectElement} */ ($('[data-upload-service]'));
const uploadTitle = /** @type {HTMLInputElement} */ ($('#upload-title'));
const uploadFiles = /** @type {HTMLInputElement} */ ($('[data-upload-files]'));
const uploadPublish = /** @type {HTMLInputElement} */ ($('[data-upload-publish]'));
const uploadSubmit = /** @type {HTMLButtonElement} */ ($('[data-upload-submit]'));
const uploadAlert = $('[data-upload-alert]');
const uploadResults = $('[data-upload-results]');

const filterMaster = /** @type {HTMLSelectElement} */ ($('[data-filter-master]'));

const dialog = /** @type {HTMLDialogElement} */ ($('[data-delete-dialog]'));
const dialogWhat = $('[data-delete-what]', dialog);
const dialogError = $('[data-delete-error]', dialog);
const dialogConfirm = /** @type {HTMLButtonElement} */ ($('[data-delete-confirm]', dialog));

const state = {
  /** '' — все мастера */
  masterId: '',
  /** '' — все; 'true' — только в галерее; 'false' — только не в галерее */
  published: '',
  timezone: 'Europe/Moscow',
  /** Мастера из GET /api/admin/masters */
  masters: [],
  /** Услуги по номеру: id → { id, name } */
  services: new Map(),
};

/** Фото, которое сейчас спрашиваем удалить. */
let pending = null;

const MB = 1024 * 1024;

// ---------- Списки мастеров и услуг ----------

/** Услуги мастера в том порядке, в каком они идут в каталоге. */
function masterServices(masterId) {
  const master = state.masters.find((m) => m.id === masterId);
  if (!master) return [];
  return master.serviceIds.map((id) => state.services.get(id)).filter(Boolean);
}

/** Список услуг в форме загрузки: меняется вслед за выбранным мастером. */
function fillServices() {
  const masterId = Number(uploadMaster.value);
  const services = masterServices(masterId);
  const previous = uploadService.value;
  uploadService.innerHTML = '<option value="">Не указывать</option>'
    + services.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  // Та же услуга у нового мастера — оставляем выбранной
  if (previous && services.some((s) => String(s.id) === previous)) uploadService.value = previous;
}

function fillMasters() {
  const options = state.masters
    .map((m) => `<option value="${m.id}">${esc(m.name)}${m.isActive ? '' : ' — отключен'}</option>`)
    .join('');
  uploadMaster.innerHTML = options;
  filterMaster.innerHTML = '<option value="">Все мастера</option>' + options;
  fillServices();
}

// ---------- Список фото ----------

/** Откуда фото: загружено в галерею руками или снято на визите. */
const sourceBadge = (photo) => (photo.bookingItemId === null
  ? ''
  : `<span class="admin-badge admin-badge--addon">С визита №${photo.bookingId}</span>`);

/**
 * Карточка снимка. Файл берем по `photo.url` (`/api/photos/:id/file`): неопубликованный отдается
 * только администратору, поэтому на этой странице видны и скрытые фото.
 */
function tile(photo) {
  const visit = photo.bookingItemId !== null;
  const consent = photo.publishConsentAt !== null;
  return `
    <article class="photo-tile${photo.isPublished ? '' : ' is-off'}" data-photo="${photo.id}">
      <img class="photo-tile__image" src="${esc(photo.url)}" alt="${esc(photo.title || 'Работа мастера ' + photo.master.name)}"
        loading="lazy" width="320" height="240">
      <div class="photo-tile__body">
        <div class="photo-tile__row">
          ${photo.isPublished
            ? '<span class="admin-badge admin-badge--on">В галерее</span>'
            : '<span class="admin-badge admin-badge--off">Не в галерее</span>'}
          ${sourceBadge(photo)}
        </div>

        <p class="photo-tile__meta">${esc(photo.master.name)}${photo.service ? ' · ' + esc(photo.service.name) : ''}</p>
        <p class="photo-tile__meta">Загружено ${esc(dateLabel(photo.createdAt, state.timezone))}</p>

        <div class="field">
          <label class="field__label" for="photo-title-${photo.id}">Подпись</label>
          <input class="input" id="photo-title-${photo.id}" value="${esc(photo.title ?? '')}" maxlength="200"
            autocomplete="off" data-title-input>
        </div>

        ${visit ? `
          <div class="check">
            <label class="check__label">
              <input type="checkbox" data-consent${consent ? ' checked' : ''}>
              <span>Клиент разрешил публикацию</span>
            </label>
          </div>
          ${consent ? '' : '<p class="photo-tile__note">Без согласия клиента фото с визита в галерею не попадет.</p>'}
        ` : ''}

        <div class="photo-tile__row">
          <button class="btn btn--small ${photo.isPublished ? 'btn--outline' : 'btn--primary'}" type="button"
            data-action="publish" data-next="${photo.isPublished ? 'false' : 'true'}">
            ${photo.isPublished ? 'Убрать из галереи' : 'Показать в галерее'}
          </button>
          <button class="btn btn--small btn--outline" type="button" data-action="save" hidden>Сохранить подпись</button>
          <button class="btn btn--small btn--danger" type="button" data-action="delete">Удалить</button>
        </div>
        <p class="alert alert--error" role="alert" data-tile-error hidden></p>
      </div>
    </article>`;
}

function render(photos) {
  const inGallery = photos.filter((p) => p.isPublished).length;
  summary.textContent = photos.length
    ? `${photos.length} ${plural(photos.length, 'фото', 'фото', 'фото')} · ${inGallery} в галерее`
    : '';

  if (!photos.length) {
    const filtered = state.masterId !== '' || state.published !== '';
    list.innerHTML = `
      <div class="admin-state">
        <p class="admin-state__title">${filtered ? 'Под фильтр ничего не подошло' : 'Фото пока нет'}</p>
        <p class="admin-state__text">${filtered
          ? 'Снимите фильтр или выберите другого мастера.'
          : 'Загрузите первые снимки — они появятся в галерее «Наши работы» на главной и в профиле мастера.'}</p>
      </div>`;
    return;
  }

  list.innerHTML = `<div class="photo-tiles">${photos.map(tile).join('')}</div>`;
}

async function load() {
  loading.hidden = false;
  pageError.hidden = true;
  try {
    const photos = await api.getAdminPhotos({
      ...(state.masterId === '' ? {} : { masterId: Number(state.masterId) }),
      ...(state.published === '' ? {} : { published: state.published === 'true' }),
    });
    render(photos);
  } catch (error) {
    if (handleAccessError(error)) return;
    list.innerHTML = '';
    summary.textContent = '';
    pageError.textContent = `Не удалось загрузить фото. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

// ---------- Загрузка ----------

function showFieldError(field, text) {
  const slot = $(`[data-error-for="${field}"]`, uploadForm);
  if (!slot) return;
  slot.textContent = text;
  slot.hidden = false;
}

function clearFieldErrors() {
  for (const slot of uploadForm.querySelectorAll('[data-error-for]')) {
    /** @type {HTMLElement} */ (slot).hidden = true;
  }
  uploadAlert.hidden = true;
}

/** Что не так с файлом до отправки: тип и размер сервер проверит еще раз, но зря запрос не делаем. */
function fileProblem(file) {
  if (!api.PHOTO_TYPES.includes(file.type)) return 'не JPEG, PNG или WebP';
  if (file.size > api.MAX_PHOTO_BYTES) return `${(file.size / MB).toFixed(1)} МБ — больше 10 МБ`;
  if (file.size === 0) return 'пустой файл';
  return null;
}

function addResult(kind, text) {
  const item = document.createElement('li');
  item.className = `upload-results__item upload-results__item--${kind}`;
  item.textContent = text;
  uploadResults.append(item);
  uploadResults.hidden = false;
}

uploadMaster.addEventListener('change', fillServices);

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFieldErrors();
  uploadResults.replaceChildren();
  uploadResults.hidden = true;

  const masterId = Number(uploadMaster.value);
  if (!masterId) {
    showFieldError('masterId', 'Выберите мастера: без него фото не привязать к профилю.');
    return;
  }
  const files = [...(uploadFiles.files ?? [])];
  if (!files.length) {
    showFieldError('files', 'Выберите хотя бы один файл.');
    return;
  }

  const serviceId = uploadService.value ? Number(uploadService.value) : undefined;
  const title = uploadTitle.value.trim();
  const publish = uploadPublish.checked;

  uploadSubmit.disabled = true;
  uploadSubmit.textContent = 'Загружаем…';
  let done = 0;

  for (const file of files) {
    const problem = fileProblem(file);
    if (problem) {
      addResult('error', `${file.name}: ${problem}`);
      continue;
    }
    try {
      const photo = await api.uploadPhoto(file, {
        masterId,
        ...(serviceId === undefined ? {} : { serviceId }),
        ...(title ? { title } : {}),
      });
      // Загруженное фото в галерее еще не показывается: публикуем отдельным запросом.
      if (publish) await api.updatePhoto(photo.id, { isPublished: true });
      addResult('success', `${file.name}: загружено${publish ? ' и показано в галерее' : ''}`);
      done++;
    } catch (error) {
      if (handleAccessError(error)) return;
      addResult('error', `${file.name}: ${error instanceof api.ApiError ? error.message : 'не удалось загрузить'}`);
    }
  }

  uploadSubmit.disabled = false;
  uploadSubmit.textContent = 'Загрузить';

  if (done) {
    uploadFiles.value = '';
    uploadAlert.className = 'alert alert--success';
    uploadAlert.textContent = `Загружено ${done} ${plural(done, 'фото', 'фото', 'фото')}.`
      + (publish ? ' Проверьте галерею на главной.' : ' Чтобы показать в галерее, нажмите «Показать в галерее» у снимка.');
    uploadAlert.hidden = false;
    await load();
  }
});

// ---------- Фильтры ----------

filterMaster.addEventListener('change', () => {
  state.masterId = filterMaster.value;
  load();
});

for (const input of document.querySelectorAll('input[name="published"]')) {
  input.addEventListener('change', () => {
    state.published = /** @type {HTMLInputElement} */ (input).value;
    load();
  });
}

// ---------- Действия у снимка ----------

function showAlert(kind, text) {
  actionAlert.className = `alert alert--${kind}`;
  actionAlert.textContent = text;
  actionAlert.hidden = false;
}

function tileError(card, text) {
  const slot = $('[data-tile-error]', card);
  slot.textContent = text;
  slot.hidden = false;
}

/** Подпись меняем только по кнопке: кнопка появляется, когда текст отличается от сохраненного. */
list.addEventListener('input', (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  if (!input.matches('[data-title-input]')) return;
  const card = input.closest('[data-photo]');
  const save = /** @type {HTMLButtonElement} */ ($('[data-action="save"]', card));
  save.hidden = input.value === input.defaultValue;
});

list.addEventListener('click', async (event) => {
  const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-action]'));
  if (!button) return;
  const card = /** @type {HTMLElement} */ (button.closest('[data-photo]'));
  const id = Number(card.dataset.photo);
  actionAlert.hidden = true;
  $('[data-tile-error]', card).hidden = true;

  if (button.dataset.action === 'delete') {
    const titleInput = /** @type {HTMLInputElement} */ ($('[data-title-input]', card));
    pending = { id, title: titleInput.defaultValue };
    dialogWhat.textContent = titleInput.defaultValue || 'Снимок без подписи';
    dialogError.hidden = true;
    dialogConfirm.disabled = false;
    dialogConfirm.textContent = 'Удалить фото';
    dialog.showModal();
    return;
  }

  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Сохраняем…';
  try {
    if (button.dataset.action === 'publish') {
      await api.updatePhoto(id, { isPublished: button.dataset.next === 'true' });
      showAlert('success', button.dataset.next === 'true'
        ? 'Фото показано в галерее «Наши работы» и в профиле мастера.'
        : 'Фото убрано из галереи. Сам снимок остался здесь.');
    } else {
      const input = /** @type {HTMLInputElement} */ ($('[data-title-input]', card));
      const value = input.value.trim();
      await api.updatePhoto(id, { title: value === '' ? null : value });
      showAlert('success', 'Подпись сохранена.');
    }
    await load();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    if (handleAccessError(error)) return;
    tileError(card, error instanceof api.ApiError ? error.message : 'Не удалось сохранить. Попробуйте еще раз.');
  }
});

// Согласие клиента есть только у фото с визита: снятое согласие снимает и публикацию.
list.addEventListener('change', async (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  if (!input.matches('[data-consent]')) return;
  const card = /** @type {HTMLElement} */ (input.closest('[data-photo]'));
  const id = Number(card.dataset.photo);
  input.disabled = true;
  try {
    await api.updatePhoto(id, { publishConsent: input.checked });
    showAlert('success', input.checked
      ? 'Согласие клиента отмечено — фото можно показать в галерее.'
      : 'Согласие снято, и фото убрано из галереи.');
    await load();
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    if (handleAccessError(error)) return;
    tileError(card, error instanceof api.ApiError ? error.message : 'Не удалось сохранить согласие.');
  }
});

$('[data-delete-cancel]', dialog).addEventListener('click', () => dialog.close());

dialogConfirm.addEventListener('click', async () => {
  if (!pending) return;
  dialogConfirm.disabled = true;
  dialogConfirm.textContent = 'Удаляем…';
  dialogError.hidden = true;
  try {
    await api.deletePhoto(pending.id);
    const { title } = pending;
    pending = null;
    dialog.close();
    showAlert('success', `Фото удалено${title ? `: ${title}` : ''}. Файл с диска тоже удален.`);
    await load();
  } catch (error) {
    dialogConfirm.disabled = false;
    dialogConfirm.textContent = 'Удалить фото';
    if (handleAccessError(error)) return;
    dialogError.textContent = error instanceof api.ApiError ? error.message : 'Не удалось удалить фото. Попробуйте еще раз.';
    dialogError.hidden = false;
  }
});

// ---------- Старт ----------

async function start() {
  const [studio, masters, services] = await Promise.all([
    api.getStudio().catch(() => null),
    api.getAdminMasters(),
    api.getAdminServices(),
  ]);
  if (studio) state.timezone = studio.timezone;
  state.masters = masters;
  // GET /api/admin/services отдает услуги плоским списком `services` (у публичного /api/services
  // они вложены в категории), и в нем есть отключенные: у старых фото услуга может быть именно такой.
  for (const service of services.services) state.services.set(service.id, { id: service.id, name: service.name });
  fillMasters();
  await load();
}

if (await adminReady) {
  start().catch((error) => {
    if (handleAccessError(error)) return;
    pageError.textContent = `Не удалось открыть экран. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
    loading.hidden = true;
  });
}
