// Каркас раздела мастера (/master): меню <master-nav> и проверка роли на странице.
//
// Доступ закрывает сервер: страницы /master он отдает только мастеру, остальным — 403 и страницу
// «Этот раздел только для мастеров» (server/src/web/admin-pages.ts); данные — только из /api/master/*,
// которые проверяют роль сами. Здесь проверка повторяется, чтобы решить, что показать.
//
// Мастер записи не ведет (паспорт, функции мастера): он смотрит свое расписание и подает заявки
// администратору — на отпуск, отгул, больничный, новый график или свободную просьбу.
import * as api from './api.js';
import { hasRole } from './roles.js';
import { routes } from './routes.js';

const ICONS = {
  // Календарь — «Мое расписание» (lucide calendar-days)
  schedule: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  // Лист с галочкой — «Мои заявки» (lucide clipboard-check)
  requests: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
};

const ITEMS = [
  { href: routes.master, label: 'Расписание', icon: ICONS.schedule },
  { href: routes.masterRequests, label: 'Мои заявки', icon: ICONS.requests },
];

const currentPath = () => window.location.pathname.replace(/\/+$/, '') || '/';

class MasterNav extends HTMLElement {
  /** Меню появляется только у мастера: вызывается после проверки роли. */
  render() {
    const path = currentPath();
    this.innerHTML = `
      <nav class="admin-nav" aria-label="Раздел мастера">
        <p class="admin-nav__title">Мастер</p>
        ${ITEMS.map((item) => `
          <a class="admin-nav__item" href="${item.href}"${item.href === path ? ' aria-current="page"' : ''}>
            <svg viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg>
            <span>${item.label}</span>
          </a>`).join('')}
      </nav>`;
  }
}

customElements.define('master-nav', MasterNav);

const LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

/** Сообщение вместо содержимого страницы — то же, что на странице 403 от сервера (web/forbidden-master.html). */
function showAccessDenied() {
  document.querySelector('master-nav')?.replaceChildren();
  const main = /** @type {HTMLElement} */ (document.querySelector('[data-admin-main]'));
  document.title = 'Этот раздел только для мастеров — Ноготочки';
  main.innerHTML = `
    <div class="admin-state" role="alert">
      <div class="admin-state__icon">${LOCK_ICON}</div>
      <h1 class="admin-state__title">Этот раздел только для мастеров</h1>
      <p class="admin-state__text">Расписание мастера видит только он сам.</p>
      <div class="admin-state__actions">
        <a class="link" href="${routes.home}">На главную</a>
      </div>
    </div>`;
}

function goLogin() {
  window.location.replace(`/${routes.login}?next=${encodeURIComponent(currentPath())}`);
}

/**
 * Ответ API на странице раздела: 401 — снова вход, 403 — «Этот раздел только для мастеров».
 * Учетная запись без профиля мастера (403 MASTER_NOT_LINKED) — отдельное сообщение: ее связывает администратор.
 * @returns {boolean} true — ошибка обработана
 */
export function handleAccessError(error) {
  if (!(error instanceof api.ApiError)) return false;
  if (error.status === 401) {
    goLogin();
    return true;
  }
  if (error.status === 403) {
    if (error.code === 'MASTER_NOT_LINKED') {
      const main = /** @type {HTMLElement} */ (document.querySelector('[data-admin-main]'));
      main.innerHTML = `
        <div class="admin-state" role="alert">
          <p class="admin-state__title">Расписание еще не настроено</p>
          <p class="admin-state__text">${error.message}</p>
        </div>`;
      return true;
    }
    showAccessDenied();
    return true;
  }
  return false;
}

// ---------- Сообщение после перехода ----------

const FLASH_KEY = 'nog_master_flash';

/** @param {'success' | 'warning'} kind @param {string} text */
export function setFlash(kind, text) {
  try {
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({ kind, text }));
  } catch {
    // Хранилище недоступно — сообщение просто не покажется
  }
}

function showFlash() {
  let flash = null;
  try {
    flash = JSON.parse(sessionStorage.getItem(FLASH_KEY) ?? 'null');
    sessionStorage.removeItem(FLASH_KEY);
  } catch {
    return;
  }
  const slot = document.querySelector('[data-flash]');
  if (!flash || !slot) return;
  slot.className = `alert alert--${flash.kind === 'warning' ? 'warning' : 'success'} admin-flash`;
  slot.textContent = flash.text;
  slot.hidden = false;
}

/** @returns {Promise<object | null>} */
async function start() {
  const loading = /** @type {HTMLElement} */ (document.querySelector('[data-view="loading"]'));
  const content = /** @type {HTMLElement} */ (document.querySelector('[data-view="content"]'));
  const error = /** @type {HTMLElement} */ (document.querySelector('[data-view="error"]'));
  error.querySelector('[data-retry]')?.addEventListener('click', () => window.location.reload());
  let user;
  try {
    user = await api.getMe();
  } catch (e) {
    loading.hidden = true;
    error.hidden = false;
    /** @type {HTMLElement} */ (error.querySelector('[data-error-text]')).textContent = e instanceof api.ApiError
      ? e.message
      : 'Не удалось проверить вход. Обновите страницу.';
    return null;
  }
  if (!user) {
    goLogin();
    return null;
  }
  if (!hasRole(user, 'master')) {
    showAccessDenied();
    return null;
  }

  /** @type {MasterNav} */ (document.querySelector('master-nav')).render();
  loading.hidden = true;
  content.hidden = false;
  showFlash();
  return user;
}

/** Пользователь, когда роль мастера подтверждена; null — сессии нет или роли нет (страница уже заменена). */
export const masterReady = start();
