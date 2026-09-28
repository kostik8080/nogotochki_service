// BOOK-01 Шаг 1. Услуги (docs/ui-map.md). Данные: GET /api/services (каталог, правила опции, несовместимые пары),
// GET /api/masters (все активные мастера: кто что выполняет — для подсветки проблемной услуги и закрепленного
// мастера), после каждого изменения корзины — GET /api/masters?services=…: сумма и длительность визита
// приходят от сервера (visit у каждого подходящего мастера), 400 — объяснение, чего не хватает.
// Выбор — в черновике записи (js/store.js). Переходы: «Далее» → BOOK-02, при закрепленном мастере → BOOK-03.
import * as api from './api.js';
import { duration, escapeHtml as esc, money, plural } from './format.js';
import { routes } from './routes.js';
import { clearDraft, getDraft, servicesParam, startDraft, updateDraft } from './store.js';

const $ = (selector) => document.querySelector(selector);

const grid = /** @type {HTMLElement} */ ($('[data-services]'));
const chipsBox = /** @type {HTMLElement} */ ($('[data-chips]'));
const searchInput = /** @type {HTMLInputElement} */ ($('[data-search]'));
const totalText = /** @type {HTMLElement} */ ($('[data-total]'));
const hintText = /** @type {HTMLElement} */ ($('[data-hint]'));
const nextButton = /** @type {HTMLButtonElement} */ ($('[data-next]'));
const cartToggle = /** @type {HTMLButtonElement} */ ($('[data-cart-toggle]'));
const cartLines = /** @type {HTMLElement} */ ($('[data-cart-lines]'));
const coverageWarning = /** @type {HTMLElement} */ ($('[data-coverage]'));

const skeleton = grid.innerHTML;

/** @type {{ categories: any[], addonRules: any[], incompatibilities: any[] } | null} */
let catalog = null;
/** Все активные мастера: имя и serviceIds */
let allMasters = [];
/** @type {Map<number, any>} */
let servicesById = new Map();
let lockedMaster = null;
let filter = { search: '', category: 'all' };
/** Услуга, из-за которой ни один мастер не подходит, — подсветка, как в прототипе */
let problemServiceId = null;
/** Сообщение, почему услугу не добавили (несовместимость) — до следующего изменения корзины */
let flash = null;
/** Можно ли идти дальше: сервер посчитал визит и есть подходящий мастер */
let canProceed = false;
let totalsRequest = 0;

// ---------- Вход в шаг: ссылки с лендинга и из кабинета ----------

// ?service=ID — услуга сразу в корзине, ?master=ID — мастер закреплен («Записаться к мастеру»).
// Такая ссылка начинает запись заново; без параметров шаг продолжает начатый черновик.
{
  const params = new URLSearchParams(window.location.search);
  const service = Number(params.get('service'));
  const master = Number(params.get('master'));
  if (params.has('service') || params.has('master')) {
    startDraft({
      items: Number.isInteger(service) && service > 0 ? [{ serviceId: service, quantity: 1 }] : [],
      lockedMasterId: Number.isInteger(master) && master > 0 ? master : null,
    });
    // Дальше источник правды — черновик: после перезагрузки ссылка не начнет запись снова
    history.replaceState(null, '', window.location.pathname);
  }
}

const items = () => getDraft().items;
const inCart = (id) => items().some((i) => i.serviceId === id);

// ---------- Тексты ----------

function priceText(s) {
  const price = money(s.priceMasterKop);
  if (s.priceUnit) return `${price} ${s.priceUnit}`;
  return s.priceTopKop > s.priceMasterKop ? `от ${price}` : price;
}

const durationText = (s) => (s.kind === 'addon' ? '+' : '') + duration(s.durationMin);
const countText = (n) => `${n} ${plural(n, 'услуга', 'услуги', 'услуг')}`;

// ---------- Каталог ----------

function visibleServices() {
  const search = filter.search.trim().toLowerCase();
  return catalog.categories
    .filter((c) => filter.category === 'all' || String(c.id) === filter.category)
    .flatMap((c) => c.services)
    .filter((s) => !search || s.name.toLowerCase().includes(search) || (s.description ?? '').toLowerCase().includes(search));
}

