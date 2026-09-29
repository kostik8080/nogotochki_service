// Уведомления клиента — колокольчик со счетчиком в шапке (docs/ui-map.md, «Уведомления»). Два вида:
//   1. Сообщение студии «Студия отменила / перенесла запись»: у записи из GET /api/bookings есть studioChange
//      ({ type: cancelled | rescheduled, at }), пока клиент его не закроет. ✕ → POST /api/bookings/:id/acknowledge.
//      То же сообщение показывают «Мои записи» и карточка записи: закрытое в одном месте пропадает во всех —
//      страницы сообщают друг другу об этом событием на document.
//   2. Напоминание о визите за сутки, за 2 часа и за 15 минут. Считается здесь, в браузере, по времени начала
//      активной записи: отдельного API уведомлений нет, SMS и письма о записях сервис не отправляет (паспорт).
//      Поэтому напоминание видно, только когда клиент открыл сайт. Закрытое ✕ напоминание помнит этот браузер
//      (localStorage); следующее напоминание о той же записи появится в свой срок.
import * as api from './api.js';
import { bindDropdown } from './dropdown.js';
import { dateLabel, escapeHtml as esc, plural, timeLabel } from './format.js';
import { routes } from './routes.js';

const ACKNOWLEDGED = 'studio-change-acknowledged';
const DISMISSED_KEY = 'nog_reminders_dismissed';
/** Сколько закрытых напоминаний помнить: старые записи давно прошли */
const DISMISSED_LIMIT = 50;
/** Раз в минуту список пересчитывается: пока страница открыта, подходит срок следующего напоминания */
const TICK_MS = 60_000;

/** Сроки напоминаний, от ближнего к дальнему: до начала визита осталось не больше `minutes` */
const REMINDER_STAGES = [
  { key: '15m', minutes: 15, title: 'До визита меньше 15 минут' },
  { key: '2h', minutes: 2 * 60, title: 'До визита меньше 2 часов' },
  { key: '24h', minutes: 24 * 60, title: 'До визита меньше суток' },
];

