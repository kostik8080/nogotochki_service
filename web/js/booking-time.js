// BOOK-03 Шаг 3. Время (docs/ui-map.md). Свободное время считает только сервер:
//   конкретный мастер — GET /api/masters/:id/slots?date=…&services=… (слоты, day.status: open / master_off / studio_closed);
//   «Любой мастер»     — GET /api/slots?date=…&services=… (в каждом слоте masterIds).
// Точки в календаре — по ответам на каждый день видимого месяца в пределах горизонта; дни, закрытые по режиму
// студии (GET /api/studio) и особым дням (GET /api/studio/days), не запрашиваются (список 1, пункт 4.1).
// Ближайшее свободное время и ближайшие даты — сначала из загруженного месяца, затем по дню вперед (пункты 4.2, 4.3).
//
// Сетка дня: возможные начала визита — от открытия студии с шагом записи (rules.slotStepMin) до закрытия минус
// длительность визита. Свободны из них только те, что прислал сервер; остальные показаны занятыми и неактивны.
// API не говорит, почему время недоступно (запись, обед, вне смены мастера, слишком скоро) — для клиента это «занято».
//
// «Продолжить» → POST /api/holds: 201 — бронь на 10 минут и BOOK-04; 401 — вход с возвратом сюда (выбор в черновике);
// 409 SLOT_TAKEN — окно BOOK-M1 с ближайшим свободным временем; 503 MAINTENANCE и прочее — текстом.
//
// Режим переноса (CAB-04): ?reschedule=ID. Услуги и мастер — из записи (GET /api/bookings/:id), черновик не трогаем;
// слоты — GET /api/masters/:id/slots?date=…&bookingId=… (сама запись не считается занятым временем); текущее время
// записи видно отдельным состоянием в календаре и сетке. «Продолжить» → POST /api/holds { bookingId, startsAt, masterId }
// → «Было → Стало» → POST /api/bookings/:id/reschedule { startsAt, reason, version }. Отказы сервера — его текстом.
import * as api from './api.js';
import {
  dateLabel, duration, escapeHtml as esc, money, phone as formatPhone, phoneHref, plural, timeLabel,
} from './format.js';
import { setBusy, showAlert } from './form.js';
import { hasRole } from './roles.js';
import { routes } from './routes.js';
import { getDraft, parseServicesParam, servicesParam, startDraft, updateDraft } from './store.js';

const $ = (selector) => document.querySelector(selector);

const pageParams = new URLSearchParams(window.location.search);
/** Номер переносимой записи; null — обычная запись */
const rescheduleId = Number(pageParams.get('reschedule')) || null;
/** Переносимая запись из API — только в режиме переноса */
let original = null;
/** Дата текущей записи по календарю студии */
let originalDate = null;

// «Повторить визит» из кабинета: ?services=…&master=… — начало новой записи с этим составом и мастером
{
  const params = pageParams;
  if (!rescheduleId && params.has('services')) {
    const master = Number(params.get('master'));
    startDraft({
      items: parseServicesParam(params.get('services')),
      masterId: Number.isInteger(master) && master > 0 ? master : null,
      anyMaster: !params.has('master'),
    });
    history.replaceState(null, '', window.location.pathname);
  }
}

const draft = getDraft();
/** Мастер, у которого ищем время; null — «Любой свободный мастер». При переносе — мастер записи (после загрузки) */
let masterId = rescheduleId ? null : draft.lockedMasterId ?? (draft.anyMaster ? null : draft.masterId);
const services = rescheduleId ? '' : servicesParam(draft.items);

// Без услуг или без выбора мастера время искать не для кого
const ready = rescheduleId !== null || (draft.items.length > 0 && (masterId !== null || draft.anyMaster));
if (!rescheduleId && !draft.items.length) window.location.replace(routes.booking());
else if (!ready) window.location.replace('booking-master.html');

// Закрепленный мастер: шаг «Мастер» пропущен — назад и «Изменить» ведут к услугам
if (!rescheduleId && draft.lockedMasterId !== null) {
  $('[data-back]').setAttribute('href', 'booking-services.html');
  $('[data-change-master]').setAttribute('href', 'booking-services.html');
}

const daysBox = /** @type {HTMLElement} */ ($('[data-days]'));
const dayTitle = /** @type {HTMLElement} */ ($('[data-day-title]'));
const dayBody = /** @type {HTMLElement} */ ($('[data-day-body]'));
const totalText = /** @type {HTMLElement} */ ($('[data-total]'));
const hintText = /** @type {HTMLElement} */ ($('[data-hint]'));
const continueButton = /** @type {HTMLButtonElement} */ ($('[data-continue]'));
const nearestButton = /** @type {HTMLButtonElement} */ ($('[data-nearest]'));

const GROUPS = [
  { label: 'Утро', until: 12 },
  { label: 'День', until: 17 },
  { label: 'Вечер', until: 24 },
];
/** Сколько запросов слотов идет одновременно, когда грузится месяц */
const PARALLEL = 6;