function renderChips() {
  const chips = [{ id: 'all', name: 'Все' }, ...catalog.categories.map((c) => ({ id: String(c.id), name: c.name }))];
  chipsBox.innerHTML = chips.map((c) =>
    `<button class="chip" type="button" aria-pressed="${c.id === filter.category}" data-category="${esc(c.id)}">${esc(c.name)}</button>`,
  ).join('');
}

function renderServices() {
  const list = visibleServices();
  if (!list.length) {
    grid.innerHTML = `
      <div class="state-box">
        <p class="state-box__title">Ничего не нашли</p>
        <button class="btn btn--outline btn--small" type="button" data-reset-search>Сбросить поиск</button>
      </div>`;
    return;
  }
  grid.innerHTML = list.map((s) => {
    const selected = inCart(s.id);
    const classes = ['service-card', selected && 'is-selected', s.id === problemServiceId && 'is-problem'].filter(Boolean).join(' ');
    return `
      <article class="${classes}">
        <button class="service-card__open" type="button" data-open="${s.id}">${esc(s.name)}</button>
        ${s.description ? `<p class="service-card__desc">${esc(s.description)}</p>` : ''}
        <div class="service-card__foot">
          <div>
            <p class="service-card__duration">${esc(durationText(s))}</p>
            <p class="service-card__price">${esc(priceText(s))}</p>
          </div>
          <button class="add-button" type="button" aria-pressed="${selected}" data-toggle="${s.id}"
                  aria-label="${selected ? 'Убрать из визита' : 'Добавить в визит'}: ${esc(s.name)}">${selected ? 'Добавлено ✓' : '+'}</button>
        </div>
      </article>`;
  }).join('');
}

// ---------- Корзина визита ----------

function renderCartLines() {
  cartLines.innerHTML = items().map((item) => {
    const s = servicesById.get(item.serviceId);
    const qty = s.maxQuantity > 1 ? `
      <span class="qty" role="group" aria-label="Количество: ${esc(s.name)}">
        <button class="qty__button" type="button" data-qty="${s.id}" data-delta="-1" aria-label="Меньше" ${item.quantity <= 1 ? 'disabled' : ''}>−</button>
        <span>${item.quantity}</span>
        <button class="qty__button" type="button" data-qty="${s.id}" data-delta="1" aria-label="Больше" ${item.quantity >= s.maxQuantity ? 'disabled' : ''}>+</button>
      </span>` : '';
    return `
      <div class="cart__line${s.id === problemServiceId ? ' is-problem' : ''}">
        <span class="cart__line-name">${esc(s.name)}</span>
        <span class="cart__line-side">
          ${qty}
          <span>${esc(priceText(s))}</span>
          <button class="cart__remove" type="button" data-remove="${s.id}" aria-label="Убрать: ${esc(s.name)}">✕</button>
        </span>
      </div>`;
  }).join('');
}

function setHint(text, warning = false) {
  hintText.textContent = text;
  hintText.classList.toggle('cart__hint--warning', warning);
}

function setNext(enabled) {
  canProceed = enabled;
  nextButton.disabled = !enabled;
}

/** Услуга, которую выполняет меньше всего мастеров, — из-за нее и не находится мастер на весь визит. */
function findProblemService() {
  let worst = null;
  let min = Infinity;
  for (const { serviceId } of items()) {
    const count = allMasters.filter((m) => m.serviceIds.includes(serviceId)).length;
    if (count < min) [min, worst] = [count, serviceId];
  }
  return worst;
}

