// BOOK-04 Шаг 4. Подтверждение (docs/ui-map.md).
// При входе — удержание времени: GET /api/holds/current; если брони нет, она истекла или она на другое время —
// POST /api/holds заново. Новую бронь на каждый заход не создаем: иначе перезагрузкой страницы время можно было бы
// держать бесконечно (паспорт, риск «Захват времени бронями»). Таймер — по secondsLeft, то есть по часам сервера.
// Данные: GET /api/auth/me (имя, телефон), GET /api/studio (адрес, правило 24 часов, телефон),
// GET /api/services (названия и цены строк по уровню мастера), GET /api/masters?services=… (итог и длительность визита
// у этого мастера — считает сервер), GET /api/bookings?period=upcoming (есть ли уже запись на это время, пункт 5).
// «Подтвердить запись» → POST /api/bookings: 201 → BOOK-05; 409 SLOT_TAKEN → состояние «время заняли» с вариантами
// из ответа; 409 HOLD_EXPIRED / HOLD_NOT_FOUND → BOOK-M2; 401 → BOOK-M3; остальное — текст API на этом же экране.
import * as api from './api.js';
import { clearErrors, clearOnInput, isEmail, normalizePhone, setBusy, showAlert, showErrors, showServerError } from './form.js';
import { dateLabel, duration, escapeHtml as esc, money, phone as formatPhone, phoneHref, plural, timeLabel } from './format.js';
import { routes } from './routes.js';
import { clearDraft, getDraft, servicesParam, updateDraft } from './store.js';

const $ = (selector) => document.querySelector(selector);

const SOON_SECONDS = 60;

const draft = getDraft();
const ready = draft.items.length > 0 && draft.startsAt !== null;
if (!draft.items.length) window.location.replace(routes.booking());
else if (!draft.startsAt) window.location.replace(routes.bookingTimeStep);

// Закрепленный мастер: шага «Мастер» не было — «Изменить» мастера ведет к услугам (как на шаге «Время»)
if (draft.lockedMasterId !== null) $('[data-edit-master]').setAttribute('href', 'booking-services.html');

const views = {
  loading: /** @type {HTMLElement} */ ($('[data-loading]')),
  content: /** @type {HTMLElement} */ ($('[data-content]')),
  taken: /** @type {HTMLElement} */ ($('[data-taken]')),
  fail: /** @type {HTMLElement} */ ($('[data-fail]')),
};
const form = /** @type {HTMLFormElement} */ ($('[data-form]'));
const formAlert = /** @type {HTMLElement} */ ($('[data-alert]'));
const submitButton = /** @type {HTMLButtonElement} */ ($('[data-submit]'));
const commentInput = /** @type {HTMLTextAreaElement} */ ($('[data-comment]'));
const timer = /** @type {HTMLElement} */ ($('[data-timer]'));
const expiredDialog = /** @type {HTMLDialogElement} */ ($('[data-expired]'));
const sessionDialog = /** @type {HTMLDialogElement} */ ($('[data-session]'));

let studio = null;
let catalog = null;
let masters = [];
/** Действующая бронь: { masterId, startsAt, endsAt, secondsLeft, … } */
let hold = null;
let deadline = 0;
let tick = 0;
/** Что повторить после входа в окне «Сессия истекла» */
let afterLogin = null;

/** Кого бронировать: закрепленный или выбранный мастер; null — «Любой свободный мастер», мастера назначит сервер */
const wantedMaster = () => (draft.anyMaster && draft.lockedMasterId === null ? null : draft.lockedMasterId ?? draft.masterId);

// ---------- Состояния экрана ----------

/** Одно состояние за раз: загрузка, подтверждение, «время заняли», «не удалось». Таймер — только при брони. */
function show(name) {
  views.loading.hidden = name !== 'loading';
  views.content.hidden = name !== 'content';
  views.taken.hidden = name !== 'taken';
  views.fail.hidden = name !== 'fail';
  if (name !== 'content') stopTimer();
}

function showFail(error, retry) {
  $('[data-fail-text]').textContent = error.message;
  const retryButton = /** @type {HTMLButtonElement} */ ($('[data-fail-retry]'));
  retryButton.onclick = retry;
  show('fail');
}