let studio = null;
/** Особые дни студии: дата → { isOpen, open, close, reason } */
let specialDays = new Map();
let today = '';
let lastDay = '';
/** Первый день видимого месяца, YYYY-MM-01 */
let month = '';
/** Ответы API по дням: дата → { state: 'loading' | 'free' | 'full' | 'off' | 'closed' | 'error', slots, response, error } */
const days = new Map();
let selectedDate = null;
/** Выбранный слот: { startsAt, endsAt, masterIds? } */
let selectedSlot = null;
/** Для сводки: длительность и цена из ответа сервера, имена мастеров */
let visit = null;
let masterNames = new Map();
/** Действующие предстоящие записи вошедшего клиента — пометка «У вас запись в это время» (пункт 5) */
let myBookings = [];

// ---------- Даты по календарю студии ----------

const pad = (n) => String(n).padStart(2, '0');
const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const addMonths = (first, n) => {
  const [y, m] = first.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
const isoWeekday = (date) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
/** Полдень даты в UTC — чтобы подписи дня не съезжали из-за часового пояса */
const noon = (date) => `${date}T12:00:00Z`;
const dayText = (date) => dateLabel(noon(date), 'UTC');

/** Часы студии на дату: особый день важнее режима по дню недели. null — студия закрыта. */
function studioHours(date) {
  const special = specialDays.get(date);
  if (special) return special.isOpen ? { open: special.open, close: special.close } : null;
  const regular = studio.hours.find((h) => h.weekday === isoWeekday(date));
  return regular ? { open: regular.open, close: regular.close } : null;
}

/** Состояние дня без запроса к API: прошлое, за горизонтом, студия закрыта. Иначе null — нужен запрос. */
function staticState(date) {
  if (date < today || date > lastDay) return 'off';
  return studioHours(date) ? null : 'closed';
}

// ---------- Запросы слотов ----------

/** Запросы, которые уже идут: дата → обещание ответа (чтобы один день не запрашивать дважды) */
const inflight = new Map();

function fetchDay(date) {
  const cached = days.get(date);
  if (cached && cached.state !== 'error' && cached.state !== 'loading') return Promise.resolve(cached);
  if (inflight.has(date)) return inflight.get(date);
  const fixed = staticState(date);
  if (fixed) {
    const entry = { state: fixed, slots: [] };
    days.set(date, entry);
    return Promise.resolve(entry);
  }
  days.set(date, { state: 'loading', slots: [] });
  const promise = requestDay(date).finally(() => inflight.delete(date));
  inflight.set(date, promise);
  return promise;
}

async function requestDay(date) {
  try {
    const response = rescheduleId
      ? await api.getMasterSlots(masterId, { date, bookingId: rescheduleId })
      : masterId !== null
        ? await api.getMasterSlots(masterId, { date, services })
        : await api.getSlots({ date, services });
    let state = response.slots.length ? 'free' : 'full';
    if (response.day?.status === 'master_off' || response.day?.status === 'master_inactive') state = 'off';
    if (response.day?.status === 'studio_closed') state = 'closed';
    const entry = { state, slots: response.slots, response };
    days.set(date, entry);
    rememberVisit(response);
    return entry;
  } catch (error) {
    const entry = { state: 'error', slots: [], error };
    days.set(date, entry);
    // Перенос стал недоступен (прошел срок, запись отменили) — сервер объясняет почему
    if (rescheduleId && error instanceof api.ApiError && (error.status === 403 || error.status === 409)) showBlocked(error.message);
    return entry;
  }
}

/** Длительность и цена визита — из ответа сервера (у конкретного мастера — priceKop, у «любого» — у каждого свой). */
function rememberVisit(response) {
  if (visit) return;
  if (masterId !== null) {
    visit = { durationMin: response.durationMin, priceText: money(response.priceKop) };
  } else {
    const prices = response.masters.map((m) => m.priceKop);
    const min = Math.min(...prices);
    visit = { durationMin: response.durationMin, priceText: min === Math.max(...prices) ? money(min) : `от ${money(min)}` };
    masterNames = new Map(response.masters.map((m) => [m.id, m.name]));
  }
  $('[data-summary-duration]').textContent = duration(visit.durationMin);
}

/** Все дни месяца: ограниченно параллельно, календарь перерисовывается по мере ответов. */
async function loadMonth(first) {
  const dates = [];
  for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) dates.push(d);
  const queue = dates.filter((d) => !days.has(d) || days.get(d).state === 'error');
  renderCalendar();
  const worker = async () => {
    while (queue.length) {
      const date = queue.shift();
      await fetchDay(date);
      if (month === first) renderCalendar();
      if (date === selectedDate) renderDay();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (month === first) renderMonthNote(dates);
}

/** Ближайшие даты со свободным временем после date: из загруженного, затем по дню вперед до горизонта. */
async function nextFreeDates(date, count, maxDays = 62) {
  const found = [];
  for (let d = date, i = 0; d <= lastDay && i < maxDays && found.length < count; d = addDays(d, 1), i++) {
    const entry = await fetchDay(d);
    if (entry.state === 'free') found.push(d);
  }
  return found;
}

// ---------- Календарь ----------

const monthTitle = (first) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(noon(first)))
    .replace(/\s*г\.$/, '');

const STATE_TEXT = {
  free: 'есть свободное время',
  full: 'мест нет',
  off: 'недоступно',
  closed: 'студия закрыта',
  loading: 'загружаем',
  error: 'не удалось загрузить',
};

function dayState(date) {
  const fixed = staticState(date);
  if (fixed === 'off') return date < today ? 'past' : 'beyond';
  if (fixed) return fixed;
  return days.get(date)?.state ?? 'loading';
}

function renderCalendar() {
  const [y, m] = month.split('-').map(Number);
  $('[data-month-title]').textContent = monthTitle(month);
  $('[data-prev-month]').disabled = month <= today.slice(0, 8) + '01';
  $('[data-next-month]').disabled = addMonths(month, 1) > lastDay;

  const horizon = /** @type {HTMLElement} */ ($('[data-horizon]'));
  horizon.hidden = lastDay.slice(0, 7) !== month.slice(0, 7);
  horizon.textContent = `Запись открыта до ${dayText(lastDay).replace(/^[^,]+,\s*/, '')}`;

  const blanks = isoWeekday(month) - 1;
  const cells = Array.from({ length: blanks }, () => '<span class="calendar__blank" aria-hidden="true"></span>');
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= count; d++) {
    const date = `${month.slice(0, 8)}${pad(d)}`;
    const state = dayState(date);
    const special = specialDays.get(date);
    // Прошедшие дни, выходные мастера и закрытые дни видны, но недоступны; «мест нет» можно открыть — там подсказки;
    // день, который еще грузится, тоже можно открыть — справа будет индикатор загрузки
    const clickable = state === 'free' || state === 'full' || state === 'error' || state === 'loading';
    const reason = state === 'closed' && special?.reason ? `: ${special.reason}` : '';
    const isOriginal = date === originalDate;
    const label = `${dayText(date)} — ${state === 'past' ? 'прошел' : state === 'beyond' ? 'запись еще не открыта' : state === 'off' ? 'выходной мастера' : STATE_TEXT[state]}${reason}${isOriginal ? '; день вашей записи' : ''}`;
    cells.push(`
      <button class="day day--${state}${date === selectedDate ? ' is-selected' : ''}${date === today ? ' is-today' : ''}${isOriginal ? ' is-original' : ''}" type="button"
              data-date="${date}" aria-label="${esc(label)}" title="${esc(label)}"
              ${clickable ? '' : 'disabled'} ${date === selectedDate ? 'aria-pressed="true"' : ''}>${d}</button>`);
  }
  daysBox.innerHTML = cells.join('');
}

