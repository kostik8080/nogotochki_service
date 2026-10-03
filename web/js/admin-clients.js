// A-07 Клиенты (docs/ui-map.md, «Раздел администратора»): список клиентов студии с поиском, фильтрами
// по меткам и управлением доступом к учетной записи.
//
// Главное здесь — доступ. Паспорт, функция 1 администратора: «Администратор может закрыть доступ любой
// учетной записи». Эндпоинты для этого были, а экрана не было (ui-map.md, список 4, пункт 11), и закрыть
// доступ можно было только запросом к API. Теперь это кнопка в строке клиента.
//
// Данные: GET /api/admin/clients?search=&filter=&limit=&offset= — имя, телефон, e-mail, число завершенных
// визитов, последний визит, любимый мастер, метка («Новый», «Постоянный», «Давно не приходил»),
// черный список и `isBlocked` — закрыт ли доступ.
// Кнопки: «Закрыть доступ» — PUT /api/admin/users/:id/block (с подтверждением: у человека сразу закроются
// все сессии), «Открыть доступ» — DELETE того же адреса.
//
// Чего на экране пока нет: карточки клиента A-09 с историей визитов, заметками и «Важно», быстрого
// просмотра A-08, добавления клиента и черного списка A-11 — это отдельная задача, здесь только список.
import { adminReady, handleAccessError } from './admin.js';
import * as api from './api.js';
import { dateLabel, escapeHtml as esc, initials, money, phone as formatPhone, plural } from './format.js';

const $ = (selector, root = document) => /** @type {HTMLElement} */ (root.querySelector(selector));

const list = $('[data-list]');
const loading = $('[data-page-loading]');
const pageError = $('[data-page-error]');
const summary = $('[data-summary]');
const actionAlert = $('[data-action-alert]');
const pager = $('[data-pager]');
const pagerStatus = $('[data-pager-status]');
const searchForm = /** @type {HTMLFormElement} */ ($('[data-search-form]'));
const searchInput = /** @type {HTMLInputElement} */ (searchForm.elements.namedItem('search'));
const dialog = /** @type {HTMLDialogElement} */ ($('[data-block-dialog]'));
const dialogWho = $('[data-block-who]', dialog);
const dialogError = $('[data-block-error]', dialog);
const dialogConfirm = /** @type {HTMLButtonElement} */ ($('[data-block-confirm]', dialog));

/** По сколько клиентов на странице — как в прототипе (A-07). */
const PAGE_SIZE = 8;

const TAGS = {
  new: { label: 'Новый', cls: 'on' },
  regular: { label: 'Постоянный', cls: 'done' },
  lapsed: { label: 'Давно не приходил', cls: 'warn' },
};

const state = {
  search: '',
  /** '' — все; new, regular, lapsed, blacklist */
  filter: '',
  offset: 0,
  total: 0,
  timezone: 'Europe/Moscow',
};

/** Клиент, у которого сейчас спрашиваем подтверждение на закрытие доступа. */
let pending = null;

// ---------- Список ----------

function badge(cls, text) {
  return `<span class="admin-badge admin-badge--${cls}">${esc(text)}</span>`;
}

/** Строка таблицы. Доступ показываем у всех: закрытый доступ не дает и зарегистрироваться на этот номер. */
function row(c) {
  const tag = TAGS[c.tags[0]];
  return `
    <tr${c.isBlocked ? ' class="is-off"' : ''}>
      <td class="admin-table__name" data-label="Клиент">
        <span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span>
        ${esc(c.name)}
        ${c.isBlacklisted ? badge('off', 'Черный список') : ''}
        ${tag ? badge(tag.cls, tag.label) : ''}
      </td>
      <td data-label="Контакты">
        ${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(formatPhone(c.phone))}</a>` : '<span class="admin-table__muted">Телефона нет</span>'}
        ${c.email ? `<span class="admin-table__muted">${esc(c.email)}</span>` : ''}
        ${c.hasAccount ? '' : '<span class="admin-table__muted">Записан студией, без пароля</span>'}
      </td>
      <td class="admin-table__num" data-label="Визиты">
        ${c.visits}
        ${c.lastVisit ? `<span class="admin-table__muted">${esc(dateLabel(c.lastVisit, state.timezone))}</span>` : '<span class="admin-table__muted">визитов не было</span>'}
        ${c.totalSpentKop ? `<span class="admin-table__muted">${esc(money(c.totalSpentKop))}</span>` : ''}
      </td>
      <td data-label="Любимый мастер">
        ${c.favoriteMaster ? esc(c.favoriteMaster.name) : '<span class="admin-table__muted">—</span>'}
      </td>
      <td data-label="Доступ">
        ${c.isBlocked ? badge('off', 'Доступ закрыт') : badge('on', 'Доступ открыт')}
        <span class="admin-table__action">
          <button class="btn btn--small ${c.isBlocked ? 'btn--outline' : 'btn--danger'}" type="button"
            data-user="${c.id}" data-name="${esc(c.name)}" data-action="${c.isBlocked ? 'unblock' : 'block'}">
            ${c.isBlocked ? 'Открыть доступ' : 'Закрыть доступ'}
          </button>
        </span>
      </td>
    </tr>`;
}

function render(data) {
  state.total = data.total;
  const shown = data.clients.length;

  summary.textContent = data.total
    ? `${data.total} ${plural(data.total, 'клиент', 'клиента', 'клиентов')}`
    : '';

  if (!shown) {
    list.innerHTML = `
      <div class="admin-state">
        <p class="admin-state__title">${state.search || state.filter ? 'Никого не нашли' : 'Клиентов пока нет'}</p>
        <p class="admin-state__text">${state.search || state.filter
          ? 'Попробуйте другой запрос или снимите фильтр.'
          : 'Клиент появится здесь после первой записи — своей или созданной администратором.'}</p>
      </div>`;
    pager.hidden = true;
    return;
  }

  list.innerHTML = `
    <table class="admin-table admin-table--clients">
      <thead>
        <tr>
          <th scope="col">Клиент</th>
          <th scope="col">Контакты</th>
          <th scope="col">Визиты</th>
          <th scope="col">Любимый мастер</th>
          <th scope="col">Доступ</th>
        </tr>
      </thead>
      <tbody>${data.clients.map(row).join('')}</tbody>
    </table>`;

  const from = state.offset + 1;
  const to = state.offset + shown;
  pagerStatus.textContent = `${from}–${to} из ${data.total}`;
  /** @type {HTMLButtonElement} */ ($('[data-prev]')).disabled = state.offset === 0;
  /** @type {HTMLButtonElement} */ ($('[data-next]')).disabled = to >= data.total;
  pager.hidden = data.total <= PAGE_SIZE;
}

async function load() {
  loading.hidden = false;
  pageError.hidden = true;
  try {
    const data = await api.getAdminClients({
      search: state.search,
      filter: state.filter,
      limit: PAGE_SIZE,
      offset: state.offset,
    });
    render(data);
  } catch (error) {
    if (handleAccessError(error)) return;
    list.innerHTML = '';
    pager.hidden = true;
    pageError.textContent = `Не удалось загрузить клиентов. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

