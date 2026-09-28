// CAB-03 Карточка записи и CAB-05 Отмена записи (docs/ui-map.md).
// Данные: GET /api/bookings/:id (404 — не найдена, 403 — чужая; canChange и changeDeadline по правилу 24 часов,
// cancellation.reason, studioChange, version), GET /api/studio (адрес, карта, телефон, срок правила).
// «Отменить» → окно CAB-05 → POST /api/bookings/:id/cancel { reason, version }: 200 — «Запись отменена»;
// 403 CHANGE_DEADLINE_PASSED — «Онлайн-отмена недоступна» с текстом сервера; 409 — текст сервера и «Обновить».
// «Перенести» → экран выбора времени в режиме переноса. ?cancel=1 — сразу открыть окно отмены («Отменить» в CAB-01).
import * as api from './api.js';
import { bookingServices, downloadIcs } from './calendar.js';
import { setBusy, showAlert } from './form.js';
import { dateLabel, escapeHtml as esc, money, phone as formatPhone, phoneHref, plural, timeLabel } from './format.js';
import { routes } from './routes.js';

const $ = (selector) => document.querySelector(selector);

const params = new URLSearchParams(window.location.search);
const id = Number(params.get('id'));
let openCancelOnLoad = params.get('cancel') === '1';

/** Предупреждать «осталось мало времени», если до срока онлайн-изменения меньше суток */
const SOON_MS = 24 * 3600_000;

let booking = null;
let studio = null;

const STATUS = {
  active: { label: 'Предстоит', cls: 'badge--active' },
  soon: { label: 'Скоро', cls: 'badge--soon' },
  completed: { label: 'Завершена', cls: 'badge--completed' },
  cancelled_by_client: { label: 'Отменена вами', cls: 'badge--cancelled' },
  cancelled_by_studio: { label: 'Отменена студией', cls: 'badge--cancelled' },
  no_show: { label: 'Неявка', cls: 'badge--no-show' },
};

function show(view) {
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.getAttribute('data-view') !== view;
}

const when = (b) => `${dateLabel(b.startsAt, studio.timezone)}, ${timeLabel(b.startsAt, studio.timezone)}–${timeLabel(b.endsAt, studio.timezone)}`;
const deadlineText = (b) => `${dateLabel(b.changeDeadline, studio.timezone)}, ${timeLabel(b.changeDeadline, studio.timezone)}`;
const repeatHref = (b) => routes.bookingTime({
  services: b.items.map((i) => (i.quantity > 1 ? `${i.serviceId}:${i.quantity}` : String(i.serviceId))).join(','),
  master: b.master.id,
});