/** «В этом месяце свободного времени нет» — вместо проверки всего горизонта (пункт 4.4). */
function renderMonthNote(dates) {
  const note = /** @type {HTMLElement} */ ($('[data-month-note]'));
  const states = dates.map(dayState);
  const pending = states.some((s) => s === 'loading');
  const anyFree = states.includes('free');
  note.hidden = pending || anyFree;
  if (!note.hidden) {
    note.innerHTML = addMonths(month, 1) <= lastDay
      ? 'В этом месяце свободного времени нет. <button class="text-link" type="button" data-note-next>Следующий месяц →</button>'
      : 'В этом месяце свободного времени нет, а запись дальше пока не открыта.';
  }
}

// ---------- «У вас запись в это время» (docs/ui-map.md, список 1, пункт 5) ----------

/** Запись клиента, которая пересекается со слотом [startsAt, endsAt). Сервер вторую запись не запрещает — только предупреждаем. */
const myOverlap = (slot) => myBookings.find((b) =>
  Date.parse(slot.startsAt) < Date.parse(b.endsAt) && Date.parse(slot.endsAt) > Date.parse(b.startsAt));

const bookingWhen = (b) => `${dateLabel(b.startsAt, studio.timezone)}, ${timeLabel(b.startsAt, studio.timezone)}–${timeLabel(b.endsAt, studio.timezone)}`;

/** Только для вошедшего клиента; не удалось загрузить — пометки просто нет, выбор времени не страдает. */
async function loadMyBookings() {
  try {
    const user = await api.getMe();
    if (!hasRole(user, 'client')) return;
    myBookings = (await api.getBookings({ period: 'upcoming' })).filter((b) => b.status === 'active' && b.id !== rescheduleId);
    if (selectedDate) renderDay();
  } catch {
    myBookings = [];
  }
}

// ---------- Сетка дня ----------

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/**
 * Клетки сетки: возможные начала визита по часам студии и шагу записи. Свободные — из ответа сервера;
 * если сервер прислал время вне этого шага, оно тоже попадает в сетку.
 */
function gridCells(date, entry) {
  const tz = studio.timezone;
  const free = new Map(entry.slots.map((s) => [timeLabel(s.startsAt, tz), s]));
  const hours = studioHours(date);
  const labels = new Set(free.keys());
  if (hours && visit) {
    const last = toMinutes(hours.close) - visit.durationMin;
    for (let t = toMinutes(hours.open); t <= last; t += studio.rules.slotStepMin) labels.add(toHHMM(t));
  }
  // Перенос: текущее время записи — отдельная клетка «сейчас», даже если ее нет в сетке шага
  const current = original && date === originalDate ? timeLabel(original.startsAt, tz) : null;
  if (current) labels.add(current);
  return [...labels].sort().map((label) => ({ label, slot: free.get(label) ?? null, current: label === current }));
}