/** Сумма и длительность — из ответа сервера: у каждого подходящего мастера своя цена визита. */
async function refreshTotals() {
  const current = items();
  const request = ++totalsRequest;
  problemServiceId = null;
  coverageWarning.hidden = true;
  cartToggle.disabled = current.length === 0;
  if (!current.length) {
    cartLines.hidden = true;
    cartToggle.setAttribute('aria-expanded', 'false');
  }
  renderCartLines();

  if (!current.length) {
    totalText.textContent = 'Услуги не выбраны';
    setHint(flash ?? 'Выберите хотя бы одну услугу', Boolean(flash));
    setNext(false);
    return;
  }

  totalText.textContent = `${countText(current.length)} · считаем стоимость…`;
  setHint(flash ?? '', Boolean(flash));
  setNext(false);

  try {
    const { masters } = await api.getMasters(servicesParam(current));
    if (request !== totalsRequest) return; // корзина уже изменилась — ответ устарел
    const suitable = lockedMaster ? masters.filter((m) => m.id === lockedMaster.id) : masters;

    if (!suitable.length) {
      totalText.textContent = countText(current.length);
      problemServiceId = findProblemService();
      coverageWarning.hidden = lockedMaster !== null;
      setHint(lockedMaster
        ? `Мастер ${lockedMaster.name} не выполняет весь набор. Уберите лишнюю услугу.`
        : 'Ни один мастер не выполняет все выбранные услуги. Разделите их на два визита.', true);
      renderServices();
      renderCartLines();
      return;
    }

    const minutes = suitable[0].visit.durationMin;
    const prices = suitable.map((m) => m.visit.priceKop);
    const min = Math.min(...prices);
    const samePrice = min === Math.max(...prices);
    totalText.textContent = `${countText(current.length)} · ${duration(minutes)} · ${samePrice ? money(min) : `от ${money(min)}`}`;
    const note = lockedMaster ? `У мастера ${lockedMaster.name}` : samePrice ? '' : 'Цена зависит от уровня мастера';
    setHint(flash ?? note, Boolean(flash));
    setNext(true);
  } catch (error) {
    if (request !== totalsRequest) return;
    totalText.textContent = countText(current.length);
    // 400 — сервер объясняет, чего не хватает: «Опцию можно добавить только к основной услуге…»
    setHint(error instanceof api.ApiError && error.status === 400
      ? error.message
      : `Не удалось посчитать стоимость. ${error.message}`, true);
  }
}

function changeItems(next) {
  updateDraft({ items: next });
  renderServices();
  refreshTotals();
}

// ---------- Добавить и убрать ----------

/** Причина, по которой услугу нельзя добавить к уже выбранным, — из каталога сервера. */
function incompatibility(id) {
  const ids = items().map((i) => i.serviceId);
  return catalog.incompatibilities.find((p) => p.serviceIds.includes(id) && p.serviceIds.some((x) => x !== id && ids.includes(x)));
}

function toggleService(id) {
  flash = null;
  if (inCart(id)) {
    changeItems(items().filter((i) => i.serviceId !== id));
    return;
  }
  const pair = incompatibility(id);
  if (pair) {
    flash = `Эти услуги нельзя совместить в одном визите: ${pair.reason}`;
    refreshTotals();
    return;
  }
  if (lockedMaster && !lockedMaster.serviceIds.includes(id)) {
    openConflict(id);
    return;
  }
  changeItems([...items(), { serviceId: id, quantity: 1 }]);
}

// ---------- BOOK-M4 Детали услуги ----------

const detail = /** @type {HTMLDialogElement} */ ($('[data-detail]'));
let detailId = null;

function openDetail(id) {
  const s = servicesById.get(id);
  detailId = id;
  $('[data-detail-name]').textContent = s.name;
  $('[data-detail-desc]').textContent = s.description ?? '';
  $('[data-detail-duration]').textContent = durationText(s);
  $('[data-detail-price]').textContent = priceText(s);
  $('[data-detail-toggle]').textContent = inCart(id) ? 'Убрать из визита' : 'Добавить в визит';
  detail.showModal();
}

$('[data-detail-toggle]').addEventListener('click', () => {
  detail.close();
  toggleService(detailId);
});
$('[data-detail-close]').addEventListener('click', () => detail.close());

// ---------- BOOK-M5 Мастер не выполняет услугу ----------

const conflict = /** @type {HTMLDialogElement} */ ($('[data-conflict]'));
let conflictId = null;

function openConflict(id) {
  conflictId = id;
  $('[data-conflict-text]').textContent = `Мастер ${lockedMaster.name} не выполняет «${servicesById.get(id).name}».`;
  conflict.showModal();
}

// «Убрать услугу» — услуга не добавляется, мастер остается
$('[data-conflict-remove]').addEventListener('click', () => conflict.close());

// «Выбрать другого мастера» — мастер больше не закреплен, услуга добавляется, дальше — шаг «Мастер»
$('[data-conflict-switch]').addEventListener('click', () => {
  updateDraft({ lockedMasterId: null, masterId: null, items: [...items(), { serviceId: conflictId, quantity: 1 }] });
  window.location.assign('booking-master.html');
});