/** «5 ч 20 мин» до момента */
function leftText(iso) {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} ${plural(h, 'час', 'часа', 'часов')}${m ? ` ${m} мин` : ''}` : `${m} мин`;
}

const ruleHours = () => {
  const h = studio.rules.clientChangeDeadlineHours;
  return h === 24 ? '24 часа' : `${h} ${plural(h, 'час', 'часа', 'часов')}`;
};

// ---------- Карточка ----------

function render() {
  const b = booking;
  const status = b.status === 'active' && !b.canChange ? STATUS.soon : STATUS[b.status] ?? { label: b.status, cls: '' };
  document.title = `${bookingServices(b)} — Ноготочки`;
  $('[data-services]').textContent = bookingServices(b);
  $('[data-badge]').innerHTML = `<span class="badge ${status.cls}">${esc(status.label)}</span>`;
  $('[data-when]').textContent = when(b);
  const master = /** @type {HTMLAnchorElement} */ ($('[data-master]'));
  master.textContent = b.master.name;
  master.href = routes.master(b.master.id);
  $('[data-lines]').innerHTML = b.items.map((i) => `
    <li><span>${esc(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ''}</span><span>${esc(money(i.priceKop))}</span></li>`).join('');
  $('[data-price]').textContent = `${money(b.totalPriceKop)}, оплата в студии`;

  const comment = /** @type {HTMLElement} */ ($('[data-comment]'));
  comment.hidden = !b.comment;
  comment.textContent = b.comment ? `Комментарий мастеру: ${b.comment}` : '';

  const reason = /** @type {HTMLElement} */ ($('[data-cancel-reason]'));
  reason.hidden = !b.cancellation;
  if (b.cancellation) {
    reason.textContent = b.cancellation.by === 'studio'
      ? `Студия отменила запись. Причина: ${b.cancellation.reason ?? 'не указана'}`
      : `Вы отменили запись${b.cancellation.reason ? `. Причина: ${b.cancellation.reason}` : ''}`;
  }

  renderStudioChange();

  $('[data-address]').textContent = studio.address;
  const map = /** @type {HTMLAnchorElement} */ ($('[data-map]'));
  map.hidden = !studio.mapUrl;
  if (studio.mapUrl) map.href = studio.mapUrl;
  /** @type {HTMLElement} */ ($('[data-calendar]')).hidden = b.status !== 'active';

  // Мало времени до срока онлайн-изменения — предупреждаем заранее
  const warning = /** @type {HTMLElement} */ ($('[data-deadline-warning]'));
  const soon = b.status === 'active' && b.canChange && Date.parse(b.changeDeadline) - Date.now() < SOON_MS;
  warning.hidden = !soon;
  if (soon) warning.textContent = `Перенести или отменить запись онлайн можно до ${deadlineText(b)} — осталось ${leftText(b.changeDeadline)}. Позже — только через студию.`;

  const actions = /** @type {HTMLElement} */ ($('[data-detail-actions]'));
  if (b.status === 'active' && b.canChange) {
    actions.innerHTML = `
      <a class="btn btn--neutral" href="${esc(routes.reschedule(b.id))}">Перенести</a>
      <button class="btn btn--danger" type="button" data-open-cancel>Отменить</button>`;
  } else if (b.status === 'active') {
    actions.innerHTML = `
      <p class="detail-actions__note">Изменить запись можно только через студию: онлайн-отмена и перенос доступны не позднее чем за ${esc(ruleHours())} до визита.</p>
      <a class="btn btn--primary" href="${esc(phoneHref(studio.phone))}">Позвонить в салон: ${esc(formatPhone(studio.phone))}</a>`;
  } else if (b.status === 'completed') {
    actions.innerHTML = `<a class="btn btn--outline" href="${esc(repeatHref(b))}">Повторить запись</a>`;
  } else if (b.status === 'cancelled_by_studio') {
    actions.innerHTML = `<a class="btn btn--primary" href="${esc(repeatHref(b))}">Выбрать новое время</a>`;
  } else {
    actions.innerHTML = `<a class="btn btn--outline" href="${esc(repeatHref(b))}">Записаться снова</a>`;
  }
  actions.querySelector('[data-open-cancel]')?.addEventListener('click', openCancel);
}

/** «Студия отменила / перенесла запись» — пока клиент не закроет (то же сообщение, что в «Моих записях») */
function renderStudioChange() {
  const box = /** @type {HTMLElement} */ ($('[data-studio-change]'));
  box.hidden = !booking.studioChange;
  if (!booking.studioChange) return;
  $('[data-studio-change-text]').textContent = booking.studioChange.type === 'cancelled'
    ? 'Студия отменила эту запись.'
    : `Студия перенесла эту запись — теперь она ${when(booking)}.`;
}

$('[data-acknowledge]').addEventListener('click', async () => {
  const button = /** @type {HTMLButtonElement} */ ($('[data-acknowledge]'));
  button.disabled = true;
  try {
    booking = { ...booking, studioChange: null, ...(await api.acknowledgeBooking(id)).booking };
    renderStudioChange();
  } catch (error) {
    $('[data-studio-change-text]').textContent += ` Не удалось закрыть сообщение: ${error.message}`;
    button.disabled = false;
  }
});

$('[data-calendar]').addEventListener('click', () => downloadIcs(booking, studio));

// ---------- CAB-05 Отмена ----------

const dialog = /** @type {HTMLDialogElement} */ ($('[data-cancel]'));
const form = /** @type {HTMLFormElement} */ ($('[data-cancel-form]'));
const alert = /** @type {HTMLElement} */ ($('[data-cancel-alert]'));
let cancelled = false;

function cancelView(view, text = null) {
  form.hidden = view !== 'pick';
  $('[data-cancel-restricted]').hidden = view !== 'restricted';
  $('[data-cancel-done]').hidden = view !== 'done';
  if (view === 'restricted') {
    // Текст сервера (403 CHANGE_DEADLINE_PASSED) или правило из настроек студии, если окно открыли после срока
    $('[data-restricted-text]').textContent = text
      ?? `Отменить запись можно не позднее чем за ${ruleHours()} до визита. Позвоните в салон, чтобы отменить эту запись.`;
    const phone = /** @type {HTMLAnchorElement} */ ($('[data-restricted-phone]'));
    phone.href = phoneHref(studio.phone);
    phone.textContent = `Позвонить: ${formatPhone(studio.phone)}`;
  }
}

function openCancel() {
  alert.hidden = true;
  form.reset();
  $('[data-other-field]').hidden = true;
  $('[data-cancel-summary]').textContent = `${bookingServices(booking)} · ${when(booking)} · ${booking.master.name}`;
  $('[data-cancel-rules]').textContent = `Отменить запись онлайн можно не позднее чем за ${ruleHours()} до визита. После отмены время освободится для других клиентов, запись останется в истории.`;
  /** @type {HTMLAnchorElement} */ ($('[data-reschedule-instead]')).href = routes.reschedule(booking.id);

  const soon = /** @type {HTMLElement} */ ($('[data-cancel-soon]'));
  const deadlineSoon = booking.canChange && Date.parse(booking.changeDeadline) - Date.now() < SOON_MS;
  soon.hidden = !deadlineSoon;
  if (deadlineSoon) soon.textContent = `До визита осталось мало времени: отменить онлайн можно еще ${leftText(booking.changeDeadline)}, до ${deadlineText(booking)}. Позже — только через студию.`;

  cancelView(booking.status === 'active' && booking.canChange ? 'pick' : 'restricted');
  if (booking.status !== 'active') $('[data-restricted-text]').textContent = 'Эта запись уже не действует — отменять нечего.';
  dialog.showModal();
}

form.addEventListener('change', (event) => {
  if (/** @type {HTMLInputElement} */ (event.target).name === 'reason') {
    const other = /** @type {HTMLInputElement} */ (form.elements.namedItem('reason')).value === 'other';
    $('[data-other-field]').hidden = !other;
    if (other) /** @type {HTMLInputElement} */ ($('[data-other]')).focus();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  alert.hidden = true;
  const picked = /** @type {HTMLInputElement} */ (form.elements.namedItem('reason')).value;
  const reason = picked === 'other' ? /** @type {HTMLInputElement} */ ($('[data-other]')).value.trim() || 'Другое' : picked || null;
  const done = setBusy(/** @type {HTMLButtonElement} */ ($('[data-cancel-submit]')), 'Отменяем…');
  try {
    booking = await api.cancelBooking(id, { reason, version: booking.version });
    cancelled = true;
    $('[data-done-text]').textContent = `${bookingServices(booking)} · ${booking.master.name} — запись перенесена в историю. Время освободилось для других клиентов.`;
    /** @type {HTMLAnchorElement} */ ($('[data-rebook]')).href = repeatHref(booking);
    cancelView('done');
  } catch (error) {
    done();
    if (error instanceof api.ApiError && error.status === 401) {
      window.location.assign(`${routes.login}?next=${encodeURIComponent(routes.bookingCard(id))}`);
      return;
    }
    if (error instanceof api.ApiError && error.code === 'CHANGE_DEADLINE_PASSED') return cancelView('restricted', error.message);
    // Отказ сервера — его текстом. Запись изменили или уже отменили — предлагаем обновить карточку
    showAlert(alert, 'error', `Не удалось отменить запись. ${error.message}`);
    if (error instanceof api.ApiError && (error.code === 'VERSION_CONFLICT' || error.code === 'BOOKING_NOT_ACTIVE')) {
      alert.insertAdjacentHTML('beforeend', '<button class="btn btn--small btn--neutral" type="button" data-refresh>Обновить</button>');
      alert.querySelector('[data-refresh]').addEventListener('click', () => {
        dialog.close();
        load();
      });
    }
  }
});

dialog.addEventListener('close', () => {
  if (cancelled) {
    cancelled = false;
    render();
  }
});
document.querySelectorAll('[data-cancel-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

// ---------- Загрузка ----------

async function load() {
  show('loading');
  if (!Number.isInteger(id) || id < 1) {
    $('[data-error-text]').textContent = 'В адресе нет номера записи.';
    show('error');
    return;
  }
  try {
    [booking, studio] = await Promise.all([api.getBooking(id), api.getStudio()]);
    render();
    show('content');
    if (openCancelOnLoad) {
      openCancelOnLoad = false;
      history.replaceState(null, '', routes.bookingCard(id));
      openCancel();
    }
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 401) {
      window.location.replace(`${routes.login}?next=${encodeURIComponent(routes.bookingCard(id))}`);
      return;
    }
    const notFound = error instanceof api.ApiError && (error.status === 404 || error.status === 403);
    $('[data-error-title]').textContent = notFound ? 'Запись не найдена' : 'Не удалось загрузить запись';
    $('[data-error-text]').textContent = error.message;
    show('error');
  }
}

load();
