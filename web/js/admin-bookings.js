// A-01 Записи (docs/ui-map.md, «Раздел администратора»): записи студии за выбранный период — время, клиент,
// мастер, услуги и состояние. Период — день, неделя или месяц; стрелки ‹ › двигают именно его,
// «Сегодня» возвращает к текущему. В неделе и месяце записи сгруппированы по дням. Есть фильтр по мастеру. Время показывается в часовом поясе студии
// (`timezone` из GET /api/studio), а в API уходит и приходит в UTC — переводит js/format.js.
//
// Действия администратора с записью (A-02…A-06 и блокировки):
//   «Новая запись» — POST /api/bookings за клиента из базы или нового; время занято (409 SLOT_TAKEN) —
//     предупреждение с ближайшим свободным временем и подтверждение наложения (isOverbooking);
//   «Перенести» — POST /api/bookings/:id/reschedule: меняется время той же записи, новая не создается,
//     старое и новое время, мастер и причина уходят в историю записи;
//   «Отменить» — POST /api/bookings/:id/cancel { by, reason }: строка остается со статусом отмены,
//     время мастера освобождается сразу;
//   «Визит завершен» и «Клиент не пришел» — POST /api/bookings/:id/status для начавшегося визита;
//   «Блокировка времени» — POST /api/admin/time-blocks: обед, личное время, выходной, отпуск, больничный.
//     Мастер остается активным, недоступны только эти дата и часы.
// Каждое изменение отправляется с version записи: если ее успел изменить другой сотрудник — 409 VERSION_CONFLICT.
import { adminReady, handleAccessError } from './admin.js';
import * as api from './api.js';
import { clearErrors, clearOnInput, normalizePhone, setBusy, showAlert, showErrors, showServerError } from './form.js';
import { dateLabel, dateLong, duration, escapeHtml as esc, money, plural, studioDate, timeLabel, zonedTimeToUtc } from './format.js';

const $ = (selector, root = document) => /** @type {HTMLElement} */ (root.querySelector(selector));

const STATUS = {
  active: { label: 'Активна', cls: 'on' },
  completed: { label: 'Завершена', cls: 'done' },
  cancelled_by_client: { label: 'Отменена клиентом', cls: 'off' },
  cancelled_by_studio: { label: 'Отменена студией', cls: 'off' },
  no_show: { label: 'Клиент не пришел', cls: 'no-show' },
};
const BLOCK_TYPES = {
  lunch: 'Обед', personal: 'Личное время', day_off: 'Выходной',
  vacation: 'Отпуск', sick_leave: 'Больничный', other: 'Другое',
};
/** Блокировки на весь день: часы не спрашиваем, время идет от начала первой даты до конца последней. */
const ALL_DAY = new Set(['day_off', 'vacation', 'sick_leave']);
const isCancelled = (b) => b.status === 'cancelled_by_client' || b.status === 'cancelled_by_studio';

const list = $('[data-list]');
const pageLoading = $('[data-page-loading]');
const pageError = $('[data-page-error]');
const summary = $('[data-summary]');
const caption = $('[data-day-caption]');
const dateInput = /** @type {HTMLInputElement} */ ($('[data-date]'));
const masterFilter = /** @type {HTMLSelectElement} */ ($('[data-master-filter]'));

/** Справочники и данные выбранного периода. `date` — опорный день: сам день, день недели или день месяца. */
const state = {
  timezone: 'Europe/Moscow',
  today: '',
  date: '',
  /** @type {'day' | 'week' | 'month'} */
  view: 'day',
  masters: /** @type {any[]} */ ([]),
  services: /** @type {any[]} */ ([]),
  bookings: /** @type {any[]} */ ([]),
  blocks: /** @type {any[]} */ ([]),
};

// Даты периода — строки календаря студии «2026-09-30»: арифметика идет по UTC-полудню, чтобы переход
// на летнее время и часовой пояс браузера не сдвигали день.
const dayMs = (date) => Date.parse(date + 'T12:00:00Z');
const dayString = (ms) => studioDate(ms, 'UTC');
const shiftDays = (date, days) => dayString(dayMs(date) + days * 86_400_000);
const firstOfMonth = (date) => date.slice(0, 8) + '01';

/** Границы периода по опорному дню: день — сам день, неделя — пн–вс, месяц — с 1-го по последнее число. */
function periodRange(view = state.view, date = state.date) {
  if (view === 'day') return { from: date, to: date };
  if (view === 'week') {
    // getUTCDay(): 0 — воскресенье, поэтому сдвигаем к понедельнику
    const weekday = (new Date(dayMs(date)).getUTCDay() + 6) % 7;
    const from = shiftDays(date, -weekday);
    return { from, to: shiftDays(from, 6) };
  }
  const [year, month] = date.split('-').map(Number);
  return { from: firstOfMonth(date), to: dayString(Date.UTC(year, month, 0, 12)) };
}

