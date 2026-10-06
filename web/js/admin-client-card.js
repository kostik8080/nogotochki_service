// A-09 Карточка клиента (docs/ui-map.md, «Раздел администратора»): /admin/clients/card?id=3.
// Все, что студия знает о человеке: контакты, «Важно», сводка по визитам, заметки (в том числе со слов
// мастера), черный список и история записей.
//
// Эндпоинты были с самого начала, а экрана не было — находка № 13 прогона. Из-за этого «Важно», заметки
// и черный список можно было завести только запросом к API, хотя мастер поле «Важно» в расписании видит.
//
// Данные: GET /api/admin/clients/:id, GET /api/admin/masters (для заметки «со слов мастера»),
// GET /api/studio (часовой пояс — даты визитов).
// Кнопки: «Сохранить» — PATCH /api/admin/clients/:id (отправляются только измененные поля);
// «Добавить заметку» — POST /api/admin/clients/:id/notes, ✕ у заметки — DELETE …/notes/:noteId;
// «В черный список» — PUT …/blacklist (причина обязательна), «Убрать» — DELETE …/blacklist.
import { adminReady, handleAccessError } from './admin.js';
import * as api from './api.js';
import { clearErrors, clearOnInput, normalizePhone, setBusy, showAlert, showErrors, showServerError } from './form.js';
import { dateLabel, escapeHtml as esc, money, phone as formatPhone, plural, timeLabel } from './format.js';

const $ = (selector, root = document) => /** @type {HTMLElement} */ (root.querySelector(selector));

const card = $('[data-card]');
const loading = $('[data-page-loading]');
const pageError = $('[data-page-error]');
const flash = $('[data-flash-inline]');

const profileForm = /** @type {HTMLFormElement} */ ($('[data-profile-form]'));
const importantForm = /** @type {HTMLFormElement} */ ($('[data-important-form]'));
const noteForm = /** @type {HTMLFormElement} */ ($('[data-note-form]'));
const blacklistForm = /** @type {HTMLFormElement} */ ($('[data-blacklist-form]'));

const STATUS = {
  active: 'Активна',
  completed: 'Завершена',
  cancelled_by_client: 'Отменена клиентом',
  cancelled_by_studio: 'Отменена студией',
  no_show: 'Клиент не пришел',
};
const TAGS = { new: 'Новый', regular: 'Постоянный', lapsed: 'Давно не приходил' };

const idParam = new URLSearchParams(window.location.search).get('id');
const clientId = idParam && /^\d+$/.test(idParam) ? Number(idParam) : null;

/** Карточка, какой ее отдал сервер. */
let client = null;
let timezone = 'Europe/Moscow';

function showFlash(kind, text) {
  flash.className = `alert alert--${kind} admin-flash`;
  flash.textContent = text;
  flash.hidden = false;
}

// ---------- Отрисовка ----------

function badge(cls, text) {
  return `<span class="admin-badge admin-badge--${cls}">${esc(text)}</span>`;
}

function renderHead() {
  $('[data-title]').textContent = client.name;
  document.title = `${client.name} — раздел администратора — Ноготочки`;

  const contacts = [
    client.phone ? formatPhone(client.phone) : 'телефона нет',
    client.email ?? 'e-mail нет',
    client.hasAccount ? 'есть учетная запись' : 'записан студией, без пароля',
  ];
  $('[data-contacts]').textContent = contacts.join(' · ');

  const tag = client.tags?.[0];
  $('[data-badges]').innerHTML = [
    client.isBlacklisted ? badge('off', 'Черный список') : '',
    client.isBlocked ? badge('off', 'Доступ закрыт') : '',
    tag ? badge(tag === 'lapsed' ? 'warn' : tag === 'regular' ? 'done' : 'on', TAGS[tag] ?? tag) : '',
  ].join(' ');
}