const BELL = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
  </svg>`;

/** «Маникюр с покрытием гель-лаком, Дизайн ногтей ×2» */
const servicesText = (b) => b.items.map((i) => (i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name)).join(', ');

/**
 * Текст уведомления: «Студия отменила запись «…» на ср, 26 августа, 14:00.»
 * @param {any} booking запись с studioChange
 * @param {string} timeZone часовой пояс студии
 */
export function studioChangeText(booking, timeZone) {
  const when = `${dateLabel(booking.startsAt, timeZone)}, ${timeLabel(booking.startsAt, timeZone)}`;
  return booking.studioChange.type === 'cancelled'
    ? `Студия отменила запись «${servicesText(booking)}» на ${when}.`
    : `Студия перенесла запись «${servicesText(booking)}» — теперь она ${when}.`;
}

/**
 * Какое напоминание о визите сейчас действует: 15m, 2h, 24h — или null, если до визита больше суток
 * или он уже начался.
 * @param {string} startsAt начало визита, ISO
 * @param {number} [now]
 */
export function reminderStage(startsAt, now = Date.now()) {
  const minutesLeft = (Date.parse(startsAt) - now) / 60_000;
  if (minutesLeft <= 0) return null;
  return REMINDER_STAGES.find((stage) => minutesLeft <= stage.minutes) ?? null;
}

/** Сообщить остальным частям страницы, что клиент закрыл сообщение студии о записи. */
export function announceAcknowledged(bookingId) {
  document.dispatchEvent(new CustomEvent(ACKNOWLEDGED, { detail: { bookingId } }));
}

/**
 * Сообщение студии закрыли в другой части страницы.
 * @param {(bookingId: number) => void} handler
 * @param {AbortSignal} [signal]
 */
export function onAcknowledged(handler, signal) {
  document.addEventListener(ACKNOWLEDGED, (event) => handler(/** @type {CustomEvent} */ (event).detail.bookingId), { signal });
}

// ---------- Закрытые напоминания: помнит браузер ----------

/** @returns {string[]} ключи «запись:срок» */
function readDismissed() {
  try {
    const list = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveDismissed(list) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(list.slice(-DISMISSED_LIMIT)));
  } catch {
    // Без хранилища закрытое напоминание вернется после перезагрузки страницы
  }
}

let counter = 0;

/**
 * Колокольчик со счетчиком и списком уведомлений. Только для клиента.
 * @param {HTMLElement} container куда нарисовать
 */
export function mountNotifications(container) {
  const id = `notify-${++counter}`;
  container.innerHTML = `
    <div class="notify">
      <button class="notify__toggle" type="button" aria-expanded="false" aria-controls="${id}" aria-label="Уведомления"
              data-dropdown-toggle>
        ${BELL}
        <span class="notify__count" aria-hidden="true" data-count hidden></span>
      </button>
      <div class="notify__panel" id="${id}" data-theme="powder" data-dropdown-list hidden>
        <p class="notify__title">Уведомления</p>
        <div class="notify__body" aria-live="polite" data-body>
          <p class="notify__empty">Загружаем…</p>
        </div>
        <a class="notify__settings" href="${routes.profile}#notifications">Настройки уведомлений</a>
      </div>
    </div>`;

  const root = /** @type {HTMLElement} */ (container.querySelector('.notify'));
  const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('[data-dropdown-toggle]'));
  const count = /** @type {HTMLElement} */ (root.querySelector('[data-count]'));
  const body = /** @type {HTMLElement} */ (root.querySelector('[data-body]'));
  const listeners = bindDropdown(root);

  /** Все записи клиента и студия — из API; уведомления из них собираются заново при каждом пересчете */
  let bookings = [];
  let studio = null;
  let dismissed = readDismissed();
  /** Что сейчас нарисовано: список перерисовывается, только когда состав уведомлений изменился */
  let shown = null;

  /** Уведомления на сейчас: сначала напоминания (по времени визита), затем сообщения студии */
  function collect(now = Date.now()) {
    const reminders = bookings
      .filter((b) => b.status === 'active')
      .map((b) => ({ booking: b, stage: reminderStage(b.startsAt, now) }))
      .filter((r) => r.stage && !dismissed.includes(`${r.booking.id}:${r.stage.key}`))
      .sort((a, z) => Date.parse(a.booking.startsAt) - Date.parse(z.booking.startsAt))
      .map((r) => ({ kind: 'reminder', key: `${r.booking.id}:${r.stage.key}`, booking: r.booking, stage: r.stage }));
    const changes = bookings
      .filter((b) => b.studioChange)
      .map((b) => ({ kind: 'change', key: `change:${b.id}`, booking: b }));
    return [...reminders, ...changes];
  }

  function reminderText(item) {
    const b = item.booking;
    const when = `${dateLabel(b.startsAt, studio.timezone)}, ${timeLabel(b.startsAt, studio.timezone)}`;
    let text = `${item.stage.title}: ${when}. ${servicesText(b)}, мастер ${b.master.name}.`;
    // За 15 минут — адрес: клиент, скорее всего, уже в пути
    if (item.stage.key === '15m' && studio.address) text += ` Адрес: ${studio.address}.`;
    return text;
  }

  function renderCount(n) {
    count.hidden = n === 0;
    count.textContent = n > 9 ? '9+' : String(n);
    toggle.setAttribute('aria-label', n
      ? `Уведомления: ${n} ${plural(n, 'новое', 'новых', 'новых')}`
      : 'Уведомления: новых нет');
  }

  function render({ force = false } = {}) {
    const items = collect();
    const signature = items.map((i) => i.key).join('|');
    if (!force && signature === shown) return;
    shown = signature;
    renderCount(items.length);
    if (!items.length) {
      body.innerHTML = '<p class="notify__empty">Новых уведомлений нет. Здесь появятся напоминания о визите и сообщения студии, если она отменит или перенесет запись.</p>';
      return;
    }
    body.innerHTML = `<ul class="notify__list">${items.map((item) => `
      <li class="notify__item${item.kind === 'reminder' ? ' notify__item--reminder' : ''}">
        <span class="notify__kind">${item.kind === 'reminder' ? 'Напоминание о визите' : 'Сообщение студии'}</span>
        <a class="notify__link" href="${esc(routes.bookingCard(item.booking.id))}">${esc(item.kind === 'reminder' ? reminderText(item) : studioChangeText(item.booking, studio.timezone))}</a>
        <button class="notify__close" type="button" aria-label="Закрыть уведомление" data-close="${esc(item.key)}">✕</button>
        <p class="notify__error" role="alert" hidden></p>
      </li>`).join('')}</ul>`;
  }

  /** Сообщение студии закрыто — на сервере или в другой части страницы */
  function removeChange(bookingId) {
    bookings = bookings.map((b) => (b.id === bookingId ? { ...b, studioChange: null } : b));
    render();
  }

  body.addEventListener('click', async (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('[data-close]');
    if (!(button instanceof HTMLButtonElement)) return;
    const key = button.dataset.close;

    // Напоминание закрывается только в этом браузере — сервер о нем не знает
    if (!key.startsWith('change:')) {
      dismissed = [...dismissed.filter((k) => k !== key), key];
      saveDismissed(dismissed);
      render();
      toggle.focus();
      return;
    }

    const bookingId = Number(key.slice('change:'.length));
    const error = /** @type {HTMLElement} */ (button.closest('.notify__item').querySelector('.notify__error'));
    button.disabled = true;
    error.hidden = true;
    try {
      await api.acknowledgeBooking(bookingId);
      removeChange(bookingId);
      announceAcknowledged(bookingId);
      toggle.focus();
    } catch (e) {
      error.textContent = `Не удалось закрыть уведомление. ${e.message}`;
      error.hidden = false;
      button.disabled = false;
    }
  });

  onAcknowledged(removeChange, listeners.signal);

  // «Настройки уведомлений» на самой странице профиля меняет только вкладку — список закрываем сами
  root.querySelector('.notify__settings').addEventListener('click', () => {
    if (toggle.getAttribute('aria-expanded') === 'true') toggle.click();
  });

  // Пока страница открыта, подходит срок следующего напоминания, а прошедший визит уходит из списка
  const timer = setInterval(() => {
    if (!root.isConnected) return clearInterval(timer);
    if (studio) render();
  }, TICK_MS);

  async function load() {
    try {
      [bookings, studio] = await Promise.all([api.getBookings(), api.getStudio()]);
      if (!root.isConnected) return;
      render({ force: true });
    } catch (error) {
      // Без уведомлений шапка работает: счетчика нет, в списке — ошибка и «Повторить»
      body.innerHTML = `
        <p class="notify__empty notify__empty--error" role="alert">Не удалось загрузить уведомления. ${esc(error.message ?? '')}</p>
        <button class="text-link notify__retry" type="button" data-retry>Повторить</button>`;
      body.querySelector('[data-retry]').addEventListener('click', () => {
        body.innerHTML = '<p class="notify__empty">Загружаем…</p>';
        load();
      });
    }
  }

  load();
}