// ---------- Поиск, фильтры, страницы ----------

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  state.search = searchInput.value.trim();
  state.offset = 0;
  load();
});

// Очистили поле крестиком — показываем всех, не дожидаясь «Найти»
searchInput.addEventListener('search', () => {
  if (searchInput.value === '' && state.search !== '') {
    state.search = '';
    state.offset = 0;
    load();
  }
});

for (const input of document.querySelectorAll('input[name="filter"]')) {
  input.addEventListener('change', () => {
    state.filter = /** @type {HTMLInputElement} */ (input).value;
    state.offset = 0;
    load();
  });
}

$('[data-prev]').addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  load();
});

$('[data-next]').addEventListener('click', () => {
  if (state.offset + PAGE_SIZE < state.total) state.offset += PAGE_SIZE;
  load();
});

// ---------- Доступ к учетной записи ----------

function showAlert(kind, text) {
  actionAlert.className = `alert alert--${kind}`;
  actionAlert.textContent = text;
  actionAlert.hidden = false;
}

/** Открыть доступ — действие возвратное, спрашивать не о чем: делаем сразу. */
async function unblock(button, id, name) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Открываем…';
  try {
    await api.unblockUser(id);
    showAlert('success', `Доступ открыт: ${name} снова может войти прежним паролем.`);
    await load();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    if (handleAccessError(error)) return;
    showAlert('error', `Не удалось открыть доступ. ${error instanceof api.ApiError ? error.message : 'Попробуйте еще раз.'}`);
  }
}

list.addEventListener('click', (event) => {
  const button = /** @type {HTMLButtonElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-action]'));
  if (!button) return;
  const id = Number(button.dataset.user);
  const name = button.dataset.name ?? 'Клиент';
  actionAlert.hidden = true;
  if (button.dataset.action === 'unblock') {
    unblock(button, id, name);
    return;
  }
  pending = { id, name };
  dialogWho.textContent = name;
  dialogError.hidden = true;
  dialogConfirm.disabled = false;
  dialogConfirm.textContent = 'Закрыть доступ';
  dialog.showModal();
});

$('[data-block-cancel]', dialog).addEventListener('click', () => dialog.close());

dialogConfirm.addEventListener('click', async () => {
  if (!pending) return;
  dialogConfirm.disabled = true;
  dialogConfirm.textContent = 'Закрываем…';
  dialogError.hidden = true;
  try {
    await api.blockUser(pending.id);
    const { name } = pending;
    pending = null;
    dialog.close();
    showAlert('success', `Доступ закрыт: ${name} больше не сможет войти, пока вы не откроете доступ. Сессии этой учетной записи уже закрыты.`);
    await load();
  } catch (error) {
    dialogConfirm.disabled = false;
    dialogConfirm.textContent = 'Закрыть доступ';
    if (handleAccessError(error)) return;
    dialogError.textContent = error instanceof api.ApiError ? error.message : 'Не удалось закрыть доступ. Попробуйте еще раз.';
    dialogError.hidden = false;
  }
});

// ---------- Старт ----------

async function start() {
  const studio = await api.getStudio().catch(() => null);
  if (studio) state.timezone = studio.timezone;
  await load();
}

if (await adminReady) start();