function renderDay() {
  if (!selectedDate) return;
  const entry = days.get(selectedDate) ?? { state: 'loading', slots: [] };
  dayTitle.textContent = `Свободное время · ${dayText(selectedDate)}`;

  // 1. Загрузка — индикатор, а не пустая сетка
  if (entry.state === 'loading') {
    dayBody.innerHTML = `
      <div class="loader" role="status">
        <span class="loader__spinner" aria-hidden="true"></span>
        <span>Загружаем свободное время…</span>
      </div>`;
    return;
  }

  // 2. Ошибка API — текстом, с повтором
  if (entry.state === 'error') {
    dayBody.innerHTML = `
      <div class="state-box" role="alert">
        <p class="state-box__title">Не удалось загрузить расписание</p>
        <p class="state-box__text">${esc(entry.error.message)}</p>
        <button class="btn btn--primary btn--small" type="button" data-retry-day>Обновить</button>
      </div>`;
    return;
  }

  // 3. Мест нет — отдельное состояние с ближайшим временем и подсказками
  if (entry.state !== 'free') {
    renderNoSlots(entry);
    return;
  }

  // 4. Сетка: свободное время активно, занятое видно и неактивно
  const cells = gridCells(selectedDate, entry);
  const mine = [...new Set(entry.slots.map(myOverlap).filter(Boolean))];
  const groups = GROUPS.map((g, i) => ({
    label: g.label,
    cells: cells.filter((c) => {
      const hour = Number(c.label.slice(0, 2));
      return hour < g.until && (i === 0 || hour >= GROUPS[i - 1].until);
    }),
  })).filter((g) => g.cells.length);

  dayBody.innerHTML = `
    ${groups.map((g) => `
      <div class="slot-group">
        <p class="slot-group__title">${g.label}</p>
        <div class="slot-group__grid">
          ${g.cells.map((c) => c.current
            ? `<button class="slot slot--current" type="button" disabled aria-label="${c.label} — ваша запись сейчас" title="Ваша запись сейчас">${c.label}<span class="slot__note">сейчас</span></button>`
            : c.slot
            ? `<button class="slot${selectedSlot?.startsAt === c.slot.startsAt ? ' is-selected' : ''}${myOverlap(c.slot) ? ' slot--mine' : ''}" type="button"
                       data-slot="${esc(c.slot.startsAt)}" aria-pressed="${selectedSlot?.startsAt === c.slot.startsAt}"
                       ${myOverlap(c.slot) ? `aria-label="${c.label} — у вас запись в это время" title="У вас запись в это время"` : ''}>${c.label}</button>`
            : `<button class="slot slot--busy" type="button" disabled aria-label="${c.label} — занято" title="Занято">${c.label}</button>`).join('')}
        </div>
      </div>`).join('')}
    <ul class="slot-legend">
      <li><span class="slot-legend__mark" aria-hidden="true"></span>свободно</li>
      <li><span class="slot-legend__mark slot-legend__mark--busy" aria-hidden="true"></span>занято</li>
      ${mine.length ? '<li><span class="slot-legend__mark slot-legend__mark--mine" aria-hidden="true"></span>у вас запись в это время</li>' : ''}
      ${cells.some((c) => c.current) ? '<li><span class="slot-legend__mark slot-legend__mark--current" aria-hidden="true"></span>ваша запись сейчас</li>' : ''}
    </ul>
    ${mine.length ? `<p class="slot-mine-note">У вас уже есть запись в этот день: ${mine.map((b) =>
      `<a class="text-link" href="${esc(routes.bookingCard(b.id))}">${esc(bookingWhen(b))}</a>`).join(', ')}. Время с рамкой пересекается с ней.</p>` : ''}
    <p class="slot-result" data-slot-result aria-live="polite"></p>`;
  renderSlotResult();
}

/** Под сеткой — во сколько закончится визит: конец слота из ответа сервера. */
function renderSlotResult() {
  const box = dayBody.querySelector('[data-slot-result]');
  if (!box) return;
  const onThisDay = selectedSlot && days.get(selectedDate)?.slots.some((s) => s.startsAt === selectedSlot.startsAt);
  if (!onThisDay) {
    box.textContent = 'Выберите время — покажем, когда закончится визит.';
    box.classList.remove('is-chosen');
    return;
  }
  const tz = studio.timezone;
  const who = masterId === null && selectedSlot.masterIds?.length
    ? ` Свободны: ${selectedSlot.masterIds.map((id) => masterNames.get(id)).filter(Boolean).join(', ')} — мастера назначим при бронировании.`
    : '';
  const overlap = myOverlap(selectedSlot);
  const warning = overlap
    ? `<span class="slot-result__warning">В это время у вас уже есть запись — <a class="text-link" href="${esc(routes.bookingCard(overlap.id))}">${esc(bookingWhen(overlap))}</a>. Проверьте, что вторая запись не по ошибке.</span>`
    : '';
  box.innerHTML = `Начало в <strong>${esc(timeLabel(selectedSlot.startsAt, tz))}</strong>, визит закончится в <strong>${esc(timeLabel(selectedSlot.endsAt, tz))}</strong>.${esc(who)}${warning}`;
  box.classList.add('is-chosen');
}

