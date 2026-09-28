// Общая шапка клиента: элемент <client-header>. Страница пишет только тег и подключает этот файл —
// разметка, данные и поведение шапки живут здесь, в одном месте.
//
// Состав — лист «Навигация» карты связей (docs/karta-svyazey-prototipa.xlsx) и шапка лендинга в прототипе:
//   логотип → главная (N-25);
//   вошел клиент: «Записаться» → BOOK-01 (N-26), аватар с инициалами и имя, меню «Мои записи» (N-09),
//                 «Профиль» (N-10), «Выйти» → главная (N-11, N-27);
//   не вошел: «Войти» (N-08) и «Регистрация» (N-54) вместо аватара.
// Имя — из GET /api/auth/me (один запрос на страницу, см. api.getMe). Меню аккаунта использует и шапка лендинга.
import * as api from './api.js';
import { escapeHtml as esc, initials } from './format.js';
import { routes } from './routes.js';

const EMBLEM = `
  <svg class="logo__emblem" viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <g stroke="currentColor" stroke-width="1.3">
      <ellipse cx="20" cy="14" rx="5" ry="11"/>
      <ellipse cx="20" cy="14" rx="5" ry="11" transform="rotate(72 20 20)"/>
      <ellipse cx="20" cy="14" rx="5" ry="11" transform="rotate(144 20 20)"/>
      <ellipse cx="20" cy="14" rx="5" ry="11" transform="rotate(216 20 20)"/>
      <ellipse cx="20" cy="14" rx="5" ry="11" transform="rotate(288 20 20)"/>
    </g>
  </svg>`;

/** Имя файла текущей страницы: «account.html». Корень сайта — «index.html». */
const currentPage = () => window.location.pathname.split('/').pop() || routes.home;

let menuCounter = 0;

/**
 * Меню аккаунта: аватар, имя и выпадающий список. Клиенту — «Мои записи» и «Профиль»; у сотрудника
 * клиентских экранов нет, ему — только «Выйти». Закрывается кликом мимо и клавишей Escape.
 * @param {HTMLElement} container куда нарисовать
 * @param {{ name: string, role: string }} user
 * @param {{ onLoggedOut: () => void }} options что сделать после выхода
 */
export function mountAccountMenu(container, user, { onLoggedOut }) {
  const id = `account-menu-${++menuCounter}`;
  const links = user.role === 'client'
    ? [{ href: routes.account, label: 'Мои записи' }, { href: routes.profile, label: 'Профиль' }]
    : [];
  const page = currentPage();

  container.innerHTML = `
    <div class="account-menu">
      <button class="account-menu__toggle" type="button" aria-expanded="false" aria-controls="${id}"
              aria-label="Меню аккаунта: ${esc(user.name)}">
        <span class="avatar" aria-hidden="true">${esc(initials(user.name))}</span>
        <span class="account-menu__name">${esc(user.name)}</span>
      </button>
      <div class="account-menu__list" id="${id}" data-theme="powder" hidden>
        ${links.map((l) => `<a class="account-menu__item" href="${esc(l.href)}"${l.href === page ? ' aria-current="page"' : ''}>${esc(l.label)}</a>`).join('')}
        <button class="account-menu__item account-menu__item--danger" type="button" data-menu-logout>Выйти</button>
        <p class="account-menu__error" role="alert" hidden></p>
      </div>
    </div>`;

  const root = /** @type {HTMLElement} */ (container.querySelector('.account-menu'));
  const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.account-menu__toggle'));
  const list = /** @type {HTMLElement} */ (root.querySelector('.account-menu__list'));
  const logout = /** @type {HTMLButtonElement} */ (root.querySelector('[data-menu-logout]'));
  const errorBox = /** @type {HTMLElement} */ (root.querySelector('.account-menu__error'));

  // Слушатели документа снимаются, когда меню перерисовывают (например, после выхода)
  const listeners = new AbortController();
  const setOpen = (open) => {
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(list.hidden));
  document.addEventListener('click', (event) => {
    if (!root.isConnected) return listeners.abort();
    if (!list.hidden && !root.contains(/** @type {Node} */ (event.target))) setOpen(false);
  }, { signal: listeners.signal });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !list.hidden) {
      setOpen(false);
      toggle.focus();
    }
  }, { signal: listeners.signal });

  logout.addEventListener('click', async () => {
    logout.disabled = true;
    errorBox.hidden = true;
    try {
      await api.logout();
      listeners.abort();
      onLoggedOut();
    } catch (error) {
      errorBox.textContent = `Не удалось выйти. ${error.message}`;
      errorBox.hidden = false;
      logout.disabled = false;
    }
  });
}

class ClientHeader extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = 'true';
    this.innerHTML = `
      <header class="page-header">
        <div class="container page-header__inner">
          <a class="logo" href="${routes.home}" aria-label="Ноготочки — на главную">
            ${EMBLEM}
            <span class="logo__text">Ноготочки<span class="logo__sub">бьюти-студия</span></span>
          </a>
          <div class="client-header__actions" data-actions aria-live="polite">
            <span class="skeleton skeleton--button" aria-hidden="true"></span>
          </div>
        </div>
      </header>`;

    // Высота шапки — для прилипающих блоков страницы и для прокрутки к якорю: они не должны уходить под шапку
    new ResizeObserver(() => {
      const height = `${this.offsetHeight}px`;
      document.documentElement.style.setProperty('--site-header-height', height);
      document.documentElement.style.scrollPaddingTop = height;
    }).observe(this);

    this.load();
  }

  async load() {
    const actions = /** @type {HTMLElement} */ (this.querySelector('[data-actions]'));
    let user = null;
    try {
      user = await api.getMe();
    } catch {
      // Не удалось узнать, вошел ли человек (нет сети): показываем вход. Ошибку покажет сама страница
    }
    this.render(actions, user);
  }

  render(actions, user) {
    if (!user) {
      actions.innerHTML = `
        <a class="client-header__login" href="${routes.login}">Войти</a>
        <a class="btn btn--primary btn--small client-header__register" href="${routes.register}">Регистрация</a>`;
      return;
    }
    actions.innerHTML = `
      ${user.role === 'client' ? `<a class="btn btn--primary btn--small client-header__book" href="${esc(routes.booking())}">Записаться</a>` : ''}
      <div data-menu></div>`;
    mountAccountMenu(/** @type {HTMLElement} */ (actions.querySelector('[data-menu]')), user, {
      onLoggedOut: () => window.location.assign(routes.home),
    });
  }
}

customElements.define('client-header', ClientHeader);