// ---------- Таймер брони ----------

function stopTimer() {
  clearInterval(tick);
  timer.hidden = true;
}

function startTimer(secondsLeft) {
  clearInterval(tick);
  deadline = Date.now() + secondsLeft * 1000;
  timer.hidden = false;
  const update = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    $('[data-timer-value]').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    const soon = left <= SOON_SECONDS;
    timer.classList.toggle('is-soon', soon);
    $('[data-timer-soon]').hidden = !soon || left === 0;
    if (left === 0) {
      clearInterval(tick);
      openExpired();
    }
  };
  update();
  tick = setInterval(update, 1000);
}

// ---------- Бронь ----------

const sameAsDraft = (h) => h && h.bookingId === null && h.startsAt === draft.startsAt
  && (wantedMaster() === null || h.masterId === wantedMaster());

/**
 * Удержать время: взять действующую бронь, если она на это время, иначе создать новую.
 * @param {{ fresh?: boolean, startsAt?: string, masterId?: number | null }} [options] fresh — не смотреть текущую (после истечения)
 */
async function requestHold(options = {}) {
  const startsAt = options.startsAt ?? draft.startsAt;
  if (!options.fresh && !options.startsAt) {
    const current = await api.getCurrentHold();
    if (sameAsDraft(current)) return current;
  }
  const created = await api.createHold({
    masterId: options.masterId !== undefined ? options.masterId : wantedMaster(),
    startsAt,
    services: draft.items,
  });
  return { ...created, masterId: created.master.id };
}

/** Бронь получена: запоминаем время и мастера (для «Любого» его назначил сервер) и показываем подтверждение. */
async function applyHold(newHold) {
  hold = newHold;
  updateDraft({ startsAt: hold.startsAt, masterId: draft.lockedMasterId ?? hold.masterId });
  Object.assign(draft, getDraft());
  await renderSummary();
  show('content');
  startTimer(hold.secondsLeft);
}

/** Ошибки брони и записи, общие для входа на экран, «Проверить снова» и вариантов «время заняли». */
function handleHoldError(error, retry) {
  if (error instanceof api.ApiError && error.status === 401) {
    if (error.code === 'SESSION_EXPIRED') return openSession(retry);
    // Не вошел совсем — на вход; после входа шаг «Время» вернет сюда, выбор в черновике
    window.location.assign(`${routes.login}?next=${encodeURIComponent(routes.bookingTimeStep)}`);
    return;
  }
  if (error instanceof api.ApiError && error.code === 'SLOT_TAKEN') return showTaken(error);
  showFail(error, retry);
}

async function enter() {
  show('loading');
  try {
    await applyHold(await requestHold());
  } catch (error) {
    handleHoldError(error, enter);
  }
}

// ---------- Сводка и данные клиента ----------

async function loadStatic() {
  const [me, s, c, m] = await Promise.all([api.getMe(), api.getStudio(), api.getServices(), api.getMasters()]);
  if (!me) {
    window.location.assign(`${routes.login}?next=${encodeURIComponent(routes.bookingTimeStep)}`);
    return false;
  }
  studio = s;
  catalog = c;
  masters = m.masters;

  $('[data-client-name]').textContent = me.name;
  $('[data-client-phone]').textContent = me.phone ? formatPhone(me.phone) : 'не указан';
  $('[data-client-email]').textContent = me.email ?? 'не указан';
  $('[data-address]').textContent = studio.address;
  const hours = studio.rules.clientChangeDeadlineHours;
  $('[data-rule]').textContent = `Бесплатная отмена или перенос — не позднее чем за ${hours === 24 ? '24 часа' : `${hours} ${plural(hours, 'час', 'часа', 'часов')}`} до визита. Оплата в студии.`;
  const phoneLink = /** @type {HTMLAnchorElement} */ ($('[data-studio-phone]'));
  phoneLink.href = phoneHref(studio.phone);
  phoneLink.textContent = `Позвонить: ${formatPhone(studio.phone)}`;
  phoneLink.hidden = false;
  return true;
}

