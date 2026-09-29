// Каркас раздела администратора (/admin): меню раздела <admin-nav> и проверка роли на странице.
// Страница пишет тег <admin-nav>, область [data-admin-main] и подключает этот файл.
//
// Доступ к разделу закрывает сервер: страницы /admin он отдает только администратору, клиенту и мастеру —
// 403 и страницу «Этот раздел только для администраторов» (server/src/web/admin-pages.ts), а данные раздела —
// только из /api/admin/*, которые проверяют роль сами (server/src/api/guards.ts, requireRole).
// Здесь проверка повторяется, чтобы решить, что показать: меню раздела рисуется только после того, как
// GET /api/auth/me подтвердил роль администратора (hasRole — наличие роли в списке `roles`).
// Если сессия кончилась, пока страница открыта, — на вход с возвратом; если роли нет — то же сообщение, что у сервера.
//
// Пункты меню — экраны карты (docs/ui-map.md, «Раздел администратора»): «Записи» — шахматка A-01,
// «Услуги» — A-23, «Мастера» — A-19. Страницы пока пустые: данные подключаются в следующих итерациях.
import * as api from './api.js';
import { hasRole } from './roles.js';
import { routes } from './routes.js';

const ICONS = {
  // Календарь с днями — «Расписание» в меню прототипа (lucide calendar-days)
  bookings: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  // Искры — «Услуги» (lucide sparkles)
  services: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M17 5h4M5 17v4M3 19h4"/>',
  // Человек — «Мастера» (lucide user-round)
  masters: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
};

export const LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

const ITEMS = [
  { href: routes.admin, label: 'Записи', icon: ICONS.bookings },
  { href: routes.adminServices, label: 'Услуги', icon: ICONS.services },
  { href: routes.adminMasters, label: 'Мастера', icon: ICONS.masters },
];

/** Адрес текущей страницы раздела без «/» на конце: /admin, /admin/services. */
const currentPath = () => window.location.pathname.replace(/\/+$/, '') || '/';

class AdminNav extends HTMLElement {
  /** Меню появляется только у администратора: вызывается после проверки роли. */
  render() {
    const path = currentPath();
    this.innerHTML = `
      <nav class="admin-nav" aria-label="Раздел администратора">
        <p class="admin-nav__title">Администратор</p>
        ${ITEMS.map((item) => `
          <a class="admin-nav__item" href="${item.href}"${item.href === path ? ' aria-current="page"' : ''}>
            <svg viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg>
            <span>${item.label}</span>
          </a>`).join('')}
      </nav>`;
  }
}

customElements.define('admin-nav', AdminNav);

/** Сообщение вместо содержимого страницы — то же, что на странице 403 от сервера (web/forbidden.html). */
export function showAccessDenied() {
  document.querySelector('admin-nav')?.replaceChildren();
  const main = /** @type {HTMLElement} */ (document.querySelector('[data-admin-main]'));
  document.title = 'Этот раздел только для администраторов — Ноготочки';
  main.innerHTML = `
    <div class="admin-state" role="alert">
      <div class="admin-state__icon">${LOCK_ICON}</div>
      <h1 class="admin-state__title">Этот раздел только для администраторов</h1>
      <p class="admin-state__text">У вашей учетной записи нет доступа к разделу администратора.
        Записи, профиль и историю визитов клиент смотрит в личном кабинете.</p>
      <div class="admin-state__actions">
        <a class="btn btn--primary btn--small" href="${routes.account}">В личный кабинет</a>
        <a class="link" href="${routes.home}">На главную</a>
      </div>
    </div>`;
}

/** Вход с возвратом на эту страницу: сессии нет или она истекла. */
function goLogin() {
  window.location.replace(`/${routes.login}?next=${encodeURIComponent(currentPath())}`);
}

/**
 * Ответ API на странице раздела: 401 — снова вход, 403 — «Этот раздел только для администраторов».
 * Страницы раздела передают сюда ошибки своих запросов к /api/admin/*.
 * @param {unknown} error
 * @returns {boolean} true — ошибка обработана
 */
export function handleAccessError(error) {
  if (!(error instanceof api.ApiError)) return false;
  if (error.status === 401) {
    goLogin();
    return true;
  }
  if (error.status === 403) {
    showAccessDenied();
    return true;
  }
  return false;
}

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
    return;
  }
  if (!user) return goLogin();
  if (!hasRole(user, 'admin')) return showAccessDenied();

  /** @type {AdminNav} */ (document.querySelector('admin-nav')).render();
  loading.hidden = true;
  content.hidden = false;
}

start();