function renderProfile() {
  const field = (name) => /** @type {HTMLInputElement} */ (profileForm.elements.namedItem(name));
  field('name').value = client.name;
  field('phone').value = client.phone ?? '';
  field('email').value = client.email ?? '';
  field('birthDate').value = client.profile?.birthDate ?? '';
  field('acquisitionSource').value = client.profile?.acquisitionSource ?? '';
  $('[data-phone-hint]', profileForm).textContent = client.phoneVerified
    ? 'Номер подтвержден.'
    : 'Номер не подтвержден: SMS в сервисе нет, подтверждение дает администратор по звонку.';
  /** @type {HTMLTextAreaElement} */ (importantForm.elements.namedItem('importantNote')).value =
    client.profile?.importantNote ?? '';
}

function renderStats() {
  const s = client.stats ?? {};
  const date = (iso) => (iso ? dateLabel(iso, timezone) : '—');
  const rows = [
    ['Завершенных визитов', String(s.visits ?? 0)],
    ['Отмен', String(s.cancellations ?? 0)],
    ['Неявок', String(s.noShows ?? 0)],
    ['Первый визит', date(s.firstVisit)],
    ['Последний визит', date(s.lastVisit)],
    ['Потрачено', money(s.totalSpentKop ?? 0)],
    ['Средний чек', s.averageCheckKop === null || s.averageCheckKop === undefined ? '—' : money(s.averageCheckKop)],
    ['Любимый мастер', client.favoriteMaster?.name ?? '—'],
  ];
  $('[data-stats]').innerHTML = rows.map(([label, value]) => `
    <div class="client-stat">
      <dt>${esc(label)}</dt>
      <dd>${esc(value)}</dd>
    </div>`).join('');
}

function renderNotes() {
  const notes = client.notes ?? [];
  $('[data-notes]').innerHTML = notes.length
    ? notes.map((n) => `
      <article class="client-note">
        <p class="client-note__text">${esc(n.text)}</p>
        <p class="client-note__meta">
          ${esc(dateLabel(n.createdAt, timezone))} · ${esc(n.author?.name ?? 'студия')}${n.master ? ` · со слов мастера: ${esc(n.master.name)}` : ''}
        </p>
        <button class="btn btn--outline btn--small" type="button" data-note-delete="${n.id}">Удалить</button>
      </article>`).join('')
    : '<p class="admin-table__muted">Заметок пока нет.</p>';
}

function renderBlacklist() {
  const state = $('[data-blacklist-state]');
  const reasonField = $('[data-blacklist-reason-field]');
  const addButton = /** @type {HTMLButtonElement} */ ($('[data-blacklist-add]'));
  const removeButton = /** @type {HTMLButtonElement} */ ($('[data-blacklist-remove]'));
  if (client.blacklist) {
    const { reason, at, by } = client.blacklist;
    state.textContent = `В черном списке с ${dateLabel(at, timezone)}. Причина: ${reason}. Внес: ${by?.name ?? 'студия'}.`;
    reasonField.hidden = true;
    addButton.hidden = true;
    removeButton.hidden = false;
  } else {
    state.textContent = 'Клиент не в черном списке. Отметка видна только в разделе администратора — '
      + 'записаться она не мешает.';
    reasonField.hidden = false;
    addButton.hidden = false;
    removeButton.hidden = true;
  }
}