async function renderSummary() {
  const tz = studio.timezone;
  const master = masters.find((m) => m.id === hold.masterId);
  $('[data-master]').textContent = master
    ? `${master.name}${draft.anyMaster && draft.lockedMasterId === null ? ' (назначен сервисом)' : ''}`
    : 'Мастер будет назначен';
  $('[data-when]').textContent = `${dateLabel(hold.startsAt, tz)}, ${timeLabel(hold.startsAt, tz)}–${timeLabel(hold.endsAt, tz)}`;

  // Строки: название и цена единицы по уровню мастера из каталога; количество — множителем
  const services = new Map(catalog.categories.flatMap((c) => c.services).map((s) => [s.id, s]));
  const top = master?.level === 'top_master';
  $('[data-lines]').innerHTML = draft.items.map((item) => {
    const s = services.get(item.serviceId);
    if (!s) return `<li class="summary-line"><span>Услуга № ${item.serviceId}</span></li>`;
    const unit = money(top ? s.priceTopKop : s.priceMasterKop) + (s.priceUnit ? ` ${s.priceUnit}` : '');
    return `
      <li class="summary-line">
        <span>${esc(s.name)}</span>
        <span class="summary-line__price">${esc(unit)}${item.quantity > 1 ? ` × ${item.quantity}` : ''}</span>
      </li>`;
  }).join('');

  // Итог и длительность — от сервера: визит у этого мастера
  try {
    const { masters: fit } = await api.getMasters(servicesParam(draft.items));
    const visit = fit.find((m) => m.id === hold.masterId)?.visit;
    $('[data-total]').textContent = visit ? money(visit.priceKop) : '—';
    $('[data-duration]').textContent = visit ? duration(visit.durationMin) : '';
  } catch (error) {
    $('[data-total]').textContent = '—';
    $('[data-duration]').textContent = `Не удалось получить итог: ${error.message}`;
  }

  // Уже есть запись на это время — предупреждаем, запретить вторую запись может только сервер
  try {
    const mine = (await api.getBookings({ period: 'upcoming' })).filter((b) => b.status === 'active'
      && Date.parse(b.startsAt) < Date.parse(hold.endsAt) && Date.parse(b.endsAt) > Date.parse(hold.startsAt));
    const box = /** @type {HTMLElement} */ ($('[data-overlap]'));
    box.hidden = !mine.length;
    if (mine.length) {
      box.innerHTML = `У вас уже есть запись на это время: <a class="text-link" href="${esc(routes.bookingCard(mine[0].id))}">${esc(dateLabel(mine[0].startsAt, tz))}, ${esc(timeLabel(mine[0].startsAt, tz))}</a>. Проверьте, что вторая запись не по ошибке.`;
    }
  } catch {
    // Подсказка необязательная — без нее запись все равно возможна
  }
}

// ---------- «Время уже заняли» ----------

function showTaken(error) {
  const tz = studio?.timezone ?? 'Europe/Moscow';
  const alternatives = /** @type {any} */ (error.details)?.alternatives ?? [];
  $('[data-taken-text]').textContent = error.message; // текст — из ответа API
  $('[data-taken-options]').innerHTML = alternatives.slice(0, 8).map((a) => {
    const name = masters.find((m) => m.id === a.masterId)?.name;
    return `
      <button class="btn btn--outline btn--small" type="button" data-alt-start="${esc(a.startsAt)}" data-alt-master="${a.masterId}">
        ${esc(dateLabel(a.startsAt, tz))}, ${esc(timeLabel(a.startsAt, tz))}–${esc(timeLabel(a.endsAt, tz))}${name ? ` · ${esc(name)}` : ''}
      </button>`;
  }).join('');
  hold = null;
  show('taken');
  $('[data-taken-text]').focus();
}

$('[data-taken-options]').addEventListener('click', async (event) => {
  const button = /** @type {HTMLButtonElement} */ (/** @type {HTMLElement} */ (event.target).closest('[data-alt-start]'));
  if (!button) return;
  const startsAt = button.getAttribute('data-alt-start');
  const masterId = Number(button.getAttribute('data-alt-master'));
  const retry = () => button.click();
  const done = setBusy(button, 'Закрепляем…');
  try {
    await applyHold(await requestHold({ startsAt, masterId }));
  } catch (error) {
    done();
    handleHoldError(error, retry);
  }
});