/** Подпись периода: «30 сентября 2026 · сегодня», «28 сентября — 4 октября 2026», «сентябрь 2026». */
function periodCaption() {
  const { from, to } = periodRange();
  if (state.view === 'day') return `${dateLong(from + 'T12:00:00Z', 'UTC')}${from === state.today ? ' · сегодня' : ''}`;
  if (state.view === 'month') {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'long', year: 'numeric' })
      .format(new Date(dayMs(from))).replace(/\s*г\.$/, '');
  }
  const short = (date) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(new Date(dayMs(date)));
  const contains = state.today >= from && state.today <= to;
  return `${short(from)} — ${dateLong(to + 'T12:00:00Z', 'UTC')}${contains ? ' · текущая неделя' : ''}`;
}

const masterName = (id) => state.masters.find((m) => m.id === id)?.name ?? 'Мастер';
const bookingById = (id) => state.bookings.find((b) => b.id === id);
const serviceNames = (b) => b.items.map((i) => (i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name)).join(', ');
const span = (from, to) => `${timeLabel(from, state.timezone)}–${timeLabel(to, state.timezone)}`;

// ---------------------------------------------------------------------------
// Список дня
// ---------------------------------------------------------------------------

/**
 * Записи, которые делят время с другой записью того же мастера: два визита на одно время.
 * Отмененные время не занимают и в расчет не идут. Наложение ставит только администратор (isOverbooking),
 * но пометку показываем по фактическому пересечению — ее видно у обеих записей.
 */
function overlapping(bookings) {
  const live = bookings.filter((b) => !isCancelled(b));
  const ids = new Set();
  for (const a of live) {
    for (const b of live) {
      if (a.id >= b.id || a.master.id !== b.master.id) continue;
      if (a.startsAt < b.busyUntil && b.startsAt < a.busyUntil) {
        ids.add(a.id);
        ids.add(b.id);
      }
    }
  }
  return ids;
}

function bookingRow(b, overlaps) {
  const status = STATUS[b.status] ?? { label: b.status, cls: 'off' };
  const cancel = b.cancellation;
  const marks = [
    overlaps.has(b.id) ? '<span class="admin-badge admin-badge--warn">Два визита на это время</span>' : '',
    b.isAnyMaster ? '<span class="admin-badge admin-badge--addon">Любой мастер</span>' : '',
  ].join('');
  const actions = [];
  if (b.status === 'active') {
    actions.push('<button class="btn btn--outline btn--small" type="button" data-action="move">Перенести</button>');
    if (Date.parse(b.startsAt) <= Date.now()) {
      actions.push('<button class="btn btn--outline btn--small" type="button" data-action="completed">Визит завершен</button>');
      actions.push('<button class="btn btn--outline btn--small" type="button" data-action="no_show">Неявка</button>');
    }
    actions.push('<button class="btn btn--danger btn--small" type="button" data-action="cancel">Отменить</button>');
  } else if (b.status === 'completed') {
    actions.push('<button class="btn btn--outline btn--small" type="button" data-action="no_show">Исправить: неявка</button>');
  } else if (b.status === 'no_show') {
    actions.push('<button class="btn btn--outline btn--small" type="button" data-action="completed">Исправить: завершен</button>');
  }
  return `
    <article class="day-row${isCancelled(b) ? ' is-cancelled' : ''}" data-booking="${b.id}">
      <p class="day-row__time">${esc(span(b.startsAt, b.endsAt))}
        ${b.busyUntil > b.endsAt ? `<span class="day-row__muted">уборка до ${esc(timeLabel(b.busyUntil, state.timezone))}</span>` : ''}</p>
      <div class="day-row__main">
        <p class="day-row__client">${esc(b.client?.name ?? 'Клиент')}${marks}</p>
        <p class="day-row__meta">${esc(masterName(b.master.id))} · ${esc(serviceNames(b))}</p>
        ${b.client?.phone ? `<p class="day-row__muted">${esc(b.client.phone)}</p>` : ''}
        ${b.comment ? `<p class="day-row__muted">Комментарий: ${esc(b.comment)}</p>` : ''}
        ${cancel ? `<p class="day-row__muted">Отменила ${cancel.by === 'studio' ? 'студия' : 'клиентка'}${cancel.reason ? `: ${esc(cancel.reason)}` : ' без причины'}</p>` : ''}
      </div>
      <p class="day-row__status">
        <span class="admin-badge admin-badge--${status.cls}">${status.label}</span>
        <span class="day-row__price">${esc(money(b.totalPriceKop))}</span>
      </p>
      <div class="day-row__actions">${actions.join('')}</div>
    </article>`;
}

