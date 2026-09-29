// CAB-01 Мои записи (docs/ui-map.md). Данные: GET /api/auth/me (имя), GET /api/bookings (все записи —
// нужны и для сообщения студии: отмененная запись в «предстоящие» не попадает), GET /api/studio (адрес,
// телефон, часовой пояс, срок правила 24 часов), GET /api/services (популярные услуги — только если записей нет).
// Кнопка ✕ у сообщения студии → POST /api/bookings/:id/acknowledge. Без входа — на вход с возвратом сюда.
import * as api from './api.js';
import {
  countdown, dateLabel, dateLong, escapeHtml as esc, money, phone as formatPhone, phoneHref, plural, timeLabel,
} from './format.js';
import { announceAcknowledged, onAcknowledged, studioChangeText } from './notifications.js';
import { routes } from './routes.js';

const $ = (selector) => document.querySelector(selector);

const views = {
  loading: /** @type {HTMLElement} */ ($('[data-view="loading"]')),
  error: /** @type {HTMLElement} */ ($('[data-view="error"]')),
  content: /** @type {HTMLElement} */ ($('[data-view="content"]')),
};

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

/** На вход, а после входа — обратно сюда. */
function goLogin() {
  window.location.replace(`${routes.login}?next=${encodeURIComponent(routes.account)}`);
}

const isAuthError = (error) => error instanceof api.ApiError && error.status === 401;

// ---------- Данные записи для показа ----------

/** «Маникюр с покрытием гель-лаком, Дизайн ногтей ×2» */
const servicesText = (b) => b.items.map((i) => (i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name)).join(', ');

/** Услуги записи в формате API для повторной записи: «1,3:2» */
const servicesParam = (b) => b.items.map((i) => (i.quantity > 1 ? `${i.serviceId}:${i.quantity}` : String(i.serviceId))).join(',');

const isUpcoming = (b, now) => b.status === 'active' && Date.parse(b.startsAt) >= now;

// ---------- Отрисовка ----------

function renderStudioChanges(bookings, tz) {
  const container = $('[data-studio-changes]');
  const changed = bookings.filter((b) => b.studioChange);
  container.innerHTML = changed.map((b) => `
      <div class="notice" data-notice="${b.id}">
        <span><a href="${esc(routes.bookingCard(b.id))}">${esc(studioChangeText(b, tz))}</a><span class="notice__error" role="alert" hidden></span></span>
        <button class="notice__close" type="button" aria-label="Закрыть сообщение" data-acknowledge="${b.id}">✕</button>
      </div>`).join('');

  container.querySelectorAll('[data-acknowledge]').forEach((button) => {
    button.addEventListener('click', async () => {
      const notice = button.closest('.notice');
      const error = notice.querySelector('.notice__error');
      button.disabled = true;
      error.hidden = true;
      try {
        await api.acknowledgeBooking(Number(button.dataset.acknowledge));
        notice.remove();
        announceAcknowledged(Number(button.dataset.acknowledge));
      } catch (e) {
        if (isAuthError(e)) return goLogin();
        error.textContent = `Не удалось закрыть сообщение. ${e.message}`;
        error.hidden = false;
        button.disabled = false;
      }
    });
  });
}

// Сообщение закрыли в колокольчике шапки — убираем его и здесь
onAcknowledged((bookingId) => document.querySelector(`[data-notice="${bookingId}"]`)?.remove());

function badge(b) {
  return b.canChange
    ? '<span class="badge badge--active">Предстоит</span>'
    : '<span class="badge badge--soon">Скоро</span>';
}

