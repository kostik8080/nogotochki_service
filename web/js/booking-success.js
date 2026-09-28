// BOOK-05 Вы записаны (docs/ui-map.md). Номер записи — в адресе (?id=…), сама запись — GET /api/bookings/:id
// (только владельцу: 404 — нет такой, 403 — чужая), адрес и ссылка на карту — GET /api/studio.
// «Добавить в календарь» — файл .ics собирает браузер, API не нужен. «Как добраться» — карта студии (EXT).
import * as api from './api.js';
import { dateLabel, duration, money, plural, timeLabel } from './format.js';
import { bookingServices, downloadIcs } from './calendar.js';
import { routes } from './routes.js';

const $ = (selector) => document.querySelector(selector);

const id = Number(new URLSearchParams(window.location.search).get('id'));

function showError(title, text) {
  $('[data-hero]').setAttribute('aria-busy', 'false');
  $('[data-title]').textContent = title;
  $('[data-when]').textContent = '';
  $('[data-what]').textContent = '';
  $('[data-error-title]').textContent = title;
  $('[data-error-text]').textContent = text;
  $('[data-error]').hidden = false;
}

// ---------- Загрузка ----------

async function load() {
  if (!Number.isInteger(id) || id < 1) {
    showError('Запись не найдена', 'В адресе нет номера записи. Все ваши записи — в личном кабинете.');
    return;
  }
  try {
    const [booking, studio] = await Promise.all([api.getBooking(id), api.getStudio()]);
    const tz = studio.timezone;
    const services = bookingServices(booking);

    $('[data-hero]').setAttribute('aria-busy', 'false');
    $('[data-when]').textContent = `${dateLabel(booking.startsAt, tz)}, ${timeLabel(booking.startsAt, tz)}–${timeLabel(booking.endsAt, tz)}`;
    $('[data-what]').textContent = `${services} · ${booking.master.name}`;
    $('[data-address]').textContent = studio.address;
    $('[data-price]').textContent = `${money(booking.totalPriceKop)}, оплата в студии`;
    $('[data-duration]').textContent = duration(booking.durationMin);
    const hours = studio.rules.clientChangeDeadlineHours;
    $('[data-note]').textContent = `Перенести или отменить запись можно в личном кабинете не позднее чем за ${hours === 24 ? 'сутки' : `${hours} ${plural(hours, 'час', 'часа', 'часов')}`} до визита.`;

    const map = /** @type {HTMLAnchorElement} */ ($('[data-map]'));
    if (studio.mapUrl) map.href = studio.mapUrl;
    else map.hidden = true;
    $('[data-calendar]').addEventListener('click', () => downloadIcs(booking, studio));

    $('[data-details]').hidden = false;
    $('[data-title]').focus();
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 401) {
      window.location.replace(`${routes.login}?next=${encodeURIComponent(routes.bookingSuccess(id))}`);
      return;
    }
    const notFound = error instanceof api.ApiError && (error.status === 404 || error.status === 403);
    showError(notFound ? 'Запись не найдена' : 'Не удалось загрузить запись', error.message);
  }
}

load();
