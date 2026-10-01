// «Мое расписание» мастера (/master) — паспорт, функция 1 мастера, сценарий 19: рабочие часы, записи
// с услугами, комментарием, именем клиента и его пометкой «Важно», блокировки и отметка «наложение».
// Контакты клиентов и цены мастеру не показываются — их не отдает и сервер.
//
// Данные: GET /api/master/schedule?from=&to= (неделя), GET /api/studio (часовой пояс).
// Записи мастер не создает, не переносит и не отменяет — это делает администратор. Если нужен отпуск
// или другой график, мастер подает заявку: /master/requests.
import * as api from './api.js';
import { dateLabel, dateLong, escapeHtml as esc, plural, studioDate, timeLabel } from './format.js';
import { handleAccessError, masterReady } from './master-shell.js';

const $ = (selector) => /** @type {HTMLElement} */ (document.querySelector(selector));

const list = $('[data-list]');
const pageLoading = $('[data-page-loading]');
const pageError = $('[data-page-error]');
const summary = $('[data-summary]');
const caption = $('[data-caption]');
const dateInput = /** @type {HTMLInputElement} */ ($('[data-date]'));

const BLOCK_TYPES = {
  lunch: 'Обед', personal: 'Личное время', day_off: 'Выходной',
  vacation: 'Отпуск', sick_leave: 'Больничный', other: 'Блокировка',
};
const STATUS = {
  active: { label: 'Активна', cls: 'on' },
  completed: { label: 'Завершена', cls: 'done' },
  no_show: { label: 'Клиент не пришел', cls: 'no-show' },
};

const state = { timezone: 'Europe/Moscow', today: '', monday: '' };

const dayMs = (date) => Date.parse(date + 'T12:00:00Z');
const shiftDays = (date, days) => studioDate(dayMs(date) + days * 86_400_000, 'UTC');
/** Понедельник недели, в которую попадает дата: getUTCDay() дает 0 для воскресенья. */
const mondayOf = (date) => shiftDays(date, -((new Date(dayMs(date)).getUTCDay() + 6) % 7));

function dayRow(day) {
  const rows = [
    ...day.bookings.map((b) => ({ at: b.startsAt, html: bookingRow(b) })),
    ...day.timeBlocks.map((t) => ({ at: t.startsAt, html: blockRow(t) })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const window = day.window
    ? `${timeLabel(day.window.start, state.timezone)}–${timeLabel(day.window.end, state.timezone)}`
    : day.status === 'studio_closed' ? `Студия закрыта${day.reason ? `: ${day.reason}` : ''}`
      : day.status === 'master_off' ? 'Выходной' : 'Не работаете';
  const count = day.bookings.filter((b) => b.status === 'active').length;

  return `
    <section class="day-group" aria-labelledby="day-${day.date}">
      <h2 class="day-group__title" id="day-${day.date}">
        <span class="day-group__name">${esc(dateLabel(day.date + 'T12:00:00Z', 'UTC'))}</span>
        <span class="day-group__count">${esc(window)}${count ? ` · ${count} ${plural(count, 'запись', 'записи', 'записей')}` : ''}${day.date === state.today ? ' · сегодня' : ''}</span>
      </h2>
      ${rows.length ? rows.map((r) => r.html).join('') : '<p class="day-row__muted day-group__empty">Записей нет</p>'}
    </section>`;
}

function bookingRow(b) {
  const status = STATUS[b.status] ?? { label: b.status, cls: 'off' };
  const services = b.services.map((s) => (s.quantity > 1 ? `${s.name} ×${s.quantity}` : s.name)).join(', ');
  return `
    <article class="day-row">
      <p class="day-row__time">${esc(timeLabel(b.startsAt, state.timezone))}–${esc(timeLabel(b.endsAt, state.timezone))}
        ${b.busyUntil > b.endsAt ? `<span class="day-row__muted">уборка до ${esc(timeLabel(b.busyUntil, state.timezone))}</span>` : ''}</p>
      <div class="day-row__main">
        <p class="day-row__client">${esc(b.client.name)}
          ${b.isOverbooking ? '<span class="admin-badge admin-badge--warn">Наложение</span>' : ''}</p>
        <p class="day-row__meta">${esc(services)}</p>
        ${b.comment ? `<p class="day-row__muted">Комментарий: ${esc(b.comment)}</p>` : ''}
        ${b.client.importantNote ? `<p class="important-note">Важно: ${esc(b.client.importantNote)}</p>` : ''}
      </div>
      <p class="day-row__status"><span class="admin-badge admin-badge--${status.cls}">${status.label}</span></p>
    </article>`;
}

function blockRow(t) {
  return `
    <article class="day-row day-row--block">
      <p class="day-row__time">${esc(timeLabel(t.startsAt, state.timezone))}–${esc(timeLabel(t.endsAt, state.timezone))}</p>
      <div class="day-row__main">
        <p class="day-row__client">${esc(BLOCK_TYPES[t.type] ?? t.type)}</p>
        ${t.comment ? `<p class="day-row__muted">${esc(t.comment)}</p>` : ''}
      </div>
      <p class="day-row__status"><span class="admin-badge admin-badge--off">Не работаете</span></p>
    </article>`;
}

async function load() {
  pageLoading.hidden = false;
  pageError.hidden = true;
  const from = state.monday;
  const to = shiftDays(from, 6);
  try {
    const week = await api.getMasterSchedule({ from, to });
    state.timezone = week.timezone;
    const contains = state.today >= from && state.today <= to;
    caption.textContent = `${new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(new Date(dayMs(from)))}` +
      ` — ${dateLong(to + 'T12:00:00Z', 'UTC')}${contains ? ' · текущая неделя' : ''}`;
    const total = week.days.reduce((sum, d) => sum + d.bookings.filter((b) => b.status === 'active').length, 0);
    summary.textContent = total
      ? `${total} ${plural(total, 'запись', 'записи', 'записей')} на неделе`
      : 'Записей на этой неделе нет';
    list.innerHTML = week.days.map(dayRow).join('');
  } catch (error) {
    if (handleAccessError(error)) return;
    list.innerHTML = '';
    pageError.textContent = `Не удалось загрузить расписание. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    pageLoading.hidden = true;
  }
}

function setWeek(date) {
  state.monday = mondayOf(date);
  dateInput.value = state.monday;
  load();
}

dateInput.addEventListener('change', () => setWeek(dateInput.value || state.today));
$('[data-prev]').addEventListener('click', () => setWeek(shiftDays(state.monday, -7)));
$('[data-next]').addEventListener('click', () => setWeek(shiftDays(state.monday, 7)));
$('[data-today]').addEventListener('click', () => setWeek(state.today));

async function start() {
  try {
    const studio = await api.getStudio();
    state.timezone = studio.timezone;
    state.today = studioDate(Date.now(), state.timezone);
    setWeek(state.today);
  } catch (error) {
    if (handleAccessError(error)) return;
    pageError.textContent = 'Не удалось загрузить раздел. Обновите страницу.';
    pageError.hidden = false;
  }
}

if (await masterReady) start();
