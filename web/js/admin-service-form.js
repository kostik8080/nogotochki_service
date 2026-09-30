// A-24 Форма услуги (docs/ui-map.md, «Раздел администратора»): /admin/services/form — новая услуга,
// ?id=5 — изменение. Название, описание, категория, длительность и уборка, цены у мастера и у топ-мастера,
// мастера, которые ее оказывают, «Включена»; «Удалить».
// Данные: GET /api/admin/services, GET /api/admin/masters.
// Кнопки: «Сохранить» — POST /api/admin/services или PATCH /api/admin/services/:id;
// «Удалить» — DELETE /api/admin/services/:id: удалить или только отключить, решает сервер.
// Проверка здесь — для удобства: сервер проверяет те же правила сам (пустое название, цена и длительность > 0).
import { adminReady, handleAccessError, setFlash } from './admin.js';
import * as api from './api.js';
import { clearErrors, clearOnInput, setBusy, showAlert, showErrors, showServerError } from './form.js';
import { escapeHtml as esc } from './format.js';
import { routes } from './routes.js';

const form = /** @type {HTMLFormElement} */ (document.querySelector('[data-form]'));
const alert = /** @type {HTMLElement} */ (form.querySelector('[data-alert]'));
const loading = /** @type {HTMLElement} */ (document.querySelector('[data-page-loading]'));
const pageError = /** @type {HTMLElement} */ (document.querySelector('[data-page-error]'));
const title = /** @type {HTMLElement} */ (document.querySelector('[data-title]'));
const statusSlot = /** @type {HTMLElement} */ (document.querySelector('[data-status]'));
const deleteButton = /** @type {HTMLButtonElement} */ (form.querySelector('[data-delete]'));
const field = (name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name));

const idParam = new URLSearchParams(window.location.search).get('id');
const serviceId = idParam && /^\d+$/.test(idParam) ? Number(idParam) : null;
/** Услуга, какой ее отдал сервер; null — новая. */
let service = null;

const rub = (kop) => String(kop / 100);
/** «1800» или «1800,50» в рублях → копейки; не число — NaN. */
const kop = (value) => Math.round(Number(String(value).replace(',', '.').trim()) * 100);

function showStatus() {
  statusSlot.innerHTML = service
    ? `<span class="admin-badge admin-badge--${service.isActive ? 'on' : 'off'}">${service.isActive ? 'Включена' : 'Отключена'}</span>`
    : '';
}

/** @param {{ categories: any[], services: any[] }} data @param {any[]} masters */
function fill(data, masters) {
  const categories = /** @type {HTMLSelectElement} */ (field('categoryId'));
  categories.innerHTML = data.categories.map((c) =>
    `<option value="${c.id}">${esc(c.name)}${c.isActive ? '' : ' (категория отключена)'}</option>`).join('');

  const selected = new Set(service?.masterIds ?? []);
  /** @type {HTMLElement} */ (form.querySelector('[data-masters]')).innerHTML = masters.length
    ? masters.map((m) => `
        <label class="check__label">
          <input type="checkbox" name="masterIds" value="${m.id}"${selected.has(m.id) ? ' checked' : ''}>
          <span class="admin-checks__text">${esc(m.name)}${m.isActive ? '' : '<span class="admin-badge admin-badge--off">Отключен</span>'}</span>
        </label>`).join('')
    : '<p class="admin-panel__hint">Мастеров пока нет — добавьте их в разделе «Мастера».</p>';

  if (service) {
    title.textContent = service.name;
    document.title = `${service.name} — раздел администратора — Ноготочки`;
    field('name').value = service.name;
    field('description').value = service.description ?? '';
    categories.value = String(service.categoryId);
    field('durationMin').value = String(service.durationMin);
    field('cleanupMin').value = String(service.cleanupMin);
    field('priceMasterKop').value = rub(service.priceMasterKop);
    field('priceTopKop').value = rub(service.priceTopKop);
    field('isActive').checked = service.isActive;
    /** @type {HTMLElement} */ (form.querySelector('[data-addon-note]')).hidden = service.kind !== 'addon';
    deleteButton.hidden = false;
  } else {
    title.textContent = 'Новая услуга';
    document.title = 'Новая услуга — раздел администратора — Ноготочки';
    field('cleanupMin').value = '15';
    field('isActive').checked = true;
  }
  showStatus();
}