function blockRow(t) {
  const allDay = ALL_DAY.has(t.type);
  return `
    <article class="day-row day-row--block" data-block="${t.id}">
      <p class="day-row__time">${allDay ? 'Весь день' : esc(span(t.startsAt, t.endsAt))}</p>
      <div class="day-row__main">
        <p class="day-row__client">${esc(BLOCK_TYPES[t.type] ?? t.type)} · ${esc(masterName(t.masterId))}</p>
        <p class="day-row__meta">Время заблокировано: клиенты не увидят его свободным</p>
        ${t.comment ? `<p class="day-row__muted">${esc(t.comment)}</p>` : ''}
      </div>
      <p class="day-row__status"><span class="admin-badge admin-badge--off">Блокировка</span></p>
      <div class="day-row__actions">
        <button class="btn btn--outline btn--small" type="button" data-action="unblock">Снять</button>
      </div>
    </article>`;
}

function render() {
  const filter = masterFilter.value ? Number(masterFilter.value) : null;
  const bookings = state.bookings.filter((b) => !filter || b.master.id === filter);
  const blocks = state.blocks.filter((t) => !filter || t.masterId === filter);
  const overlaps = overlapping(bookings);

  caption.textContent = periodCaption();
  const live = bookings.filter((b) => !isCancelled(b));
  const cancelled = bookings.length - live.length;
  summary.textContent = bookings.length
    ? `${live.length} ${plural(live.length, 'запись', 'записи', 'записей')}` +
      (cancelled ? `, ${cancelled} ${plural(cancelled, 'отменена', 'отменены', 'отменено')}` : '') +
      (blocks.length ? `, ${blocks.length} ${plural(blocks.length, 'блокировка', 'блокировки', 'блокировок')}` : '')
    : blocks.length ? `Записей нет, ${blocks.length} ${plural(blocks.length, 'блокировка', 'блокировки', 'блокировок')}` : '';

  if (!bookings.length && !blocks.length) {
    const what = state.view === 'day' ? 'На этот день' : state.view === 'week' ? 'На эту неделю' : 'На этот месяц';
    list.innerHTML = `
      <div class="admin-state admin-state--wide">
        <p class="admin-state__title">${what} записей нет</p>
        <p class="admin-state__text">Выберите другой период или создайте запись за клиента.</p>
      </div>`;
    return;
  }

  const rows = [
    ...bookings.map((b) => ({ at: b.startsAt, day: studioDate(b.startsAt, state.timezone), html: bookingRow(b, overlaps), booking: b })),
    // Блокировка на несколько дней (отпуск) попадает в день своего начала или в первый день периода
    ...blocks.map((t) => ({ at: t.startsAt, day: maxDay(studioDate(t.startsAt, state.timezone), periodRange().from), html: blockRow(t), booking: null })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  // День — сплошной список; неделя и месяц — с заголовком у каждого дня, где что-то есть
  if (state.view === 'day') {
    list.innerHTML = rows.map((r) => r.html).join('');
    return;
  }
  const days = [...new Set(rows.map((r) => r.day))].sort();
  list.innerHTML = days.map((day) => {
    const ofDay = rows.filter((r) => r.day === day);
    const count = ofDay.filter((r) => r.booking && !isCancelled(r.booking)).length;
    const blocked = ofDay.filter((r) => !r.booking).length;
    const note = [
      count ? `${count} ${plural(count, 'запись', 'записи', 'записей')}` : 'записей нет',
      blocked ? `${blocked} ${plural(blocked, 'блокировка', 'блокировки', 'блокировок')}` : '',
    ].filter(Boolean).join(', ');
    return `
      <section class="day-group" aria-labelledby="day-${day}">
        <h2 class="day-group__title" id="day-${day}">
          <button class="day-group__link" type="button" data-open-day="${day}">${esc(dateLabel(day + 'T12:00:00Z', 'UTC'))}</button>
          <span class="day-group__count">${note}${day === state.today ? ' · сегодня' : ''}</span>
        </h2>
        ${ofDay.map((r) => r.html).join('')}
      </section>`;
  }).join('');
}

const maxDay = (a, b) => (a > b ? a : b);

/** Записи за период. За месяц их может быть больше одной страницы — дочитываем по offset. */
async function loadBookings(from, to) {
  const all = [];
  for (let offset = 0; offset < 2000; offset += 500) {
    const page = await api.getAdminBookings({ dateFrom: from, dateTo: to, limit: 500, offset });
    all.push(...page.bookings);
    if (all.length >= page.total) break;
  }
  return all;
}

async function loadPeriod() {
  pageLoading.hidden = false;
  pageError.hidden = true;
  const { from, to } = periodRange();
  try {
    const [bookings, blocks] = await Promise.all([loadBookings(from, to), api.getTimeBlocks({ from, to })]);
    state.bookings = bookings;
    state.blocks = blocks;
    render();
  } catch (error) {
    if (handleAccessError(error)) return;
    list.innerHTML = '';
    pageError.textContent = `Не удалось загрузить записи. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    pageLoading.hidden = true;
  }
}

/** Смена периода: адрес не меняется, период хранится в состоянии страницы. */
function setDate(date) {
  state.date = date;
  dateInput.value = date;
  loadPeriod();
}

/** Стрелки двигают выбранный период: день, неделю или месяц. */
function shiftPeriod(direction) {
  if (state.view === 'day') return setDate(shiftDays(state.date, direction));
  if (state.view === 'week') return setDate(shiftDays(state.date, 7 * direction));
  const [year, month] = state.date.split('-').map(Number);
  setDate(firstOfMonth(dayString(Date.UTC(year, month - 1 + direction, 1, 12))));
}

dateInput.addEventListener('change', () => setDate(dateInput.value || state.today));
$('[data-prev]').addEventListener('click', () => shiftPeriod(-1));
$('[data-next]').addEventListener('click', () => shiftPeriod(1));
$('[data-today]').addEventListener('click', () => setDate(state.today));
masterFilter.addEventListener('change', render);

// Переключение периода: загружаем заново, опорный день остается прежним
document.querySelectorAll('input[name="view"]').forEach((radio) => radio.addEventListener('change', (event) => {
  state.view = /** @type {'day' | 'week' | 'month'} */ (/** @type {HTMLInputElement} */ (event.target).value);
  loadPeriod();
}));

// Заголовок дня в неделе и месяце открывает этот день
list.addEventListener('click', (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('[data-open-day]');
  if (!(button instanceof HTMLElement)) return;
  state.view = 'day';
  /** @type {HTMLInputElement} */ ($('#view-day')).checked = true;
  setDate(button.dataset.openDay);
});

// ---------------------------------------------------------------------------
// Диалоги
// ---------------------------------------------------------------------------

/** @type {Record<string, HTMLDialogElement>} */
const dialogs = {
  new: /** @type {HTMLDialogElement} */ ($('[data-new-dialog]')),
  move: /** @type {HTMLDialogElement} */ ($('[data-move-dialog]')),
  cancel: /** @type {HTMLDialogElement} */ ($('[data-cancel-dialog]')),
  result: /** @type {HTMLDialogElement} */ ($('[data-result-dialog]')),
  block: /** @type {HTMLDialogElement} */ ($('[data-block-dialog]')),
};
for (const dialog of Object.values(dialogs)) {
  dialog.querySelectorAll('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  // Клик по затемнению за окном закрывает его, как в остальных окнах сервиса
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

/** Варианты ближайшего свободного времени из ответа 409 SLOT_TAKEN. */
function renderAlternatives(slot, alternatives, onPick) {
  slot.innerHTML = (alternatives ?? []).slice(0, 6)
    .map((a) => `<button class="chip" type="button" data-at="${esc(a.startsAt)}">${esc(timeLabel(a.startsAt, state.timezone))}</button>`).join('');
  slot.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => onPick(chip.dataset.at)));
}

/** Свободное время мастера на дату — подсказка под полем времени. Занятое время администратор вправе занять. */
async function freeTimeHint(slot, masterId, date, services) {
  slot.textContent = '';
  if (!masterId || !date || !services.length) return;
  try {
    const answer = await api.getMasterSlots(masterId, { date, services });
    if (answer.day.status !== 'open') {
      slot.textContent = answer.day.status === 'master_off'
        ? 'В этот день мастер не работает. Запись поверх нерабочего времени создать нельзя.'
        : `Студия закрыта${answer.day.reason ? `: ${answer.day.reason}` : ''}.`;
      return;
    }
    const times = answer.slots.map((s) => timeLabel(s.startsAt, state.timezone));
    slot.textContent = times.length
      ? `Свободно: ${times.slice(0, 8).join(', ')}${times.length > 8 ? '…' : ''}`
      : 'Свободного времени в этот день нет — можно записать только поверх занятого.';
  } catch {
    // Подсказка необязательна: время администратор вводит сам
  }
}

// ---------- A-02 Новая запись ----------

const newForm = /** @type {HTMLFormElement} */ ($('[data-new-form]'));
const newAlert = $('[data-new-alert]', newForm);
const overbookingBox = $('[data-overbooking]', newForm);
const overbookingConfirm = /** @type {HTMLInputElement} */ ($('[data-overbooking-confirm]', newForm));
const clientSearch = /** @type {HTMLInputElement} */ ($('[data-client-search]', newForm));
const clientResults = $('[data-client-results]', newForm);
const clientChosen = $('[data-client-chosen]', newForm);
const newClientFields = $('[data-new-client-fields]', newForm);
const newMaster = /** @type {HTMLSelectElement} */ ($('[data-new-master]', newForm));
const newDate = /** @type {HTMLInputElement} */ ($('[data-new-date]', newForm));
const newTime = /** @type {HTMLInputElement} */ ($('[data-new-time]', newForm));
/** Выбранный клиент из базы; null — новый клиент по имени и телефону. */
let chosenClient = null;

const chosenServices = () => [...newForm.querySelectorAll('input[name="serviceIds"]:checked')]
  .map((i) => state.services.find((s) => s.id === Number(/** @type {HTMLInputElement} */ (i).value)))
  .filter(Boolean);

/** Услуги визита в формате API: «8,3» — номера через запятую. */
const servicesParam = (services) => services.map((s) => s.id).join(',');

function renderVisitTotal() {
  const services = chosenServices();
  const master = state.masters.find((m) => m.id === Number(newMaster.value));
  const top = master?.level === 'top_master';
  const total = services.reduce((sum, s) => sum + (top ? s.priceTopKop : s.priceMasterKop), 0);
  const minutes = services.reduce((sum, s) => sum + s.durationMin, 0);
  $('[data-visit-total]', newForm).textContent = services.length
    ? `Визит: ${duration(minutes)}, ${money(total)}${top ? ' (цены топ-мастера)' : ''}`
    : 'Отметьте услуги визита.';
  freeTimeHint($('[data-free-slots]', newForm), Number(newMaster.value), newDate.value, servicesParam(services));
}

function fillMasterOptions(select, { activeOnly = true } = {}) {
  const masters = activeOnly ? state.masters.filter((m) => m.isActive) : state.masters;
  select.innerHTML = masters
    .map((m) => `<option value="${m.id}">${esc(m.name)}${m.isActive ? '' : ' (отключен)'}</option>`).join('');
}

function openNewBooking() {
  clearErrors(newForm, newAlert);
  newForm.reset();
  chosenClient = null;
  clientChosen.hidden = true;
  clientResults.innerHTML = '';
  newClientFields.hidden = true;
  overbookingBox.hidden = true;
  overbookingConfirm.checked = false;
  $('[data-new-services]', newForm).innerHTML = state.services
    .map((s) => `
      <label class="check__label">
        <input type="checkbox" name="serviceIds" value="${s.id}">
        <span class="admin-checks__text">${esc(s.name)}
          <span class="admin-checks__meta">${esc(duration(s.durationMin))} · ${esc(money(s.priceMasterKop))}</span></span>
      </label>`).join('');
  fillMasterOptions(newMaster);
  newDate.value = state.date;
  newTime.value = '';
  renderVisitTotal();
  dialogs.new.showModal();
  clientSearch.focus();
}

$('[data-open-new]').addEventListener('click', openNewBooking);

newForm.addEventListener('change', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.matches('input[name="serviceIds"], [data-new-master], [data-new-date]')) renderVisitTotal();
});

$('[data-new-client-toggle]', newForm).addEventListener('click', () => {
  newClientFields.hidden = !newClientFields.hidden;
  chosenClient = null;
  clientChosen.hidden = true;
  clientResults.innerHTML = '';
  if (!newClientFields.hidden) /** @type {HTMLInputElement} */ ($('#new-client-name')).focus();
});

let searchTimer = 0;
clientSearch.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  const query = clientSearch.value.trim();
  chosenClient = null;
  clientChosen.hidden = true;
  if (query.length < 2) {
    clientResults.innerHTML = '';
    return;
  }
  searchTimer = window.setTimeout(async () => {
    try {
      const clients = await api.findAdminClients(query, 6);
      clientResults.innerHTML = clients.length
        ? clients.map((c) => `
            <button class="client-result" type="button" data-client="${c.id}">
              <span>${esc(c.name)}</span>
              <span class="day-row__muted">${esc(c.phone ?? c.email ?? '')}${c.isBlacklisted ? ' · в черном списке' : ''}</span>
            </button>`).join('')
        : '<p class="day-row__muted">Клиент не найден. Добавьте его как нового.</p>';
      clientResults.querySelectorAll('[data-client]').forEach((button) => button.addEventListener('click', () => {
        chosenClient = clients.find((c) => c.id === Number(button.dataset.client));
        clientChosen.textContent = `Выбран клиент: ${chosenClient.name}`;
        clientChosen.hidden = false;
        clientResults.innerHTML = '';
        newClientFields.hidden = true;
      }));
    } catch (error) {
      if (!handleAccessError(error)) clientResults.innerHTML = '';
    }
  }, 250);
});

newForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(newForm, newAlert);
  const services = chosenServices();
  const name = /** @type {HTMLInputElement} */ ($('#new-client-name')).value.trim();
  const phone = /** @type {HTMLInputElement} */ ($('#new-client-phone')).value.trim();
  const isNew = !newClientFields.hidden;
  const ok = showErrors(newForm, {
    clientId: chosenClient || isNew ? null : 'Найдите клиента или добавьте нового',
    newClientName: !isNew || name ? null : 'Введите имя клиента',
    newClientPhone: !isNew || normalizePhone(phone) ? null : 'Проверьте телефон: например, +7 911 222-33-44',
    services: services.length ? null : 'Отметьте хотя бы одну услугу',
    masterId: newMaster.value ? null : 'Выберите мастера',
    date: newDate.value ? null : 'Выберите дату',
    time: newTime.value ? null : 'Укажите время начала',
  });
  if (!ok) return;

  const body = {
    masterId: Number(newMaster.value),
    startsAt: zonedTimeToUtc(newDate.value, newTime.value, state.timezone),
    services: services.map((s) => ({ serviceId: s.id })),
    comment: /** @type {HTMLTextAreaElement} */ ($('[data-new-comment]', newForm)).value.trim() || null,
    ...(isNew ? { newClient: { name, phone: normalizePhone(phone) } } : { clientId: chosenClient.id }),
    // Проверку занятости не отключаем: сервер проверяет время и на этом запросе, а наложение лишь разрешает
    // пересечение с записями и блокировками — рабочее время мастера и чужие брони оно не перекрывает
    ...(overbookingConfirm.checked ? { isOverbooking: true } : {}),
  };
  const done = setBusy(/** @type {HTMLButtonElement} */ (newForm.querySelector('[type=submit]')), 'Создаем…');
  try {
    await api.createAdminBooking(body);
    dialogs.new.close();
    await loadPeriod();
      const { from, to } = periodRange();
    const day = studioDate(body.startsAt, state.timezone);
    // Запись создана вне открытого периода — показываем тот период, где она теперь стоит
    if (day < from || day > to) setDate(day);
  } catch (error) {
    if (handleAccessError(error)) return;
    if (error instanceof api.ApiError && error.code === 'SLOT_TAKEN') {
      // Предупреждение и подтверждение: запись поверх занятого времени создается только по явному согласию
      overbookingBox.hidden = false;
      overbookingConfirm.checked = false;
      $('[data-overbooking-text]', newForm).textContent = `${error.message} Выберите другое время или подтвердите наложение.`;
      renderAlternatives($('[data-alternatives]', newForm), error.details?.alternatives, (at) => {
        newTime.value = timeLabel(at, state.timezone);
        newDate.value = studioDate(at, state.timezone);
        overbookingBox.hidden = true;
        renderVisitTotal();
      });
      overbookingBox.scrollIntoView({ block: 'nearest' });
    } else {
      showServerError(newForm, newAlert, error);
    }
  } finally {
    done();
  }
});

// ---------- A-04 Перенос ----------

const moveForm = /** @type {HTMLFormElement} */ ($('[data-move-form]'));
const moveAlert = $('[data-move-alert]', moveForm);
const moveOverbooking = $('[data-move-overbooking]', moveForm);
const moveConfirm = /** @type {HTMLInputElement} */ ($('[data-move-overbooking-confirm]', moveForm));
const moveMaster = /** @type {HTMLSelectElement} */ ($('[data-move-master]', moveForm));
const moveDate = /** @type {HTMLInputElement} */ ($('[data-move-date]', moveForm));
const moveTime = /** @type {HTMLInputElement} */ ($('[data-move-time]', moveForm));
let movingId = 0;

function moveHint() {
  const b = bookingById(movingId);
  if (b) freeTimeHint($('[data-move-slots]', moveForm), Number(moveMaster.value), moveDate.value, servicesParam(b.items.map((i) => ({ id: i.serviceId }))));
}

moveForm.addEventListener('change', (event) => {
  if (/** @type {HTMLElement} */ (event.target).matches('[data-move-master], [data-move-date]')) moveHint();
});

function openMove(b) {
  movingId = b.id;
  clearErrors(moveForm, moveAlert);
  moveOverbooking.hidden = true;
  moveConfirm.checked = false;
  $('[data-move-summary]', moveForm).textContent =
    `${b.client?.name ?? 'Клиент'} · ${serviceNames(b)} · сейчас ${span(b.startsAt, b.endsAt)}, ${masterName(b.master.id)}`;
  fillMasterOptions(moveMaster);
  moveMaster.value = String(b.master.id);
  moveDate.value = studioDate(b.startsAt, state.timezone);
  moveTime.value = timeLabel(b.startsAt, state.timezone);
  /** @type {HTMLInputElement} */ ($('[data-move-reason]', moveForm)).value = '';
  moveHint();
  dialogs.move.showModal();
}

moveForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const b = bookingById(movingId);
  if (!b) return;
  clearErrors(moveForm, moveAlert);
  if (!moveDate.value || !moveTime.value) {
    showAlert(moveAlert, 'error', 'Укажите новые дату и время.');
    return;
  }
  const done = setBusy(/** @type {HTMLButtonElement} */ (moveForm.querySelector('[type=submit]')), 'Переносим…');
  try {
    // Перенос меняет время той же записи: новая запись не создается, клиент увидит одно сообщение студии
    await api.rescheduleAdminBooking(b.id, {
      startsAt: zonedTimeToUtc(moveDate.value, moveTime.value, state.timezone),
      masterId: Number(moveMaster.value),
      reason: /** @type {HTMLInputElement} */ ($('[data-move-reason]', moveForm)).value.trim() || null,
      version: b.version,
      ...(moveConfirm.checked ? { isOverbooking: true } : {}),
    });
    dialogs.move.close();
    await loadPeriod();
  } catch (error) {
    if (handleAccessError(error)) return;
    if (error instanceof api.ApiError && error.code === 'SLOT_TAKEN') {
      moveOverbooking.hidden = false;
      moveConfirm.checked = false;
      $('[data-move-overbooking-text]', moveForm).textContent = `${error.message} Выберите другое время или подтвердите наложение.`;
      renderAlternatives($('[data-move-alternatives]', moveForm), error.details?.alternatives, (at) => {
        moveTime.value = timeLabel(at, state.timezone);
        moveDate.value = studioDate(at, state.timezone);
        moveOverbooking.hidden = true;
      });
    } else {
      showServerError(moveForm, moveAlert, error);
    }
  } finally {
    done();
  }
});

// ---------- A-05 Отмена ----------

const cancelForm = /** @type {HTMLFormElement} */ ($('[data-cancel-form]'));
const cancelAlert = $('[data-cancel-alert]', cancelForm);
let cancellingId = 0;

function openCancel(b) {
  cancellingId = b.id;
  clearErrors(cancelForm, cancelAlert);
  cancelForm.reset();
  $('[data-cancel-summary]', cancelForm).textContent =
    `${b.client?.name ?? 'Клиент'} · ${serviceNames(b)} · ${span(b.startsAt, b.endsAt)}, ${masterName(b.master.id)}`;
  dialogs.cancel.showModal();
}

cancelForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const b = bookingById(cancellingId);
  if (!b) return;
  clearErrors(cancelForm, cancelAlert);
  const by = /** @type {HTMLInputElement} */ (cancelForm.querySelector('input[name="by"]:checked')).value;
  const done = setBusy(/** @type {HTMLButtonElement} */ (cancelForm.querySelector('[type=submit]')), 'Отменяем…');
  try {
    // Строка записи остается: статус отмены, кто отменил и причина уходят в историю записи
    await api.cancelAdminBooking(b.id, {
      by: /** @type {'client' | 'studio'} */ (by),
      reason: /** @type {HTMLInputElement} */ ($('[data-cancel-reason]', cancelForm)).value.trim() || null,
      version: b.version,
    });
    dialogs.cancel.close();
    await loadPeriod();
  } catch (error) {
    if (handleAccessError(error)) return;
    showServerError(cancelForm, cancelAlert, error);
  } finally {
    done();
  }
});

// ---------- A-06 Итог визита ----------

const resultForm = /** @type {HTMLFormElement} */ ($('[data-result-form]'));
const resultAlert = $('[data-result-alert]', resultForm);
let resultId = 0;
let resultStatus = 'completed';

function openResult(b, status) {
  resultId = b.id;
  resultStatus = status;
  clearErrors(resultForm, resultAlert);
  const done = status === 'completed';
  $('[data-result-title]', resultForm).textContent = done ? 'Визит завершен' : 'Клиент не пришел';
  $('[data-result-summary]', resultForm).textContent =
    `${b.client?.name ?? 'Клиент'} · ${serviceNames(b)} · ${span(b.startsAt, b.endsAt)}`;
  $('[data-result-note]', resultForm).textContent = done
    ? 'Визит будет отмечен завершенным. После этого к нему можно добавить фото работ.'
    : 'Неявка сохранится в карточке клиента и повлияет на его метку в клиентской базе.';
  /** @type {HTMLButtonElement} */ ($('[data-result-submit]', resultForm)).textContent = done ? 'Визит завершен' : 'Зафиксировать неявку';
  dialogs.result.showModal();
}

resultForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const b = bookingById(resultId);
  if (!b) return;
  clearErrors(resultForm, resultAlert);
  const done = setBusy(/** @type {HTMLButtonElement} */ ($('[data-result-submit]', resultForm)), 'Сохраняем…');
  try {
    await api.setBookingResult(b.id, { status: /** @type {'completed' | 'no_show'} */ (resultStatus), version: b.version });
    dialogs.result.close();
    await loadPeriod();
  } catch (error) {
    if (handleAccessError(error)) return;
    showServerError(resultForm, resultAlert, error);
  } finally {
    done();
  }
});

// ---------- Блокировка времени ----------

const blockForm = /** @type {HTMLFormElement} */ ($('[data-block-form]'));
const blockAlert = $('[data-block-alert]', blockForm);
const blockAffected = $('[data-block-affected]', blockForm);
const blockType = /** @type {HTMLSelectElement} */ ($('[data-block-type]', blockForm));
const blockFrom = /** @type {HTMLInputElement} */ ($('[data-block-from]', blockForm));
const blockTo = /** @type {HTMLInputElement} */ ($('[data-block-to]', blockForm));

const toggleBlockHours = () => {
  $('[data-block-hours]', blockForm).hidden = ALL_DAY.has(blockType.value);
};
blockType.addEventListener('change', toggleBlockHours);

$('[data-open-block]').addEventListener('click', () => {
  clearErrors(blockForm, blockAlert);
  blockAffected.hidden = true;
  fillMasterOptions(/** @type {HTMLSelectElement} */ ($('[data-block-master]', blockForm)));
  blockFrom.value = state.date;
  blockTo.value = state.date;
  toggleBlockHours();
  dialogs.block.showModal();
});

blockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(blockForm, blockAlert);
  blockAffected.hidden = true;
  const allDay = ALL_DAY.has(blockType.value);
  const from = blockFrom.value;
  const to = blockTo.value || from;
  const comment = /** @type {HTMLInputElement} */ ($('[data-block-comment]', blockForm)).value.trim();
  if (!showErrors(blockForm, {
    startsAt: from ? null : 'Укажите дату',
    endsAt: to >= from ? null : 'Последний день раньше первого',
    comment: blockType.value !== 'other' || comment ? null : 'Для причины «Другое» напишите пояснение',
  })) return;

  const start = /** @type {HTMLInputElement} */ ($('[data-block-start]', blockForm)).value || '00:00';
  const end = /** @type {HTMLInputElement} */ ($('[data-block-end]', blockForm)).value || '23:59';
  // Весь день — от начала первой даты до начала следующего дня после последней
  const startsAt = zonedTimeToUtc(from, allDay ? '00:00' : start, state.timezone);
  const endsAt = allDay
    ? zonedTimeToUtc(shiftDays(to, 1), '00:00', state.timezone)
    : zonedTimeToUtc(from, end, state.timezone);
  if (endsAt <= startsAt) {
    showAlert(blockAlert, 'error', 'Конец блокировки должен быть позже начала.');
    return;
  }

  const body = {
    masterId: Number(/** @type {HTMLSelectElement} */ ($('[data-block-master]', blockForm)).value),
    type: blockType.value, startsAt, endsAt, comment: comment || null,
  };
  const done = setBusy(/** @type {HTMLButtonElement} */ (blockForm.querySelector('[type=submit]')), 'Блокируем…');
  try {
    const answer = await api.createTimeBlock(body);
    dialogs.block.close();
    await loadPeriod();
    // Записи под блокировкой база не трогает: администратор переносит или отменяет их сам
    if (answer.affectedBookings?.length) {
      const names = answer.affectedBookings
        .map((b) => `${timeLabel(b.startsAt, state.timezone)} ${b.client?.name ?? ''}`).join(', ');
      pageError.className = 'alert alert--warning';
      pageError.textContent = `Время заблокировано. Записи на это время не отменяются сами — перенесите или отмените их: ${names}`;
      pageError.hidden = false;
    }
  } catch (error) {
    if (handleAccessError(error)) return;
    showServerError(blockForm, blockAlert, error);
  } finally {
    done();
  }
});

// ---------------------------------------------------------------------------
// Действия в строках списка
// ---------------------------------------------------------------------------

list.addEventListener('click', async (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
  if (!(button instanceof HTMLElement)) return;
  const row = button.closest('[data-booking], [data-block]');
  if (!(row instanceof HTMLElement)) return;

  if (button.dataset.action === 'unblock') {
    if (!window.confirm('Снять блокировку? Время снова станет свободным для записи.')) return;
    try {
      await api.deleteTimeBlock(Number(row.dataset.block));
      await loadPeriod();
    } catch (error) {
      if (handleAccessError(error)) return;
      pageError.className = 'alert alert--error';
      pageError.textContent = `Не удалось снять блокировку. ${error instanceof api.ApiError ? error.message : ''}`;
      pageError.hidden = false;
    }
    return;
  }

  const booking = bookingById(Number(row.dataset.booking));
  if (!booking) return;
  if (button.dataset.action === 'move') openMove(booking);
  else if (button.dataset.action === 'cancel') openCancel(booking);
  else openResult(booking, button.dataset.action === 'completed' ? 'completed' : 'no_show');
});

[newForm, moveForm, cancelForm, blockForm].forEach((form) => clearOnInput(form));

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

async function start() {
  try {
    const [studio, masters, catalog] = await Promise.all([api.getStudio(), api.getAdminMasters(), api.getServices()]);
    state.timezone = studio.timezone;
    state.today = studioDate(Date.now(), state.timezone);
    state.masters = masters;
    state.services = catalog.categories.flatMap((c) => c.services);
    masterFilter.innerHTML = '<option value="">Все мастера</option>' + masters
      .map((m) => `<option value="${m.id}">${esc(m.name)}${m.isActive ? '' : ' (отключен)'}</option>`).join('');
    setDate(state.today);
  } catch (error) {
    if (handleAccessError(error)) return;
    pageError.textContent = `Не удалось загрузить раздел. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  }
}

if (await adminReady) start();