// ---------- BOOK-M6 Выйти из записи? ----------

const exit = /** @type {HTMLDialogElement} */ ($('[data-exit]'));

$('[data-back]').addEventListener('click', () => {
  const draft = getDraft();
  if (draft.items.length || draft.lockedMasterId !== null) exit.showModal();
  else window.location.assign(routes.home);
});
$('[data-exit-stay]').addEventListener('click', () => exit.close());
$('[data-exit-leave]').addEventListener('click', () => {
  clearDraft();
  window.location.assign(routes.home);
});

// Окна закрываются и кликом по затемнению
for (const dialog of [detail, conflict, exit]) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

// ---------- События страницы ----------

grid.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const toggle = target.closest('[data-toggle]');
  if (toggle) return toggleService(Number(toggle.getAttribute('data-toggle')));
  const open = target.closest('[data-open]');
  if (open) return openDetail(Number(open.getAttribute('data-open')));
  if (target.closest('[data-reset-search]')) {
    searchInput.value = '';
    filter = { search: '', category: 'all' };
    renderChips();
    renderServices();
  }
});

chipsBox.addEventListener('click', (event) => {
  const chip = /** @type {HTMLElement} */ (event.target).closest('[data-category]');
  if (!chip) return;
  filter.category = chip.getAttribute('data-category');
  renderChips();
  renderServices();
});

searchInput.addEventListener('input', () => {
  filter.search = searchInput.value;
  renderServices();
});

cartToggle.addEventListener('click', () => {
  const open = cartLines.hidden;
  cartLines.hidden = !open;
  cartToggle.setAttribute('aria-expanded', String(open));
});

cartLines.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  flash = null;
  const remove = target.closest('[data-remove]');
  if (remove) return changeItems(items().filter((i) => i.serviceId !== Number(remove.getAttribute('data-remove'))));
  const qty = target.closest('[data-qty]');
  if (qty) {
    const id = Number(qty.getAttribute('data-qty'));
    const delta = Number(qty.getAttribute('data-delta'));
    const max = servicesById.get(id).maxQuantity;
    changeItems(items().map((i) => (i.serviceId === id ? { ...i, quantity: Math.min(max, Math.max(1, i.quantity + delta)) } : i)));
  }
});

nextButton.addEventListener('click', () => {
  if (!canProceed) return;
  window.location.assign(lockedMaster ? routes.bookingTimeStep : 'booking-master.html');
});

// ---------- Загрузка ----------

async function load() {
  grid.innerHTML = skeleton;
  grid.setAttribute('aria-busy', 'true');
  try {
    const [services, masters] = await Promise.all([api.getServices(), api.getMasters()]);
    catalog = services;
    allMasters = masters.masters;
    servicesById = new Map(catalog.categories.flatMap((c) => c.services).map((s) => [s.id, s]));

    // Отключенная услуга или мастер из старого черновика больше не предлагаются
    const draft = getDraft();
    const known = draft.items.filter((i) => servicesById.has(i.serviceId));
    if (known.length !== draft.items.length) updateDraft({ items: known });
    lockedMaster = allMasters.find((m) => m.id === draft.lockedMasterId) ?? null;
    if (draft.lockedMasterId !== null && !lockedMaster) updateDraft({ lockedMasterId: null });

    const note = /** @type {HTMLElement} */ ($('[data-locked-note]'));
    note.hidden = !lockedMaster;
    if (lockedMaster) note.textContent = `Услуги мастера ${lockedMaster.name}`;

    renderChips();
    renderServices();
    refreshTotals();
  } catch (error) {
    grid.innerHTML = `
      <div class="state-box" role="alert">
        <p class="state-box__title">Не удалось загрузить каталог услуг</p>
        <p class="state-box__text">${esc(error instanceof api.ApiError ? error.message : 'Проверьте соединение и попробуйте снова.')}</p>
        <button class="btn btn--primary btn--small" type="button" data-retry>Обновить</button>
      </div>`;
    grid.querySelector('[data-retry]').addEventListener('click', load);
  } finally {
    grid.setAttribute('aria-busy', 'false');
  }
}

load();
