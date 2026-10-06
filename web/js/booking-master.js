// BOOK-02 Шаг 2. Мастер (docs/ui-map.md). Данные:
//   GET /api/masters?services=… — мастера, которые выполняют ВСЕ услуги визита, у каждого visit: цена и длительность
//                                 по его уровню (сервер считает сам);
//   GET /api/masters            — все активные мастера: кто не подходит и какие услуги не выполняет;
//   GET /api/services           — названия услуг для «Не выполняет: …»;
//   GET /api/studio             — часовой пояс и горизонт записи для «Ближайшее: …»;
//   GET /api/masters/:id/slots  — «Ближайшее: …» (docs/ui-map.md, список 1, пункт 3): по дню, пока не найдется
//                                 слот, не дальше 14 дней, мастера параллельно; не нашлось — строки нет.
// Выбор — в черновике записи (js/store.js). «Далее» → BOOK-03; «Изменить», «← Назад» → BOOK-01.
import * as api from './api.js';
import { dateLabel, duration, escapeHtml as esc, initials, money, plural, timeLabel } from './format.js';
import { routes } from './routes.js';
import { getDraft, parseServicesParam, servicesParam, startDraft, updateDraft } from './store.js';

const $ = (selector) => document.querySelector(selector);

const list = /** @type {HTMLElement} */ ($('[data-masters]'));
const summary = /** @type {HTMLElement} */ ($('[data-summary]'));
const totalText = /** @type {HTMLElement} */ ($('[data-total]'));
const hintText = /** @type {HTMLElement} */ ($('[data-hint]'));
const nextButton = /** @type {HTMLButtonElement} */ ($('[data-next]'));

const NEAREST_DAYS = 14;
const LEVELS = { master: 'Мастер', top_master: 'Топ-мастер' };

// ?services=1 — популярная услуга из кабинета ведет сразу сюда (CAB-01): это начало новой записи
{
  const params = new URLSearchParams(window.location.search);
  if (params.has('services')) {
    startDraft({ items: parseServicesParam(params.get('services')) });
    history.replaceState(null, '', window.location.pathname);
  }
}

const draft = getDraft();
// Без услуг выбирать мастера не из чего; при закрепленном мастере этот шаг пропускается
if (!draft.items.length) window.location.replace(routes.booking());
else if (draft.lockedMasterId !== null) window.location.replace(routes.bookingTimeStep);

const services = servicesParam(draft.items);
const countText = (n) => `${n} ${plural(n, 'услуга', 'услуги', 'услуг')}`;

/** Подходящие мастера из ответа сервера — по номеру */
let suitable = new Map();

// ---------- Выбор ----------

function selectionValue() {
  const d = getDraft();
  if (d.anyMaster) return 'any';
  return d.masterId !== null && suitable.has(d.masterId) ? String(d.masterId) : null;
}

function renderSelection() {
  const value = selectionValue();
  if (value === null) {
    totalText.textContent = 'Мастер не выбран';
    hintText.textContent = 'Выберите мастера или «Любой свободный мастер»';
    nextButton.disabled = true;
    return;
  }
  const masters = [...suitable.values()];
  if (value === 'any') {
    const min = Math.min(...masters.map((m) => m.visit.priceKop));
    const max = Math.max(...masters.map((m) => m.visit.priceKop));
    totalText.textContent = `Любой свободный мастер · ${min === max ? money(min) : `от ${money(min)}`}`;
    hintText.textContent = `${duration(masters[0].visit.durationMin)} · мастера назначим при записи`;
  } else {
    const m = suitable.get(Number(value));
    totalText.textContent = `${m.name} · ${money(m.visit.priceKop)}`;
    hintText.textContent = duration(m.visit.durationMin);
  }
  nextButton.disabled = false;
}

list.addEventListener('change', (event) => {
  const value = /** @type {HTMLInputElement} */ (event.target).value;
  updateDraft(value === 'any' ? { anyMaster: true, masterId: null } : { anyMaster: false, masterId: Number(value) });
  renderSelection();
});

nextButton.addEventListener('click', () => {
  if (selectionValue() !== null) window.location.assign(routes.bookingTimeStep);
});

// ---------- Отрисовка ----------

function masterOption(m, checked) {
  return `
    <label class="master-option">
      <input type="radio" name="master" value="${m.id}" ${checked ? 'checked' : ''}>
      <span class="master-option__avatar" aria-hidden="true">${esc(initials(m.name))}</span>
      <span class="master-option__body">
        <span class="master-option__head"><span>${esc(m.name)}</span><span class="master-option__price">${esc(money(m.visit.priceKop))}</span></span>
        <span class="master-option__specialty">${esc([LEVELS[m.level], m.specialty].filter(Boolean).join(' · '))}</span>
        <span class="master-option__nearest" data-nearest="${m.id}"></span>
        <a class="text-link master-option__more" href="${esc(routes.masterProfile(m.id))}">Подробнее</a>
      </span>
    </label>`;
}