function renderBookings() {
  const bookings = client.bookings ?? [];
  if (!bookings.length) {
    $('[data-bookings]').innerHTML = '<p class="admin-table__muted">Записей пока нет.</p>';
    return;
  }
  const rows = [...bookings].sort((a, b) => b.startsAt.localeCompare(a.startsAt)).map((b) => {
    const services = (b.items ?? []).map((i) => i.name + (i.quantity > 1 ? ` ×${i.quantity}` : '')).join(', ');
    const sum = (b.items ?? []).reduce((acc, i) => acc + (i.priceKop ?? 0), 0);
    return `
      <tr>
        <td class="admin-table__name" data-label="Когда">
          ${esc(dateLabel(b.startsAt, timezone))}
          <span class="admin-table__muted">${esc(timeLabel(b.startsAt, timezone))}</span>
        </td>
        <td data-label="Услуги">${esc(services || '—')}</td>
        <td data-label="Мастер">${esc(b.master?.name ?? '—')}</td>
        <td data-label="Состояние">${esc(STATUS[b.status] ?? b.status)}${b.cancellation?.reason ? `<span class="admin-table__muted">${esc(b.cancellation.reason)}</span>` : ''}</td>
        <td class="admin-table__num" data-label="Сумма">${esc(money(sum))}</td>
      </tr>`;
  }).join('');
  $('[data-bookings]').innerHTML = `
    <p class="admin-table__muted">${bookings.length} ${plural(bookings.length, 'запись', 'записи', 'записей')} за все время</p>
    <table class="admin-table admin-table--clients">
      <thead>
        <tr><th scope="col">Когда</th><th scope="col">Услуги</th><th scope="col">Мастер</th><th scope="col">Состояние</th><th scope="col">Сумма</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function render() {
  renderHead();
  renderProfile();
  renderStats();
  renderNotes();
  renderBlacklist();
  renderBookings();
  card.hidden = false;
}

// ---------- Сохранение ----------

/** Отправляем только то, что изменилось: PATCH не трогает поля, которых нет в теле. */
function changedProfileFields() {
  const field = (name) => /** @type {HTMLInputElement} */ (profileForm.elements.namedItem(name)).value.trim();
  const body = {};
  const name = field('name');
  if (name !== client.name) body.name = name;

  const phone = field('phone');
  const phoneNow = client.phone ?? '';
  if (phone !== phoneNow && !(phone === '' && phoneNow === '')) body.phone = phone ? normalizePhone(phone) ?? phone : null;

  const email = field('email').toLowerCase();
  const emailNow = client.email ?? '';
  if (email !== emailNow) body.email = email || null;

  const birth = field('birthDate');
  if (birth !== (client.profile?.birthDate ?? '')) body.birthDate = birth || null;

  const source = field('acquisitionSource');
  if (source !== (client.profile?.acquisitionSource ?? '')) body.acquisitionSource = source || null;

  return body;
}

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const alert = $('[data-profile-alert]', profileForm);
  clearErrors(profileForm, alert);
  const body = changedProfileFields();
  if (!Object.keys(body).length) {
    showAlert(alert, 'warning', 'Менять нечего: данные не изменились.');
    return;
  }
  const phone = /** @type {HTMLInputElement} */ (profileForm.elements.namedItem('phone')).value.trim();
  if (phone && !normalizePhone(phone)) {
    showErrors(profileForm, { phone: 'Проверьте телефон: например, +7 911 222-33-44' });
    return;
  }
  const done = setBusy(/** @type {HTMLButtonElement} */ (profileForm.querySelector('[type=submit]')), 'Сохраняем…');
  try {
    client = await api.updateAdminClient(clientId, body);
    done();
    render();
    showFlash('success', 'Данные клиента сохранены.');
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(profileForm, alert, error);
  }
});

importantForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const alert = $('[data-important-alert]', importantForm);
  clearErrors(importantForm, alert);
  const value = /** @type {HTMLTextAreaElement} */ (importantForm.elements.namedItem('importantNote')).value.trim();
  if (value === (client.profile?.importantNote ?? '')) {
    showAlert(alert, 'warning', 'Менять нечего: текст не изменился.');
    return;
  }
  const done = setBusy(/** @type {HTMLButtonElement} */ (importantForm.querySelector('[type=submit]')), 'Сохраняем…');
  try {
    client = await api.updateAdminClient(clientId, { importantNote: value || null });
    done();
    render();
    showFlash('success', value ? 'Поле «Важно» сохранено — мастер увидит его в расписании.' : 'Поле «Важно» очищено.');
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(importantForm, alert, error);
  }
});

// ---------- Заметки ----------

noteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const alert = $('[data-note-alert]', noteForm);
  clearErrors(noteForm, alert);
  const text = /** @type {HTMLTextAreaElement} */ (noteForm.elements.namedItem('text')).value.trim();
  if (!showErrors(noteForm, { text: text ? null : 'Напишите, что запомнить о клиенте' })) return;
  const masterId = /** @type {HTMLSelectElement} */ (noteForm.elements.namedItem('masterId')).value;
  const done = setBusy(/** @type {HTMLButtonElement} */ (noteForm.querySelector('[type=submit]')), 'Добавляем…');
  try {
    await api.addClientNote(clientId, { text, ...(masterId ? { masterId: Number(masterId) } : {}) });
    client = await api.getAdminClient(clientId);
    done();
    noteForm.reset();
    render();
    showFlash('success', 'Заметка добавлена.');
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(noteForm, alert, error);
  }
});

$('[data-notes]').addEventListener('click', async (event) => {
  const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-note-delete]'));
  if (!button) return;
  const done = setBusy(button, 'Удаляем…');
  try {
    await api.deleteClientNote(clientId, Number(button.dataset.noteDelete));
    client = await api.getAdminClient(clientId);
    done();
    render();
    showFlash('success', 'Заметка удалена.');
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showFlash('error', `Не удалось удалить заметку. ${error instanceof api.ApiError ? error.message : ''}`);
  }
});

// ---------- Черный список ----------

blacklistForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const alert = $('[data-blacklist-alert]', blacklistForm);
  clearErrors(blacklistForm, alert);
  const reason = /** @type {HTMLInputElement} */ (blacklistForm.elements.namedItem('reason')).value.trim();
  // Причина обязательна и на сервере — здесь проверяем, чтобы не гонять заведомо неверный запрос
  if (!showErrors(blacklistForm, { reason: reason ? null : 'Без причины внести в черный список нельзя' })) return;
  const done = setBusy(/** @type {HTMLButtonElement} */ ($('[data-blacklist-add]')), 'Вносим…');
  try {
    client = await api.blacklistClient(clientId, reason);
    done();
    blacklistForm.reset();
    render();
    showFlash('warning', 'Клиент в черном списке. Записаться это не мешает — отметка для студии.');
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(blacklistForm, alert, error);
  }
});

$('[data-blacklist-remove]').addEventListener('click', async () => {
  const button = /** @type {HTMLButtonElement} */ ($('[data-blacklist-remove]'));
  const done = setBusy(button, 'Убираем…');
  try {
    client = await api.unblacklistClient(clientId);
    done();
    render();
    showFlash('success', 'Клиент убран из черного списка.');
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showFlash('error', `Не удалось убрать из черного списка. ${error instanceof api.ApiError ? error.message : ''}`);
  }
});

clearOnInput(profileForm);
clearOnInput(importantForm);
clearOnInput(noteForm);
clearOnInput(blacklistForm);

// ---------- Загрузка ----------

async function load() {
  if (clientId === null) {
    pageError.textContent = 'В адресе страницы нет номера клиента. Откройте карточку из списка клиентов.';
    pageError.hidden = false;
    loading.hidden = true;
    return;
  }
  try {
    const [studio, loaded, masters] = await Promise.all([
      api.getStudio().catch(() => null),
      api.getAdminClient(clientId),
      api.getAdminMasters().catch(() => []),
    ]);
    if (studio) timezone = studio.timezone;
    client = loaded;
    const select = /** @type {HTMLSelectElement} */ ($('[data-note-master]'));
    for (const m of masters) {
      const option = document.createElement('option');
      option.value = String(m.id);
      option.textContent = m.name;
      select.append(option);
    }
    render();
  } catch (error) {
    if (handleAccessError(error)) return;
    pageError.textContent = error instanceof api.ApiError && error.status === 404
      ? 'Клиент не найден. Возможно, он удалил аккаунт.'
      : `Не удалось загрузить карточку. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

if (await adminReady) load();
