// «Заявки» в разделе администратора (/admin/requests): заявки мастеров на отпуск, отгул, больничный,
// новый график и свободные просьбы. Администратор одобряет или отклоняет с причиной.
//
// Одобрение применяет заявку сразу: отпуск, отгул и больничный становятся блокировкой времени, график —
// новым недельным графиком с даты. Перед одобрением показываются записи, которые попадут под изменение:
// база их не трогает, администратор переносит или отменяет их сам на странице «Записи».
//
// Данные: GET /api/admin/requests (список и число новых одним ответом), GET /api/admin/requests/:id/affected.
// Кнопки: «Одобрить» — POST /api/admin/requests/:id/approve, «Отклонить» — /reject с причиной.
import { adminReady, handleAccessError, setFlash } from './admin.js';
import * as api from './api.js';
import { clearErrors, clearOnInput, setBusy, showErrors, showServerError } from './form.js';
import { dateLabel, escapeHtml as esc, plural, timeLabel } from './format.js';
import { dayLabel, decisionText, periodText, photoPreview, statusBadge, TYPE_LABEL } from './requests-view.js';

const $ = (selector, root = document) => /** @type {HTMLElement} */ (root.querySelector(selector));

const list = $('[data-list]');
const pageLoading = $('[data-page-loading]');
const pageError = $('[data-page-error]');
const summary = $('[data-summary]');
const statusFilter = /** @type {HTMLSelectElement} */ ($('[data-status-filter]'));

const approveDialog = /** @type {HTMLDialogElement} */ ($('[data-approve-dialog]'));
const approveForm = /** @type {HTMLFormElement} */ ($('[data-approve-form]'));
const approveAlert = $('[data-approve-alert]', approveForm);
const approveAffected = $('[data-approve-affected]', approveForm);
const rejectDialog = /** @type {HTMLDialogElement} */ ($('[data-reject-dialog]'));
const rejectForm = /** @type {HTMLFormElement} */ ($('[data-reject-form]'));
const rejectAlert = $('[data-reject-alert]', rejectForm);

/** Что применяет одобрение заявки — это видит администратор перед решением. */
const APPLIES = {
  vacation: 'После одобрения это время станет блокировкой «Отпуск»: клиенты перестанут видеть его свободным.',
  day_off: 'После одобрения это время станет блокировкой «Выходной».',
  sick_leave: 'После одобрения это время станет блокировкой «Больничный».',
  schedule: 'После одобрения у мастера будет новый недельный график с этой даты. Прежний закроется днем накануне.',
  other: 'Свободная просьба: расписание не изменится. Отметьте решение и сделайте нужное сами.',
};

let timezone = 'Europe/Moscow';
let requests = [];
let current = null;

const byId = (id) => requests.find((r) => r.id === id);

function requestCard(r) {
  const period = periodText(r);
  const decision = decisionText(r);
  return `
    <article class="day-row" data-request="${r.id}">
      <p class="day-row__time">${esc(TYPE_LABEL[r.type] ?? r.type)}</p>
      <div class="day-row__main">
        <p class="day-row__client">${esc(r.master.name)}${period ? ` · ${esc(period)}` : ''}</p>
        ${r.comment ? `<p class="day-row__meta">${esc(r.comment)}</p>` : ''}
        <p class="day-row__muted">Подана ${esc(dayLabel(r.createdAt.slice(0, 10)))}</p>
        ${decision ? `<p class="day-row__muted">${esc(decision)}</p>` : ''}
        ${photoPreview(r)}
      </div>
      <p class="day-row__status">${statusBadge(r.status)}</p>
      <div class="day-row__actions">
        ${r.status === 'pending' ? `
          <button class="btn btn--primary btn--small" type="button" data-action="approve">Одобрить</button>
          <button class="btn btn--danger btn--small" type="button" data-action="reject">Отклонить</button>` : ''}
      </div>
    </article>`;
}