async function renderNoSlots(entry) {
  const reason = entry.state === 'off' ? 'У мастера выходной'
    : entry.state === 'closed' ? 'Студия в этот день закрыта'
    : 'На этот день свободного времени нет';
  const hints = rescheduleId ? [
    '<li>Посмотрите другие дни в календаре — дни с точкой свободны</li>',
    '<li>Мастер и услуги при переносе не меняются. Чтобы записаться к другому мастеру, отмените запись и создайте новую</li>',
    `<li>Нужна помощь — позвоните в студию: <a class="text-link" href="${esc(phoneHref(studio.phone))}">${esc(formatPhone(studio.phone))}</a></li>`,
  ].join('') : [
    masterId !== null && draft.lockedMasterId === null
      ? '<li><a class="text-link" href="booking-master.html">Выберите «Любой свободный мастер»</a> — так свободного времени больше</li>' : '',
    masterId !== null
      ? `<li><a class="text-link" href="${draft.lockedMasterId !== null ? 'booking-services.html' : 'booking-master.html'}">Выберите другого мастера</a></li>` : '',
    '<li><a class="text-link" href="booking-services.html">Уберите услугу</a> — короткий визит проще поставить</li>',
    '<li>Посмотрите другие дни в календаре — дни с точкой свободны</li>',
  ].join('');
  dayBody.innerHTML = `
    <div class="no-slots">
      <p class="no-slots__title">${reason}</p>
      <div data-suggestions>
        <div class="loader loader--inline" role="status"><span class="loader__spinner" aria-hidden="true"></span><span>Ищем ближайшее свободное время…</span></div>
      </div>
      <p class="no-slots__subtitle">Как найти время</p>
      <ul class="no-slots__hints">${hints}</ul>
    </div>`;

  const date = selectedDate;
  const found = await nextFreeDates(addDays(date, 1), 3);
  if (selectedDate !== date) return;
  const box = dayBody.querySelector('[data-suggestions]');
  if (!box) return;
  renderCalendar();
  if (!found.length) {
    box.innerHTML = '<p class="no-slots__text">В ближайшие два месяца свободного времени нет — попробуйте другого мастера или другой набор услуг.</p>';
    return;
  }
  const first = days.get(found[0]).slots[0];
  box.innerHTML = `
    <p class="no-slots__text">Ближайшее свободное время: <strong>${esc(dayText(found[0]))}, ${esc(timeLabel(first.startsAt, studio.timezone))}</strong></p>
    <div class="no-slots__dates">
      <button class="btn btn--primary btn--small" type="button" data-pick-slot="${esc(first.startsAt)}" data-pick-date="${found[0]}">Выбрать ${esc(timeLabel(first.startsAt, studio.timezone))}</button>
      ${found.map((d) => `<button class="btn btn--outline btn--small" type="button" data-pick-date="${d}">${esc(dayText(d))}</button>`).join('')}
    </div>`;
}

// ---------- Выбор ----------

/** @param {string} date @param {{ scroll?: boolean }} [options] scroll — день выбран кликом: на телефоне показать его время */
function selectDate(date, options = {}) {
  selectedDate = date;
  if (selectedSlot && !days.get(date)?.slots.some((s) => s.startsAt === selectedSlot.startsAt)) selectSlot(null);
  renderCalendar();
  renderDay();
  if (!days.has(date) || days.get(date).state === 'error') fetchDay(date).then(() => { renderCalendar(); if (selectedDate === date) renderDay(); });
  // Календарь и время стоят друг под другом до 1024px: без прокрутки время дня оказалось бы за краем экрана
  if (options.scroll && window.matchMedia('(max-width: 1023px)').matches) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('[data-day]').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
}

function selectSlot(slot) {
  selectedSlot = slot;
  if (!rescheduleId) updateDraft({ startsAt: slot?.startsAt ?? null });
  renderBar();
  dayBody.querySelectorAll('[data-slot]').forEach((b) => {
    const on = b.getAttribute('data-slot') === slot?.startsAt;
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-pressed', String(on));
  });
  renderSlotResult();
}

function renderBar(message = null) {
  if (!selectedSlot) {
    totalText.textContent = 'Время не выбрано';
    hintText.textContent = message ?? 'Выберите день и время';
    hintText.classList.toggle('cart__hint--warning', Boolean(message));
    continueButton.disabled = true;
    return;
  }
  const tz = studio.timezone;
  const who = masterId !== null ? $('[data-summary-master]').textContent : 'Любой свободный мастер';
  totalText.textContent = `${rescheduleId ? 'Новое время: ' : ''}${dayText(selectedDate)}, ${timeLabel(selectedSlot.startsAt, tz)}–${timeLabel(selectedSlot.endsAt, tz)} · ${who}`;
  hintText.textContent = message ?? (visit ? `${visit.priceText} · ${duration(visit.durationMin)}` : '');
  hintText.classList.toggle('cart__hint--warning', Boolean(message));
  continueButton.disabled = false;
}

async function showMonth(first) {
  month = first;
  renderCalendar();
  await loadMonth(first);
}

/** «Ближайшее свободное время»: первый день со слотами от сегодня, в нем — первое время. */
async function pickNearest() {
  nearestButton.disabled = true;
  const [date] = await nextFreeDates(today, 1, 400);
  nearestButton.disabled = false;
  if (!date) {
    renderBar('Свободного времени на весь срок записи нет — выберите другого мастера');
    return;
  }
  if (date.slice(0, 7) !== month.slice(0, 7)) await showMonth(`${date.slice(0, 8)}01`);
  selectDate(date);
  selectSlot(days.get(date).slots[0]);
}