/** Значения формы в формате API. */
function values() {
  const description = field('description').value.trim();
  return {
    name: field('name').value.trim(),
    description: description || null,
    categoryId: Number(field('categoryId').value),
    durationMin: Number(field('durationMin').value),
    cleanupMin: field('cleanupMin').value.trim() === '' ? 0 : Number(field('cleanupMin').value),
    priceMasterKop: kop(field('priceMasterKop').value),
    priceTopKop: kop(field('priceTopKop').value),
    masterIds: [...form.querySelectorAll('input[name="masterIds"]:checked')].map((i) => Number(/** @type {HTMLInputElement} */ (i).value)),
    isActive: field('isActive').checked,
  };
}

/** Те же правила, что у сервера: название не пустое, длительность и цены больше нуля. */
function validate(v) {
  const positiveInt = (n) => Number.isInteger(n) && n > 0;
  return showErrors(form, {
    name: v.name ? null : 'Введите название услуги',
    categoryId: v.categoryId ? null : 'Сначала добавьте категорию на странице «Услуги»',
    durationMin: positiveInt(v.durationMin) && v.durationMin <= 600 ? null : 'Длительность — целое число минут больше нуля, не больше 600',
    cleanupMin: Number.isInteger(v.cleanupMin) && v.cleanupMin >= 0 && v.cleanupMin <= 60 ? null : 'Уборка — от 0 до 60 минут',
    priceMasterKop: positiveInt(v.priceMasterKop) ? null : 'Цена должна быть больше нуля',
    priceTopKop: !positiveInt(v.priceTopKop) ? 'Цена должна быть больше нуля'
      : v.priceTopKop < v.priceMasterKop ? 'Цена у топ-мастера не может быть ниже цены у мастера' : null,
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, alert);
  const v = values();
  if (!validate(v)) return;
  const done = setBusy(/** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')), 'Сохраняем…');
  try {
    if (service) await api.updateService(service.id, v);
    else await api.createService({ ...v, kind: 'main' });
    setFlash('success', service ? `Услуга «${v.name}» сохранена` : `Услуга «${v.name}» добавлена`);
    window.location.assign(routes.adminServices);
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(form, alert, error);
  }
});

deleteButton.addEventListener('click', async () => {
  if (!service) return;
  if (!window.confirm(`Удалить услугу «${service.name}»?\n\nЕсли у нее есть записи, сервер не удалит ее, а отключит.`)) return;
  clearErrors(form, alert);
  const done = setBusy(deleteButton, 'Удаляем…');
  try {
    const answer = await api.deleteService(service.id);
    if (answer.result === 'deleted') {
      setFlash('success', `Услуга «${service.name}» удалена`);
      window.location.assign(routes.adminServices);
      return;
    }
    // Есть записи или фото: услуга только отключена — объясняем и показываем новый статус
    service = answer.service;
    field('isActive').checked = false;
    showStatus();
    showAlert(alert, 'warning', answer.message);
    alert.scrollIntoView({ block: 'nearest' });
    done();
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(form, alert, error);
  }
});

clearOnInput(form);

async function load() {
  try {
    const [data, masters] = await Promise.all([api.getAdminServices(), api.getAdminMasters()]);
    if (serviceId !== null) {
      service = data.services.find((s) => s.id === serviceId) ?? null;
      if (!service) {
        pageError.textContent = 'Услуга не найдена. Возможно, ее уже удалили.';
        pageError.hidden = false;
        return;
      }
    }
    fill(data, masters);
    form.hidden = false;
  } catch (error) {
    if (handleAccessError(error)) return;
    pageError.textContent = `Не удалось загрузить услугу. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

if (await adminReady) load();