function renderNearest(b, studio) {
  const tz = studio.timezone;
  const hours = studio.rules.clientChangeDeadlineHours;
  const deadline = hours === 24 ? '24 часа' : `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const actions = b.canChange
    ? `<a class="btn btn--neutral btn--small" href="${esc(routes.reschedule(b.id))}">Перенести</a>
       <a class="btn btn--danger btn--small" href="${esc(routes.bookingCard(b.id, { cancel: true }))}">Отменить</a>`
    : '';
  const note = b.canChange ? '' : `
    <p class="booking-card__note">Онлайн-отмена и перенос доступны не позднее чем за ${esc(deadline)} до визита.
      Позвоните в салон: <a class="text-link" href="${esc(phoneHref(studio.phone))}">${esc(formatPhone(studio.phone))}</a></p>`;
  return `
    <article class="booking-card" aria-label="Ближайшая запись">
      <div class="booking-card__head">
        <div>
          <p class="booking-card__when">${esc(dateLabel(b.startsAt, tz))}, ${esc(timeLabel(b.startsAt, tz))}</p>
          <p class="booking-card__countdown">${esc(countdown(b.startsAt))}</p>
        </div>
        ${badge(b)}
      </div>
      <p class="booking-card__services">${esc(servicesText(b))}</p>
      <p class="booking-card__meta">${esc(b.master.name)} · ${esc(studio.address)}</p>
      <div class="booking-card__actions">
        ${actions}
        <a class="btn btn--outline btn--small" href="${esc(routes.bookingCard(b.id))}">Подробнее</a>
      </div>
      ${note}
    </article>`;
}

function renderRow(b, tz) {
  return `
    <a class="booking-row" href="${esc(routes.bookingCard(b.id))}">
      <span>
        <span class="booking-row__when">${esc(dateLabel(b.startsAt, tz))}, ${esc(timeLabel(b.startsAt, tz))}</span><br>
        <span class="booking-row__meta">${esc(servicesText(b))} · ${esc(b.master.name)}</span>
      </span>
      ${badge(b)}
    </a>`;
}

/** Предстоящих визитов нет, но записи были: последний завершенный визит и «Повторить». */
function renderNoUpcoming(past, tz) {
  const last = past.find((b) => b.status === 'completed');
  const lastBlock = last ? `
    <div class="last-visit">
      <p class="last-visit__services">${esc(servicesText(last))}</p>
      <p class="last-visit__meta">${esc(last.master.name)} · ${esc(dateLong(last.startsAt, tz))}</p>
      <a class="btn btn--primary btn--small btn--block"
         href="${esc(routes.bookingTime({ services: servicesParam(last), master: last.master.id }))}">Повторить последний визит</a>
    </div>` : '';
  return `
    <div class="state-card">
      <p class="state-card__title">Предстоящих визитов нет</p>
      ${lastBlock}
      <a class="btn btn--primary btn--small" href="${esc(routes.booking())}">Новая запись</a>
    </div>`;
}

/** Записей нет совсем: «Записаться» и популярные услуги. Каталог грузится только в этом случае. */
async function renderNoBookings() {
  const container = $('[data-empty]');
  container.innerHTML = `
    <div class="state-card">
      <span class="state-card__icon" aria-hidden="true"><svg><use href="#icon-calendar-x"/></svg></span>
      <p class="state-card__title">У вас пока нет записей</p>
      <a class="btn btn--primary" href="${esc(routes.booking())}">Записаться</a>
      <div class="popular" data-popular aria-busy="true">
        <span class="skeleton skeleton--row" aria-hidden="true"></span>
      </div>
    </div>`;
  const popular = container.querySelector('[data-popular]');
  try {
    const catalog = await api.getServices();
    const featured = catalog.categories.flatMap((c) => c.services).filter((s) => s.kind === 'main' && s.isFeatured).slice(0, 3);
    popular.innerHTML = featured.map((s) => {
      const price = s.priceTopKop > s.priceMasterKop ? `от ${money(s.priceMasterKop)}` : money(s.priceMasterKop);
      return `
        <a class="popular__item" href="${esc(routes.bookingMaster(String(s.id)))}">
          <span>${esc(s.name)}</span><span class="popular__price">${esc(price)}</span>
        </a>`;
    }).join('');
  } catch (error) {
    popular.innerHTML = `<p class="state-card__text" role="alert">Не удалось загрузить популярные услуги. ${esc(error.message)}</p>`;
  } finally {
    popular.setAttribute('aria-busy', 'false');
  }
}

function render(user, bookings, studio) {
  const tz = studio.timezone;
  const now = Date.now();
  $('[data-greeting]').textContent = `Здравствуйте, ${user.name}`;

  renderStudioChanges(bookings, tz);

  const upcoming = bookings.filter((b) => isUpcoming(b, now)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = bookings.filter((b) => !isUpcoming(b, now)).sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));

  const upcomingBox = $('[data-upcoming]');
  const emptyBox = $('[data-empty]');
  if (upcoming.length) {
    const [nearest, ...rest] = upcoming;
    upcomingBox.innerHTML = renderNearest(nearest, studio)
      + rest.map((b) => renderRow(b, tz)).join('')
      + `<a class="btn btn--primary btn--block new-booking" href="${esc(routes.booking())}">Новая запись</a>`;
    emptyBox.innerHTML = '';
  } else {
    upcomingBox.innerHTML = '';
    if (bookings.length) emptyBox.innerHTML = renderNoUpcoming(past, tz);
    else renderNoBookings();
  }
  show('content');
}

// ---------- Загрузка ----------

async function load() {
  show('loading');
  try {
    const user = await api.getMe();
    if (!user) return goLogin();
    // Клиентские экраны сотруднику не нужны; его раздела в web/ пока нет
    if (user.role !== 'client') return window.location.replace(routes.home);
    const [bookings, studio] = await Promise.all([api.getBookings(), api.getStudio()]);
    render(user, bookings, studio);
  } catch (error) {
    if (isAuthError(error)) return goLogin();
    // Ответ API — его текст; сбой самой страницы — понятная фраза, подробности — в консоль
    if (!(error instanceof api.ApiError)) console.error(error);
    $('[data-error-text]').textContent = error instanceof api.ApiError
      ? error.message
      : 'Что-то пошло не так на странице. Обновите ее или попробуйте позже.';
    show('error');
  }
}

$('[data-retry]').addEventListener('click', load);

load();