// ---------- BOOK-M2 Время брони истекло ----------

function openExpired(message = null) {
  $('[data-expired-text]').textContent = message ?? 'Проверим, свободно ли еще выбранное время.';
  if (!expiredDialog.open) expiredDialog.showModal();
}

// Окно не закрывается без решения: без брони записаться нельзя
expiredDialog.addEventListener('cancel', (event) => event.preventDefault());

$('[data-recheck]').addEventListener('click', async () => {
  const button = /** @type {HTMLButtonElement} */ ($('[data-recheck]'));
  const done = setBusy(button, 'Проверяем…');
  try {
    const fresh = await requestHold({ fresh: true });
    expiredDialog.close();
    done();
    await applyHold(fresh);
  } catch (error) {
    expiredDialog.close();
    done();
    handleHoldError(error, () => openExpired());
  }
});

// ---------- BOOK-M3 Сессия истекла ----------

const sessionForm = /** @type {HTMLFormElement} */ ($('[data-session-form]'));
const sessionAlert = /** @type {HTMLElement} */ ($('[data-session-alert]'));
clearOnInput(sessionForm);

function openSession(retry) {
  afterLogin = retry;
  clearErrors(sessionForm, sessionAlert);
  if (!sessionDialog.open) sessionDialog.showModal();
}

sessionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(sessionForm, sessionAlert);
  const login = /** @type {HTMLInputElement} */ (sessionForm.elements.namedItem('login')).value.trim();
  const password = /** @type {HTMLInputElement} */ (sessionForm.elements.namedItem('password')).value;
  const loginOk = login && (login.includes('@') ? isEmail(login) : normalizePhone(login));
  if (!showErrors(sessionForm, { login: loginOk ? null : 'Введите телефон или e-mail', password: password ? null : 'Введите пароль' })) return;
  const done = setBusy(/** @type {HTMLButtonElement} */ (sessionForm.querySelector('[type=submit]')), 'Входим…');
  try {
    await api.login({ login: login.includes('@') ? login : normalizePhone(login), password });
    sessionDialog.close();
    // Бронь принадлежит пользователю и переживает истечение сессии, пока не истек ее срок
    afterLogin?.();
  } catch (error) {
    showServerError(sessionForm, sessionAlert, error);
  } finally {
    done();
  }
});

// ---------- «Подтвердить запись» ----------

commentInput.value = draft.comment;
$('[data-comment-count]').textContent = String(commentInput.value.length);
commentInput.addEventListener('input', () => {
  $('[data-comment-count]').textContent = String(commentInput.value.length);
  updateDraft({ comment: commentInput.value });
});
clearOnInput(form);

async function submit() {
  clearErrors(form, formAlert);
  const done = setBusy(submitButton, 'Записываем…');
  try {
    const booking = await api.createBooking({
      masterId: hold.masterId,
      startsAt: hold.startsAt,
      services: draft.items,
      comment: commentInput.value.trim() || null,
      isAnyMaster: draft.anyMaster && draft.lockedMasterId === null,
    });
    stopTimer();
    clearDraft();
    window.location.assign(routes.bookingSuccess(booking.id));
  } catch (error) {
    done();
    if (!(error instanceof api.ApiError)) return showFail(error, submit);
    if (error.code === 'HOLD_EXPIRED' || error.code === 'HOLD_NOT_FOUND') return openExpired(error.message);
    if (error.code === 'SLOT_TAKEN') return showTaken(error);
    if (error.status === 401) return openSession(submit);
    if (error.status === 400) return showServerError(form, formAlert, error);
    if (error.code === 'HOLD_MISMATCH') {
      showAlert(formAlert, 'error', `${error.message}.`);
      formAlert.insertAdjacentHTML('beforeend', ` <a class="text-link" href="${routes.bookingTimeStep}">Выбрать время</a>`);
      return;
    }
    showFail(error, submit);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (hold) submit();
});

// ---------- Старт ----------

async function start() {
  show('loading');
  try {
    if (!(await loadStatic())) return;
  } catch (error) {
    return showFail(error, start);
  }
  await enter();
}

if (ready) start();