// ---------- «Продолжить»: бронь времени ----------

const taken = /** @type {HTMLDialogElement} */ ($('[data-taken]'));

async function hold(startsAt, holdMasterId) {
  continueButton.disabled = true;
  continueButton.textContent = 'Закрепляем время…';
  if (rescheduleId) return holdForReschedule(startsAt);
  try {
    const result = await api.createHold({ masterId: holdMasterId, startsAt, services: draft.items });
    // Для «Любого мастера» мастера назначил сервер — запоминаем, флаг «любой» остается
    updateDraft({ startsAt: result.startsAt, masterId: draft.lockedMasterId ?? result.master.id });
    window.location.assign(routes.bookingConfirm);
  } catch (error) {
    continueButton.textContent = 'Продолжить';
    continueButton.disabled = false;
    if (!(error instanceof api.ApiError)) return renderBar('Что-то пошло не так. Попробуйте еще раз.');
    if (error.status === 401) {
      // Бронь только после входа; выбор уже в черновике — после входа клиент вернется сюда
      window.location.assign(`${routes.login}?next=${encodeURIComponent(routes.bookingTimeStep)}`);
      return;
    }
    if (error.code === 'SLOT_TAKEN') return showTaken(error);
    renderBar(error.message);
  }
}

function showTaken(error) {
  const tz = studio.timezone;
  const alternatives = /** @type {any} */ (error.details)?.alternatives ?? [];
  $('[data-taken-text]').textContent = error.message;
  $('[data-taken-options]').innerHTML = alternatives.slice(0, 8).map((a) => `
    <button class="btn btn--outline btn--small" type="button" data-alt-start="${esc(a.startsAt)}" data-alt-master="${a.masterId}">
      ${esc(dateLabel(a.startsAt, tz))}, ${esc(timeLabel(a.startsAt, tz))}${masterId === null && masterNames.get(a.masterId) ? ` · ${esc(masterNames.get(a.masterId))}` : ''}
    </button>`).join('');
  // Время на этот день изменилось — перезапросим, когда клиент вернется к сетке
  days.delete(selectedDate);
  selectSlot(null);
  taken.showModal();
}

$('[data-taken-options]').addEventListener('click', (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('[data-alt-start]');
  if (!button) return;
  taken.close();
  hold(button.getAttribute('data-alt-start'), masterId === null ? Number(button.getAttribute('data-alt-master')) : masterId);
});
$('[data-taken-close]').addEventListener('click', () => {
  taken.close();
  selectDate(selectedDate);
});

// ---------- События ----------

daysBox.addEventListener('click', (event) => {
  const day = /** @type {HTMLElement} */ (event.target).closest('[data-date]');
  if (day && !(/** @type {HTMLButtonElement} */ (day)).disabled) selectDate(day.getAttribute('data-date'), { scroll: true });
});

dayBody.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const slot = target.closest('[data-slot]');
  if (slot) {
    const startsAt = slot.getAttribute('data-slot');
    selectSlot(days.get(selectedDate).slots.find((s) => s.startsAt === startsAt));
    return;
  }
  const pick = target.closest('[data-pick-date]');
  if (pick) {
    const date = pick.getAttribute('data-pick-date');
    const startsAt = pick.getAttribute('data-pick-slot');
    const go = async () => {
      if (date.slice(0, 7) !== month.slice(0, 7)) await showMonth(`${date.slice(0, 8)}01`);
      selectDate(date);
      if (startsAt) selectSlot(days.get(date).slots.find((s) => s.startsAt === startsAt));
    };
    go();
    return;
  }
  if (target.closest('[data-retry-day]')) {
    days.delete(selectedDate);
    selectDate(selectedDate);
  }
});

$('[data-month-note]').addEventListener('click', (event) => {
  if (/** @type {HTMLElement} */ (event.target).closest('[data-note-next]')) showMonth(addMonths(month, 1));
});
$('[data-prev-month]').addEventListener('click', () => showMonth(addMonths(month, -1)));
$('[data-next-month]').addEventListener('click', () => showMonth(addMonths(month, 1)));
nearestButton.addEventListener('click', pickNearest);
continueButton.addEventListener('click', () => {
  if (selectedSlot) hold(selectedSlot.startsAt, masterId);
});

// ---------- Перенос записи (CAB-04) ----------

/** Показать один из режимов переноса: выбор времени, «Было → Стало», «перенесена», «недоступен». */
function showReschedule(view) {
  $('[data-picker]').hidden = view !== 'pick';
  $('[data-cart]').hidden = view !== 'pick';
  $('[data-current]').hidden = view !== 'pick';
  $('[data-compare]').hidden = view !== 'compare';
  $('[data-rescheduled]').hidden = view !== 'done';
  $('[data-blocked]').hidden = view !== 'blocked';
  if (view !== 'compare') clearInterval(compareTick);
}

/** Перенести нельзя — текст сервера (правило 24 часов с телефоном студии, запись уже отменена и т. п.) */
function showBlocked(message, title = 'Перенос недоступен') {
  $('[data-blocked-title]').textContent = title;
  $('[data-blocked-text]').textContent = message;
  if (studio) {
    const phone = /** @type {HTMLAnchorElement} */ ($('[data-blocked-phone]'));
    phone.href = phoneHref(studio.phone);
    phone.textContent = `Позвонить: ${formatPhone(studio.phone)}`;
    phone.hidden = false;
  }
  showReschedule('blocked');
}