function unavailableOption(m, missing) {
  return `
    <div class="master-option master-option--unavailable" aria-disabled="true">
      <span class="master-option__avatar" aria-hidden="true">${esc(initials(m.name))}</span>
      <span class="master-option__body">
        <span class="master-option__head"><span>${esc(m.name)}</span></span>
        ${m.specialty ? `<span class="master-option__meta">${esc(m.specialty)}</span>` : ''}
        <span class="master-option__missing">Не выполняет: ${esc(missing.join(', '))}</span>
        <a class="text-link master-option__more" href="${esc(routes.masterProfile(m.id))}">Подробнее</a>
      </span>
    </div>`;
}

function render(fit, all, catalog) {
  suitable = new Map(fit.map((m) => [m.id, m]));
  const names = new Map(catalog.categories.flatMap((c) => c.services).map((s) => [s.id, s.name]));
  const ids = draft.items.map((i) => i.serviceId);

  // Сводка визита — от сервера: длительность одна, цена зависит от уровня мастера
  if (fit.length) {
    const prices = fit.map((m) => m.visit.priceKop);
    const min = Math.min(...prices);
    const price = min === Math.max(...prices) ? money(min) : `от ${money(min)}`;
    summary.textContent = `${countText(ids.length)} · ${duration(fit[0].visit.durationMin)} · ${price}`;
  } else {
    summary.textContent = countText(ids.length);
  }

  const value = selectionValue();
  const unfit = all.filter((m) => !suitable.has(m.id)).map((m) => ({
    m, missing: ids.filter((id) => !m.serviceIds.includes(id)).map((id) => names.get(id) ?? `услуга № ${id}`),
  }));

  list.innerHTML = `
    ${fit.length ? `
      <fieldset class="master-fieldset">
        <legend class="visually-hidden">Мастер</legend>
        <label class="master-option">
          <input type="radio" name="master" value="any" ${value === 'any' ? 'checked' : ''}>
          <span class="master-option__avatar master-option__avatar--any" aria-hidden="true">★</span>
          <span class="master-option__body">
            <span class="master-option__head"><span>Любой свободный мастер</span></span>
            <span class="master-option__meta">Покажем больше свободного времени</span>
          </span>
        </label>
        ${fit.map((m) => masterOption(m, value === String(m.id))).join('')}
      </fieldset>` : `
      <div class="warning" role="status">
        <span>Ни один мастер не выполняет все выбранные услуги. Разделите их на два визита —
          <a class="text-link" href="booking-services.html">изменить услуги</a>.</span>
      </div>`}
    ${unfit.length ? `
      <p class="master-list__subtitle">Не подходят для этого визита</p>
      ${unfit.map(({ m, missing }) => unavailableOption(m, missing)).join('')}` : ''}`;

  renderSelection();
}

// ---------- «Ближайшее: …» ----------

/** Дата студии YYYY-MM-DD через days дней от сегодня (по часовому поясу студии). */
function studioDate(timeZone, days) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function nearestText(slot, days, timeZone) {
  const day = days === 0 ? 'сегодня' : days === 1 ? 'завтра' : dateLabel(slot.startsAt, timeZone);
  return `Ближайшее: ${day}, ${timeLabel(slot.startsAt, timeZone)}`;
}

async function findNearest(masterId, studio) {
  const limit = Math.min(NEAREST_DAYS, studio.rules.bookingHorizonDays);
  for (let days = 0; days <= limit; days++) {
    const { slots } = await api.getMasterSlots(masterId, { date: studioDate(studio.timezone, days), services });
    if (slots.length) return nearestText(slots[0], days, studio.timezone);
  }
  return null;
}

function showNearest(masters, studio) {
  for (const m of masters) {
    findNearest(m.id, studio).then((text) => {
      const line = list.querySelector(`[data-nearest="${m.id}"]`);
      if (line && text) line.textContent = text;
    }).catch(() => {
      // Подсказка необязательная: не нашлось или сбой — строки просто нет (docs/ui-map.md, пункт 3)
    });
  }
}

// ---------- Загрузка ----------

async function load() {
  const skeleton = list.innerHTML;
  list.setAttribute('aria-busy', 'true');
  try {
    const [fit, all, catalog, studio] = await Promise.all([
      api.getMasters(services), api.getMasters(), api.getServices(), api.getStudio(),
    ]);
    render(fit.masters, all.masters, catalog);
    showNearest(fit.masters, studio);
  } catch (error) {
    summary.textContent = countText(draft.items.length);
    // 400 — набор услуг не собирается в визит; сервер объясняет почему
    const badSet = error instanceof api.ApiError && error.status === 400;
    list.innerHTML = `
      <div class="state-box" role="alert">
        <p class="state-box__title">${badSet ? 'Эти услуги не собрать в один визит' : 'Не удалось загрузить список мастеров'}</p>
        <p class="state-box__text">${esc(error.message)}</p>
        ${badSet
          ? '<a class="btn btn--primary btn--small" href="booking-services.html">Изменить услуги</a>'
          : '<button class="btn btn--primary btn--small" type="button" data-retry>Обновить</button>'}
      </div>`;
    list.querySelector('[data-retry]')?.addEventListener('click', () => {
      list.innerHTML = skeleton;
      load();
    });
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

if (draft.items.length && draft.lockedMasterId === null) load();
