// A-23 Услуги (docs/ui-map.md, «Раздел администратора»): все услуги по категориям, включая отключенные,
// с пометкой «Отключена»; «+ Категория» и «+ Добавить услугу». Строка услуги ведет в форму A-24.
// Данные: GET /api/admin/services (услуги и категории), GET /api/admin/masters (имена мастеров).
// Кнопки: «+ Категория» — POST /api/admin/service-categories.
import { adminReady, handleAccessError } from './admin.js';
import * as api from './api.js';
import { clearErrors, clearOnInput, setBusy, showErrors, showServerError } from './form.js';
import { duration, escapeHtml as esc, money, plural } from './format.js';
import { routes } from './routes.js';

const list = /** @type {HTMLElement} */ (document.querySelector('[data-list]'));
const loading = /** @type {HTMLElement} */ (document.querySelector('[data-page-loading]'));
const pageError = /** @type {HTMLElement} */ (document.querySelector('[data-page-error]'));
const summary = /** @type {HTMLElement} */ (document.querySelector('[data-summary]'));
const categoryForm = /** @type {HTMLFormElement} */ (document.querySelector('[data-category-form]'));
const categoryAlert = /** @type {HTMLElement} */ (document.querySelector('[data-category-alert]'));

const badge = (on, onLabel, offLabel) =>
  `<span class="admin-badge admin-badge--${on ? 'on' : 'off'}">${on ? onLabel : offLabel}</span>`;

/**
 * @param {{ categories: any[], services: any[] }} data
 * @param {Map<number, { name: string, isActive: boolean }>} masters
 */
function render(data, masters) {
  const off = data.services.filter((s) => !s.isActive).length;
  summary.textContent = `${data.services.length} ${plural(data.services.length, 'услуга', 'услуги', 'услуг')}` +
    (off ? `, из них ${off} ${plural(off, 'отключена', 'отключены', 'отключено')}` : '');

  if (!data.categories.length) {
    list.innerHTML = `
      <div class="admin-state">
        <p class="admin-state__title">Категорий пока нет</p>
        <p class="admin-state__text">Сначала добавьте категорию — например, «Ногти» или «Брови», — затем услуги в ней.</p>
      </div>`;
    return;
  }

  list.innerHTML = data.categories.map((category) => {
    const services = data.services.filter((s) => s.categoryId === category.id);
    const rows = services.map((s) => {
      const names = s.masterIds.map((id) => masters.get(id)).filter(Boolean)
        .map((m) => (m.isActive ? esc(m.name) : `${esc(m.name)} (отключен)`));
      return `
        <tr class="${s.isActive ? '' : 'is-off'}">
          <td class="admin-table__name">
            <a href="${esc(routes.adminServiceForm(s.id))}">${esc(s.name)}</a>${s.kind === 'addon' ? '<span class="admin-badge admin-badge--addon">Опция</span>' : ''}
          </td>
          <td class="admin-table__num" data-label="Длительность">${esc(duration(s.durationMin))}${s.cleanupMin ? `<span class="admin-table__muted">уборка ${s.cleanupMin} мин</span>` : ''}</td>
          <td class="admin-table__num" data-label="Цена: мастер / топ">${esc(money(s.priceMasterKop))} / ${esc(money(s.priceTopKop))}${s.priceUnit ? `<span class="admin-table__muted">${esc(s.priceUnit)}</span>` : ''}</td>
          <td data-label="Мастера">${names.length ? names.join(', ') : '<span class="admin-table__muted">Никто — клиент не сможет записаться</span>'}</td>
          <td>${badge(s.isActive, 'Включена', 'Отключена')}</td>
        </tr>`;
    }).join('');
    return `
      <section class="admin-group" aria-labelledby="category-${category.id}">
        <h2 class="admin-group__title" id="category-${category.id}">${esc(category.name)}${category.isActive ? '' : badge(false, '', 'Категория отключена')}</h2>
        ${services.length ? `
          <table class="admin-table">
            <thead><tr><th scope="col">Название</th><th scope="col">Длительность</th><th scope="col">Цена: мастер / топ</th><th scope="col">Мастера</th><th scope="col">Статус</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>` : '<p class="admin-table__muted">В категории пока нет услуг</p>'}
      </section>`;
  }).join('');
}

async function load() {
  loading.hidden = false;
  pageError.hidden = true;
  try {
    const [data, masters] = await Promise.all([api.getAdminServices(), api.getAdminMasters()]);
    render(data, new Map(masters.map((m) => [m.id, m])));
  } catch (error) {
    if (handleAccessError(error)) return;
    pageError.textContent = `Не удалось загрузить услуги. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

// ---------- Новая категория ----------

document.querySelector('[data-add-category]')?.addEventListener('click', () => {
  categoryForm.hidden = false;
  /** @type {HTMLInputElement} */ (categoryForm.elements.namedItem('name')).focus();
});

document.querySelector('[data-category-cancel]')?.addEventListener('click', () => {
  categoryForm.reset();
  clearErrors(categoryForm, categoryAlert);
  categoryForm.hidden = true;
});

clearOnInput(categoryForm);

categoryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(categoryForm, categoryAlert);
  const name = /** @type {HTMLInputElement} */ (categoryForm.elements.namedItem('name')).value.trim();
  if (!showErrors(categoryForm, { name: name ? null : 'Введите название категории' })) return;
  const done = setBusy(/** @type {HTMLButtonElement} */ (categoryForm.querySelector('[type=submit]')), 'Добавляем…');
  try {
    await api.createServiceCategory({ name });
    categoryForm.reset();
    categoryForm.hidden = true;
    await load();
  } catch (error) {
    if (handleAccessError(error)) return;
    showServerError(categoryForm, categoryAlert, error);
  } finally {
    done();
  }
});

if (await adminReady) load();
