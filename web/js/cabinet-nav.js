// Меню кабинета: элемент <cabinet-nav>. Страница кабинета пишет только тег в колонку меню и подключает
// этот файл — пункты, отметка текущей страницы и выход живут здесь, в одном месте.
//
// Состав — лист «Навигация» карты связей: «Мои записи» → CAB-01 (N-20), «История» → CAB-02 (N-21),
// «Профиль» → CAB-07 (N-23), «Выйти» → POST /api/auth/logout и на главную (N-27).
// Как в прототипе, на планшете и компьютере меню стоит слева, на телефоне — темная панель внизу экрана.
// Панель элемент сам добавляет в конец страницы: она в темной теме, а колонка меню — внутри светлой
// области кабинета, и вложенный блок не может вернуть себе темные токены.
import * as api from './api.js';
import { routes } from './routes.js';

const ITEMS = [
  { href: routes.account, label: 'Мои записи' },
  { href: routes.history, label: 'История' },
  { href: routes.profile, label: 'Профиль' },
];

/** Имя файла текущей страницы: «account.html». */
const currentPage = () => window.location.pathname.split('/').pop();

function links(itemClass) {
  const page = currentPage();
  return ITEMS.map((item) =>
    `<a class="${itemClass}" href="${item.href}"${item.href === page ? ' aria-current="page"' : ''}>${item.label}</a>`,
  ).join('');
}

class CabinetNav extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = 'true';

    // Колонка слева: планшет и компьютер
    this.innerHTML = `
      <nav class="cabinet-nav" aria-label="Личный кабинет">
        ${links('cabinet-nav__item')}
        <button class="cabinet-nav__item cabinet-nav__logout" type="button" data-logout>Выйти</button>
        <p class="cabinet-nav__error" role="alert" data-logout-error hidden></p>
      </nav>`;

    // Панель внизу экрана: телефон
    this.tabbar = document.createElement('nav');
    this.tabbar.className = 'tabbar';
    this.tabbar.setAttribute('aria-label', 'Личный кабинет');
    this.tabbar.innerHTML = `
      ${links('tabbar__item')}
      <button class="tabbar__item" type="button" data-logout>Выйти</button>
      <p class="tabbar__error" role="alert" data-logout-error hidden></p>`;
    document.body.append(this.tabbar);

    const buttons = [...this.querySelectorAll('[data-logout]'), ...this.tabbar.querySelectorAll('[data-logout]')];
    const errors = [...this.querySelectorAll('[data-logout-error]'), ...this.tabbar.querySelectorAll('[data-logout-error]')];
    for (const button of buttons) {
      button.addEventListener('click', async () => {
        buttons.forEach((b) => { b.disabled = true; });
        errors.forEach((e) => { e.hidden = true; });
        try {
          await api.logout();
          window.location.assign(routes.home);
        } catch (error) {
          errors.forEach((e) => {
            e.textContent = `Не удалось выйти. ${error.message}`;
            e.hidden = false;
          });
          buttons.forEach((b) => { b.disabled = false; });
        }
      });
    }
  }

  disconnectedCallback() {
    this.tabbar?.remove();
    delete this.dataset.ready;
  }
}

customElements.define('cabinet-nav', CabinetNav);