async function load() {
  pageLoading.hidden = false;
  pageError.hidden = true;
  try {
    const answer = await api.getRequests({ status: statusFilter.value });
    requests = answer.requests;
    summary.textContent = answer.pendingCount
      ? `${answer.pendingCount} ${plural(answer.pendingCount, 'новая заявка', 'новые заявки', 'новых заявок')}`
      : 'Новых заявок нет';
    list.innerHTML = requests.length
      ? requests.map(requestCard).join('')
      : `<div class="admin-state">
           <p class="admin-state__title">Заявок нет</p>
           <p class="admin-state__text">Здесь появятся заявки мастеров на отпуск, отгул, больничный и новый график.</p>
         </div>`;
  } catch (error) {
    if (handleAccessError(error)) return;
    list.innerHTML = '';
    pageError.textContent = `Не удалось загрузить заявки. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    pageLoading.hidden = true;
  }
}

statusFilter.addEventListener('change', load);

for (const dialog of [approveDialog, rejectDialog]) {
  dialog.querySelectorAll('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

const summaryOf = (r) => `${r.master.name} · ${TYPE_LABEL[r.type] ?? r.type}${periodText(r) ? ` · ${periodText(r)}` : ''}`;

/** Записи под изменением: их администратор перенесет или отменит сам — сами они не отменяются. */
function showAffected(bookings) {
  if (!bookings?.length) {
    approveAffected.hidden = true;
    return;
  }
  const box = document.createElement('div');
  const intro = document.createElement('p');
  intro.innerHTML = `<strong>На это время есть записи (${bookings.length}).</strong> Они не отменятся сами — перенесите или отмените их на странице «Записи».`;
  const rows = document.createElement('ul');
  rows.className = 'admin-list';
  for (const b of bookings) {
    const item = document.createElement('li');
    item.textContent = `${dateLabel(b.startsAt, timezone)}, ${timeLabel(b.startsAt, timezone)} · ${b.client?.name ?? ''} · ${b.items.map((i) => i.name).join(', ')}`;
    rows.append(item);
  }
  box.append(intro, rows);
  approveAffected.replaceChildren(box);
  approveAffected.hidden = false;
}

async function openApprove(r) {
  current = r;
  clearErrors(approveForm, approveAlert);
  approveAffected.hidden = true;
  /** @type {HTMLInputElement} */ ($('[data-approve-reason]', approveForm)).value = '';
  $('[data-approve-summary]', approveForm).textContent = summaryOf(r);
  $('[data-approve-note]', approveForm).textContent = APPLIES[r.type] ?? '';
  approveDialog.showModal();
  try {
    showAffected(await api.getRequestAffected(r.id));
  } catch (error) {
    if (!handleAccessError(error)) approveAffected.hidden = true;
  }
}

function openReject(r) {
  current = r;
  clearErrors(rejectForm, rejectAlert);
  /** @type {HTMLInputElement} */ ($('[data-reject-reason]', rejectForm)).value = '';
  $('[data-reject-summary]', rejectForm).textContent = summaryOf(r);
  rejectDialog.showModal();
}

list.addEventListener('click', (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
  if (!(button instanceof HTMLElement)) return;
  const request = byId(Number(/** @type {HTMLElement} */ (button.closest('[data-request]')).dataset.request));
  if (!request) return;
  if (button.dataset.action === 'approve') openApprove(request);
  else openReject(request);
});

approveForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!current) return;
  clearErrors(approveForm, approveAlert);
  const done = setBusy(/** @type {HTMLButtonElement} */ ($('[data-approve-submit]', approveForm)), 'Одобряем…');
  try {
    const answer = await api.approveRequest(current.id, {
      reason: /** @type {HTMLInputElement} */ ($('[data-approve-reason]', approveForm)).value.trim() || null,
    });
    approveDialog.close();
    const affected = answer.affectedBookings?.length ?? 0;
    setFlash(affected ? 'warning' : 'success', affected
      ? `Заявка одобрена. На это время осталось ${affected} ${plural(affected, 'запись', 'записи', 'записей')} — перенесите или отмените их на странице «Записи».`
      // У заявки на фото расписание ни при чем: меняется портрет мастера на сайте
      : current.type === 'photo'
        ? 'Фото одобрено: оно появилось в профиле мастера и на главной.'
        : 'Заявка одобрена, расписание мастера обновлено.');
    window.location.reload();
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(approveForm, approveAlert, error);
  }
});

rejectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!current) return;
  clearErrors(rejectForm, rejectAlert);
  const reason = /** @type {HTMLInputElement} */ ($('[data-reject-reason]', rejectForm)).value.trim();
  if (!showErrors(rejectForm, { reason: reason ? null : 'Напишите причину — мастер увидит ее в своих заявках' })) return;
  const done = setBusy(/** @type {HTMLButtonElement} */ (rejectForm.querySelector('[type=submit]')), 'Отклоняем…');
  try {
    await api.rejectRequest(current.id, { reason });
    rejectDialog.close();
    setFlash('success', 'Заявка отклонена, мастер увидит причину.');
    window.location.reload();
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(rejectForm, rejectAlert, error);
  }
});

[approveForm, rejectForm].forEach((form) => clearOnInput(form));

async function start() {
  try {
    timezone = (await api.getStudio()).timezone;
  } catch {
    // Часовой пояс нужен только для дат записей в предупреждении
  }
  load();
}

if (await adminReady) start();
