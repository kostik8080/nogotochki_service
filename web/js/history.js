// CAB-02 История (docs/ui-map.md): прошедшие и отмененные визиты — GET /api/bookings?period=past.
// Фильтры «Все / Завершенные / Отмененные» — в браузере по уже загруженному списку («Отмененные» — две отмены сразу,
// одним запросом API их не получить). «Повторить» у завершенного — шаг «Время» с услугами и мастером записи.
import * as api from './api.js';
import { bookingServices } from './calendar.js';
import { dateLabel, escapeHtml as esc, timeLabel } from './format.js';
import { routes } from './routes.js';

const $ = (selector) => document.querySelector(selector);

const list = /** @type {HTMLElement} */ ($('[data-list]'));
const filtersBox = /** @type {HTMLElement} */ ($('[data-filters]'));

const STATUS = {
  completed: { label: 'Завершена', cls: 'badge--completed' },
  cancelled_by_client: { label: 'Отменена вами', cls: 'badge--cancelled' },
  cancelled_by_studio: { label: 'Отменена студией', cls: 'badge--cancelled' },
  no_show: { label: 'Неявка', cls: 'badge--no-show' },
  // Действующая запись, время которой уже прошло, но студия еще не отметила визит
  active: { label: 'Ждет отметки студии', cls: 'badge--completed' },
};

const FILTERS = {
  all: () => true,
  completed: (b) => b.status === 'completed',
  cancelled: (b) => b.status === 'cancelled_by_client' || b.status === 'cancelled_by_studio',
};

let bookings = [];
let studio = null;
let filter = 'all';

const repeatHref = (b) => routes.bookingTime({
  services: b.items.map((i) => (i.quantity > 1 ? `${i.serviceId}:${i.quantity}` : String(i.serviceId))).join(','),
  master: b.master.id,
});

function render() {
  filtersBox.querySelectorAll('[data-filter]').forEach((button) =>
    button.setAttribute('aria-pressed', String(button.getAttribute('data-filter') === filter)));

  if (!bookings.length) {
    filtersBox.hidden = true;
    list.innerHTML = `
      <div class="state-card">
        <p class="state-card__title">Здесь появятся ваши прошедшие визиты</p>
        <a class="btn btn--primary btn--small" href="${esc(routes.booking())}">Записаться</a>
      </div>`;
    return;
  }
  filtersBox.hidden = false;
  const shown = bookings.filter(FILTERS[filter]);
  if (!shown.length) {
    list.innerHTML = `<p class="history-empty">${filter === 'completed' ? 'Завершенных визитов пока нет.' : 'Отмененных визитов нет.'}</p>`;
    return;
  }
  const tz = studio.timezone;
  list.innerHTML = shown.map((b) => {
    const status = STATUS[b.status] ?? { label: b.status, cls: '' };
    return `
      <article class="history-item">
        <div class="history-item__head">
          <div>
            <p class="booking-row__when">${esc(dateLabel(b.startsAt, tz))}, ${esc(timeLabel(b.startsAt, tz))}</p>
            <p class="booking-row__meta">${esc(bookingServices(b))} · ${esc(b.master.name)}</p>
          </div>
          <span class="badge ${status.cls}">${esc(status.label)}</span>
        </div>
        <div class="history-item__actions">
          ${b.status === 'completed' ? `<a class="btn btn--outline btn--small" href="${esc(repeatHref(b))}">Повторить</a>` : ''}
          <a class="text-link" href="${esc(routes.bookingCard(b.id))}">Подробнее</a>
        </div>
      </article>`;
  }).join('');
}

filtersBox.addEventListener('click', (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('[data-filter]');
  if (!button) return;
  filter = button.getAttribute('data-filter');
  render();
});

async function load() {
  list.setAttribute('aria-busy', 'true');
  try {
    const user = await api.getMe();
    if (!user) return window.location.replace(`${routes.login}?next=${encodeURIComponent(routes.history)}`);
    if (user.role !== 'client') return window.location.replace(routes.home);
    [bookings, studio] = await Promise.all([api.getBookings({ period: 'past' }), api.getStudio()]);
    render();
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 401) {
      window.location.replace(`${routes.login}?next=${encodeURIComponent(routes.history)}`);
      return;
    }
    list.innerHTML = `
      <div class="state-card" role="alert">
        <p class="state-card__title">Не удалось загрузить историю</p>
        <p class="state-card__text">${esc(error instanceof api.ApiError ? error.message : 'Что-то пошло не так. Обновите страницу.')}</p>
        <button class="btn btn--primary btn--small" type="button" data-retry>Обновить</button>
      </div>`;
    list.querySelector('[data-retry]').addEventListener('click', load);
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

load();