/** Запись, которую переносим: услуги, мастер, текущее время, версия для защиты от одновременного изменения. */
async function loadOriginal() {
  const bookingHref = routes.bookingCard(rescheduleId);
  $('[data-back]').setAttribute('href', bookingHref);
  $('[data-back-to-booking]').setAttribute('href', bookingHref);
  $('[data-done-booking]').setAttribute('href', bookingHref);
  document.querySelector('booking-steps')?.remove();
  const title = /** @type {HTMLElement} */ ($('[data-page-title]'));
  title.textContent = 'Перенос записи';
  title.className = 'booking__title';
  document.title = 'Перенос записи — Ноготочки';
  // Услуги и мастер зафиксированы — «Изменить» у них нет
  $('[data-summary]').querySelectorAll('a').forEach((a) => a.remove());

  try {
    original = await api.getBooking(rescheduleId);
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 401) {
      window.location.assign(`${routes.login}?next=${encodeURIComponent(routes.reschedule(rescheduleId))}`);
      return false;
    }
    const notFound = error instanceof api.ApiError && (error.status === 404 || error.status === 403);
    showBlocked(error.message, notFound ? 'Запись не найдена' : 'Не удалось загрузить запись');
    return false;
  }
  masterId = original.master.id;
  originalDate = new Intl.DateTimeFormat('en-CA', { timeZone: studio.timezone }).format(new Date(original.startsAt));
  $('[data-current-when]').textContent = `${bookingWhen(original)} · ${original.master.name}`;
  $('[data-legend-original]').hidden = false;
  continueButton.textContent = 'Продолжить';
  showReschedule('pick');
  return true;
}

/** Выбранное новое время закрепляем бронью с bookingId и показываем «Было → Стало». */
async function holdForReschedule(startsAt) {
  try {
    const result = await api.createHold({ bookingId: rescheduleId, startsAt, masterId });
    continueButton.textContent = 'Продолжить';
    continueButton.disabled = false;
    showCompare(result);
  } catch (error) {
    continueButton.textContent = 'Продолжить';
    continueButton.disabled = false;
    rescheduleError(error, (msg) => renderBar(msg));
  }
}

/** Отказы сервера при переносе — его текстом; куда показать обычную ошибку, решает вызывающий. */
function rescheduleError(error, showMessage) {
  if (!(error instanceof api.ApiError)) return showMessage('Что-то пошло не так. Попробуйте еще раз.');
  if (error.status === 401) {
    window.location.assign(`${routes.login}?next=${encodeURIComponent(routes.reschedule(rescheduleId))}`);
    return;
  }
  if (error.code === 'SLOT_TAKEN') {
    showReschedule('pick');
    return showTaken(error);
  }
  if (error.code === 'CHANGE_DEADLINE_PASSED' || error.code === 'BOOKING_NOT_ACTIVE') return showBlocked(error.message);
  showMessage(error.message);
}

let compareHold = null;
let compareTick = 0;

