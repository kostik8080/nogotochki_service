// A-19 Мастера (docs/ui-map.md, «Раздел администратора»): все мастера, включая отключенных, с пометкой
// «Отключен»; имя, специализация и уровень, рабочие дни и часы, число услуг, записей сегодня; «+ Добавить мастера».
// Карточка ведет в A-22.
// Данные: GET /api/admin/masters; GET /api/studio (часовой пояс — «сегодня» студии);
// GET /api/admin/bookings за сегодня — записи мастера без отмененных.
import { adminReady, handleAccessError, schedulePeriods, studioToday } from './admin.js';
import * as api from './api.js';
import { escapeHtml as esc, initials, plural } from './format.js';
import { routes } from './routes.js';

const list = /** @type {HTMLElement} */ (document.querySelector('[data-list]'));
const loading = /** @type {HTMLElement} */ (document.querySelector('[data-page-loading]'));
const pageError = /** @type {HTMLElement} */ (document.querySelector('[data-page-error]'));
const summary = /** @type {HTMLElement} */ (document.querySelector('[data-summary]'));

const LEVEL = { master: 'Мастер', top_master: 'Топ-мастер' };
const CANCELLED = new Set(['cancelled_by_client', 'cancelled_by_studio']);

async function load() {
  try {
    const studio = await api.getStudio();
    const today = studioToday(studio.timezone);
    const [masters, day] = await Promise.all([
      api.getAdminMasters(),
      api.getAdminBookings({ dateFrom: today, dateTo: today, limit: 500 }),
    ]);
    const todayCount = new Map();
    for (const b of day.bookings) {
      if (!CANCELLED.has(b.status)) todayCount.set(b.master.id, (todayCount.get(b.master.id) ?? 0) + 1);
    }

    const off = masters.filter((m) => !m.isActive).length;
    summary.textContent = `${masters.length} ${plural(masters.length, 'мастер', 'мастера', 'мастеров')}` +
      (off ? `, из них ${off} ${plural(off, 'отключен', 'отключены', 'отключено')}` : '');

    if (!masters.length) {
      list.innerHTML = `
        <div class="admin-state">
          <p class="admin-state__title">Мастеров пока нет</p>
          <p class="admin-state__text">Добавьте мастера и отметьте, какие услуги он выполняет.</p>
        </div>`;
      return;
    }

    list.innerHTML = masters.map((m) => {
      const current = schedulePeriods(m.schedule, today).find((p) => p.current);
      const count = todayCount.get(m.id) ?? 0;
      return `
        <a class="master-tile${m.isActive ? '' : ' is-off'}" href="${esc(routes.adminMasterCard(m.id))}">
          <span class="master-tile__head">
            <span class="avatar" aria-hidden="true">${esc(initials(m.name))}</span>
            <span>
              <span class="master-tile__name">${esc(m.name)}</span><br>
              <span class="master-tile__sub">${m.specialty ? `${esc(m.specialty)} · ` : ''}${LEVEL[m.level] ?? esc(m.level)}</span>
            </span>
          </span>
          <span class="master-tile__row">
            <span class="admin-badge admin-badge--${m.isActive ? 'on' : 'off'}">${m.isActive ? 'Активен' : 'Отключен'}</span>
            <span class="master-tile__meta">${current ? `${esc(current.days)} · ${esc(current.hours)}` : 'График не задан'}</span>
          </span>
          <span class="master-tile__meta">Услуг: ${m.serviceIds.length} · Записей сегодня: <strong>${count}</strong></span>
        </a>`;
    }).join('');
  } catch (error) {
    if (handleAccessError(error)) return;
    pageError.textContent = `Не удалось загрузить мастеров. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

if (await adminReady) load();