function showCompare(newHold) {
  compareHold = newHold;
  const tz = studio.timezone;
  const alert = /** @type {HTMLElement} */ ($('[data-compare-alert]'));
  alert.hidden = true;
  $('[data-was-when]').textContent = bookingWhen(original);
  $('[data-was-master]').textContent = original.master.name;
  $('[data-was-price]').textContent = money(original.totalPriceKop);
  $('[data-new-when]').textContent = `${dateLabel(newHold.startsAt, tz)}, ${timeLabel(newHold.startsAt, tz)}–${timeLabel(newHold.endsAt, tz)}`;
  $('[data-new-master]').textContent = newHold.master.name;
  // Цена — от сервера: меняется только у мастера другого уровня
  const priceChanged = newHold.priceKop !== original.totalPriceKop;
  $('[data-new-price]').textContent = money(newHold.priceKop) + (priceChanged ? ' — цена изменилась' : '');
  $('[data-new-price]').classList.toggle('is-changed', priceChanged);
  /** @type {HTMLButtonElement} */ ($('[data-compare-confirm]')).disabled = false;
  showReschedule('compare');
  window.scrollTo({ top: 0 });

  // Таймер брони — по secondsLeft сервера; меньше минуты — как на подтверждении записи
  const deadline = Date.now() + newHold.secondsLeft * 1000;
  const timerBox = /** @type {HTMLElement} */ ($('[data-compare-timer]'));
  const update = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    $('[data-compare-left]').textContent = `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
    timerBox.classList.toggle('is-soon', left <= 60);
    $('[data-compare-soon]').hidden = left > 60 || left === 0;
    if (left === 0) {
      clearInterval(compareTick);
      showAlert(alert, 'warning', 'Время брони истекло. Нажмите «Назад» и выберите время снова — проверим, свободно ли оно.');
      /** @type {HTMLButtonElement} */ ($('[data-compare-confirm]')).disabled = true;
    }
  };
  clearInterval(compareTick);
  update();
  compareTick = setInterval(update, 1000);
}

$('[data-compare-back]').addEventListener('click', () => {
  showReschedule('pick');
  // Время могло измениться, пока клиент смотрел сравнение
  days.delete(selectedDate);
  selectDate(selectedDate);
});

$('[data-compare-confirm]').addEventListener('click', async () => {
  const button = /** @type {HTMLButtonElement} */ ($('[data-compare-confirm]'));
  const alert = /** @type {HTMLElement} */ ($('[data-compare-alert]'));
  alert.hidden = true;
  const done = setBusy(button, 'Переносим…');
  try {
    const reason = /** @type {HTMLInputElement} */ ($('[data-reason]')).value.trim();
    const booking = await api.rescheduleBooking(rescheduleId, {
      startsAt: compareHold.startsAt,
      reason: reason || null,
      version: original.version,
    });
    const tz = studio.timezone;
    $('[data-done-when]').textContent = `${dateLabel(booking.startsAt, tz)}, ${timeLabel(booking.startsAt, tz)}–${timeLabel(booking.endsAt, tz)}`;
    $('[data-done-what]').textContent = `${booking.master.name} · ${money(booking.totalPriceKop)}`;
    showReschedule('done');
    /** @type {HTMLElement} */ ($('.rescheduled__title')).focus();
  } catch (error) {
    done();
    rescheduleError(error, (message) => {
      // Запись изменили в студии или бронь истекла — «Перенос не выполнен» с текстом сервера
      showAlert(alert, 'error', `Перенос не выполнен. ${message}`);
      if (error instanceof api.ApiError && error.code === 'VERSION_CONFLICT') {
        alert.insertAdjacentHTML('beforeend', ' <button class="text-link" type="button" data-reload-page>Обновить</button>');
        alert.querySelector('[data-reload-page]').addEventListener('click', () => window.location.reload());
      }
    });
  }
});

// ---------- Загрузка ----------

async function loadSummary() {
  if (original) {
    $('[data-summary-services]').textContent = original.items
      .map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ');
    $('[data-summary-master]').textContent = original.master.name;
    $('[data-summary-duration]').textContent = duration(original.durationMin);
    return;
  }
  const [catalog, masters] = await Promise.all([api.getServices(), api.getMasters()]);
  const names = new Map(catalog.categories.flatMap((c) => c.services).map((s) => [s.id, s.name]));
  $('[data-summary-services]').textContent = draft.items
    .map((i) => `${names.get(i.serviceId) ?? `услуга № ${i.serviceId}`}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ');
  $('[data-summary-master]').textContent = masterId !== null
    ? masters.masters.find((m) => m.id === masterId)?.name ?? 'Мастер недоступен'
    : 'Любой свободный мастер';
}

async function load() {
  try {
    studio = await api.getStudio();
    today = new Intl.DateTimeFormat('en-CA', { timeZone: studio.timezone }).format(new Date());
    lastDay = addDays(today, studio.rules.bookingHorizonDays - 1);
    const special = await api.getStudioDays({ from: today, to: lastDay });
    specialDays = new Map(special.days.map((d) => [d.date, d]));
  } catch (error) {
    dayBody.innerHTML = `
      <div class="state-box" role="alert">
        <p class="state-box__title">Не удалось загрузить расписание студии</p>
        <p class="state-box__text">${esc(error.message)}</p>
        <button class="btn btn--primary btn--small" type="button" data-reload>Обновить</button>
      </div>`;
    dayBody.querySelector('[data-reload]').addEventListener('click', () => window.location.reload());
    return;
  }
  if (rescheduleId && !(await loadOriginal())) return;
  loadMyBookings();
  loadSummary().catch((error) => {
    $('[data-summary-services]').textContent = `не удалось загрузить (${error.message})`;
    $('[data-summary-master]').textContent = '—';
  });

  // Перенос: открываем день текущей записи — ее время видно в сетке отдельным состоянием
  if (rescheduleId) {
    const start = originalDate >= today && originalDate <= lastDay ? originalDate : today;
    await showMonth(`${start.slice(0, 8)}01`);
    nearestButton.disabled = false;
    if (start === originalDate) selectDate(originalDate);
    return;
  }

  // Выбор из черновика (вернулись со входа или с подтверждения) — открываем его день и время
  const saved = draft.startsAt;
  const savedDate = saved ? new Intl.DateTimeFormat('en-CA', { timeZone: studio.timezone }).format(new Date(saved)) : null;
  const start = savedDate && savedDate >= today && savedDate <= lastDay ? savedDate : today;
  const monthLoad = showMonth(`${start.slice(0, 8)}01`);
  nearestButton.disabled = false;

  if (savedDate && start === savedDate) {
    selectDate(savedDate);
    const entry = await fetchDay(savedDate);
    const slot = entry.slots.find((s) => s.startsAt === saved);
    if (slot) selectSlot(slot);
    else {
      updateDraft({ startsAt: null });
      renderBar('Выбранное раньше время уже занято — выберите другое');
    }
    renderCalendar();
    renderDay();
    return;
  }
  // Первый раз на шаге — сразу открываем ближайший свободный день текущего месяца
  await monthLoad;
  if (!selectedDate) {
    const [first] = await nextFreeDates(today, 1, 31);
    if (first && !selectedDate) {
      if (first.slice(0, 7) !== month.slice(0, 7)) await showMonth(`${first.slice(0, 8)}01`);
      selectDate(first);
    }
  }
}

if (ready) load();
