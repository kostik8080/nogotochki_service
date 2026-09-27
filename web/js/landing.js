// PUB-01 Лендинг (docs/ui-map.md). Разметка и тексты — в index.html; отсюда приходят данные API:
// услуги, мастера, работы, контакты и режим работы студии, шапка для гостя или клиента.
// Каждый блок грузится сам по себе: пока ждем — заглушка из разметки, ошибка — текст и «Повторить».
import * as api from './api.js';
import { duration, escapeHtml as esc, initials, money, phone, phoneHref, plural } from './format.js';
import { mountAccountMenu } from './header.js';
import { routes } from './routes.js';

const $ = (selector) => document.querySelector(selector);

const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const CLOCK_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

// ---------- Загрузка блока: заглушка → данные или ошибка с «Повторить» ----------

/**
 * @param {HTMLElement} container куда рисуется блок; в разметке в нем уже лежит заглушка
 * @param {() => Promise<unknown>} load запрос к API
 * @param {(data: any) => void} render отрисовка данных
 * @param {string} what что грузим — для текста ошибки: «услуги», «мастеров»…
 */
function loadBlock(container, load, render, what) {
  const placeholder = container.innerHTML;
  const run = async () => {
    container.setAttribute('aria-busy', 'true');
    try {
      render(await load());
    } catch (error) {
      container.innerHTML = `
        <div class="load-error" role="alert">
          <span>Не удалось загрузить ${esc(what)}. ${esc(error.message)}</span>
          <button class="btn btn--small" type="button">Повторить</button>
        </div>`;
      container.querySelector('button').addEventListener('click', () => {
        container.innerHTML = placeholder;
        run();
      });
    } finally {
      container.setAttribute('aria-busy', 'false');
    }
  };
  run();
}

// ---------- Услуги: GET /api/services, на лендинге — только isFeatured ----------

function servicePrice(s) {
  const price = money(s.priceMasterKop);
  if (s.priceUnit) return `${price} ${s.priceUnit}`;
  // Цена зависит от уровня мастера, поэтому в каталоге — «от» меньшей (паспорт, функция 2)
  return s.priceTopKop > s.priceMasterKop ? `от ${price}` : price;
}

function renderServices(catalog) {
  const all = catalog.categories.flatMap((c) => c.services);
  const featured = all.filter((s) => s.isFeatured);
  const list = featured.length ? featured : all;
  const container = $('[data-services]');

  if (!list.length) {
    container.innerHTML = '<p class="empty-note">Скоро здесь появится прайс студии.</p>';
    return;
  }

  container.innerHTML = list.map((s) => {
    const addon = s.kind === 'addon';
    return `
      <article class="card service${addon ? ' service--addon' : ''}">
        ${addon ? '<span class="service__badge">Дополнение</span>' : ''}
        <h3 class="service__name">${esc(s.name)}</h3>
        ${s.description ? `<p class="service__desc">${esc(s.description)}</p>` : ''}
        <p class="service__duration">${CLOCK_ICON}<span>${addon ? '+' : ''}${duration(s.durationMin)}</span></p>
        <div class="service__footer">
          <span class="service__price">${esc(servicePrice(s))}</span>
          <a class="link service__cta" href="${esc(routes.booking({ service: s.id }))}">${addon ? 'Добавить к записи' : 'Записаться'} <span aria-hidden="true">→</span></a>
        </div>
      </article>`;
  }).join('');
}

// ---------- Мастера: GET /api/masters ----------
// Дни работы мастера на карточку не выводятся: публичный API их не отдает (docs/ui-map.md, пункт 1.1).

function renderMasters({ masters }) {
  const container = $('[data-masters]');
  if (!masters.length) {
    container.innerHTML = '<p class="empty-note">Скоро здесь появятся наши мастера.</p>';
    return;
  }

  container.innerHTML = masters.map((m) => {
    const profile = esc(routes.master(m.id));
    const photo = m.photoUrl
      ? `<img src="${esc(m.photoUrl)}" alt="" loading="lazy">`
      : `<span class="avatar" aria-hidden="true">${esc(initials(m.name))}</span>`;
    return `
      <article class="master">
        <a class="master__photo" href="${profile}" tabindex="-1" aria-hidden="true">${photo}</a>
        <div class="master__body">
          <h3><a class="master__name" href="${profile}">${esc(m.name)}</a></h3>
          ${m.specialty ? `<p class="master__specialty">${esc(m.specialty)}</p>` : ''}
          ${m.bio ? `<p class="master__bio">${esc(m.bio)}</p>` : ''}
          <a class="btn btn--outline btn--small" href="${esc(routes.booking({ master: m.id }))}">Записаться к мастеру</a>
        </div>
      </article>`;
  }).join('');
}

// ---------- Галерея: GET /api/gallery, фото — GET /api/photos/:id/file ----------

function renderGallery({ photos }) {
  const container = $('[data-gallery]');
  if (!photos.length) {
    container.innerHTML = '<p class="empty-note">Скоро здесь появятся работы наших мастеров.</p>';
    return;
  }

  container.innerHTML = photos.map((p) => {
    const title = p.title || p.service?.name || 'Работа мастера';
    return `
      <a class="work" href="${esc(routes.master(p.master.id))}" title="Профиль мастера">
        <img src="${esc(p.url)}" alt="${esc(`${title} — ${p.master.name}`)}" loading="lazy">
        <span class="work__caption">
          <span class="work__title">${esc(title)}</span>
          <span class="work__master">${esc(p.master.name)} →</span>
        </span>
      </a>`;
  }).join('');

  // Файл не загрузился — остается полосатая заглушка вместо значка битой картинки
  container.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

// ---------- Студия: GET /api/studio — контакты, режим работы, правило 24 часов ----------

/**
 * Неделя группами подряд идущих дней с одинаковым режимом, начиная с первого рабочего дня
 * после выходного: вт–сб 10:00–20:00, вс–пн выходные. Дни недели — ISO (1 — понедельник).
 */
function weekGroups(hours) {
  const byDay = new Map(hours.map((h) => [h.weekday, h]));
  const key = (day) => {
    const h = byDay.get(day);
    return h ? `${h.open}–${h.close}` : 'closed';
  };
  const prev = (day) => (day === 1 ? 7 : day - 1);
  const start = [1, 2, 3, 4, 5, 6, 7].find((d) => byDay.has(d) && key(prev(d)) !== key(d)) ?? 1;

  const groups = [];
  for (let i = 0; i < 7; i++) {
    const day = ((start - 1 + i) % 7) + 1;
    const last = groups.at(-1);
    if (last && last.key === key(day)) last.days.push(day);
    else groups.push({ key: key(day), days: [day], hours: byDay.get(day) });
  }
  return groups;
}

function daysLabel(days, names) {
  const n = (d) => names[d - 1];
  if (days.length === 1) return n(days[0]);
  if (days.length === 2) return `${n(days[0])}, ${n(days[1])}`;
  return `${n(days[0])} — ${n(days.at(-1))}`;
}

function renderStudio(studio) {
  const groups = weekGroups(studio.hours);
  const open = groups.filter((g) => g.hours);
  const closed = groups.filter((g) => !g.hours);

  // Как нас найти
  const social = [
    studio.vkUrl && `<a class="link" href="${esc(studio.vkUrl)}" target="_blank" rel="noopener">VK</a>`,
    studio.telegramUrl && `<a class="link" href="${esc(studio.telegramUrl)}" target="_blank" rel="noopener">Telegram</a>`,
  ].filter(Boolean);
  $('[data-studio-contacts]').innerHTML = `
    <p class="contacts__address">${esc(studio.address)}</p>
    <a class="contacts__phone" href="${esc(phoneHref(studio.phone))}">${esc(phone(studio.phone))}</a>
    <div class="contacts__actions">
      <a class="btn btn--primary btn--small" href="${esc(phoneHref(studio.phone))}">Позвонить</a>
      ${social.join('')}
    </div>
    ${studio.mapUrl ? `<a class="map-link" href="${esc(studio.mapUrl)}" target="_blank" rel="noopener">Открыть на карте →</a>` : ''}`;

  // Режим работы
  $('[data-studio-hours]').innerHTML = [
    ...open.map((g) => `
      <div class="hours__row">
        <span>${esc(capitalize(daysLabel(g.days, WEEKDAYS)))}</span>
        <span class="hours__time">${esc(g.hours.open)} — ${esc(g.hours.close)}</span>
      </div>`),
    ...closed.map((g) => `
      <div class="hours__row hours__row--closed">
        <span>${esc(capitalize(daysLabel(g.days, WEEKDAYS)))}</span>
        <span class="hours__time">${g.days.length > 1 ? 'Выходные' : 'Выходной'}</span>
      </div>`),
  ].join('');

  // Подвал
  const mapAddress = studio.mapUrl
    ? `<a href="${esc(studio.mapUrl)}" target="_blank" rel="noopener">${esc(studio.address)}</a>`
    : esc(studio.address);
  const shortHours = open
    .map((g) => `${daysLabel(g.days, WEEKDAYS_SHORT).replace(' — ', '–')}, ${g.hours.open}–${g.hours.close}`)
    .join('; ');
  $('[data-footer-contacts]').innerHTML = `
    <li>${mapAddress}</li>
    <li><a href="${esc(phoneHref(studio.phone))}">${esc(phone(studio.phone))}</a></li>
    ${shortHours ? `<li>${esc(shortHours)}</li>` : ''}`;

  const footerSocial = [
    studio.vkUrl && `<li><a href="${esc(studio.vkUrl)}" target="_blank" rel="noopener">VK</a></li>`,
    studio.telegramUrl && `<li><a href="${esc(studio.telegramUrl)}" target="_blank" rel="noopener">Telegram</a></li>`,
  ].filter(Boolean);
  $('[data-footer-social]').innerHTML = footerSocial.join('');
  // Ссылок на соцсети в настройках нет — колонку «Соцсети» не показываем
  $('[data-footer-social-block]').hidden = !footerSocial.length;

  // Правило 24 часов: срок задает студия в настройках
  const deadline = studio.rules.clientChangeDeadlineHours;
  $('[data-change-deadline]').textContent =
    deadline === 24 ? 'за сутки' : `за ${deadline} ${plural(deadline, 'час', 'часа', 'часов')}`;
}

function renderStudioError(error) {
  const retry = () => {
    $('[data-studio-contacts]').innerHTML = contactsPlaceholder;
    $('[data-studio-hours]').innerHTML = hoursPlaceholder;
    loadStudio();
  };
  $('[data-studio-contacts]').innerHTML = `
    <div class="load-error" role="alert">
      <span>Не удалось загрузить контакты студии. ${esc(error.message)}</span>
      <button class="btn btn--small" type="button">Повторить</button>
    </div>`;
  $('[data-studio-contacts] button').addEventListener('click', retry);
  $('[data-studio-hours]').innerHTML = '';
  $('[data-footer-contacts]').innerHTML = '';
  $('[data-footer-social-block]').hidden = true;
}

const contactsPlaceholder = $('[data-studio-contacts]').innerHTML;
const hoursPlaceholder = $('[data-studio-hours]').innerHTML;

async function loadStudio() {
  const block = $('[data-contacts]');
  block.setAttribute('aria-busy', 'true');
  try {
    renderStudio(await api.getStudio());
  } catch (error) {
    renderStudioError(error);
  } finally {
    block.setAttribute('aria-busy', 'false');
  }
}

// ---------- Шапка: гость или клиент (GET /api/auth/me) ----------

function renderAuth(user) {
  const header = $('[data-auth]');
  const nav = $('[data-nav-auth]');

  if (!user) {
    header.innerHTML = `
      <a class="header-auth__login" href="${routes.login}">Войти</a>
      <a class="btn btn--primary btn--small" href="${routes.register}">Регистрация</a>`;
    nav.innerHTML = `
      <a href="${routes.login}">Войти</a>
      <a class="btn btn--primary" href="${routes.register}">Регистрация</a>`;
    return;
  }

  // Меню аккаунта в шапке — общее с шапкой остальных страниц (header.js). После выхода лендинг остается открытым (N-11)
  mountAccountMenu(header, user, { onLoggedOut: () => renderAuth(null) });

  // На телефоне вход и меню клиента — в выпадающей панели разделов
  const links = user.role === 'client'
    ? [{ href: routes.account, label: 'Мои записи' }, { href: routes.profile, label: 'Профиль' }]
    : [];
  nav.innerHTML = `
    <span class="site-nav__user">${esc(user.name)}</span>
    ${links.map((l) => `<a href="${l.href}">${l.label}</a>`).join('')}
    <button class="site-nav__logout" type="button" data-logout>Выйти</button>
    <p class="account-menu__error" role="alert" data-logout-error hidden></p>`;

  const navLogout = /** @type {HTMLButtonElement} */ (nav.querySelector('[data-logout]'));
  navLogout.addEventListener('click', async () => {
    navLogout.disabled = true;
    try {
      await api.logout();
      renderAuth(null);
    } catch (error) {
      const box = /** @type {HTMLElement} */ (nav.querySelector('[data-logout-error]'));
      box.textContent = `Не удалось выйти. ${error.message}`;
      box.hidden = false;
      navLogout.disabled = false;
    }
  });
}

async function loadAuth() {
  try {
    renderAuth(await api.getMe());
  } catch {
    // Лендинг публичный: если не удалось узнать, вошел ли человек, показываем вход
    renderAuth(null);
  }
}

// ---------- Шапка: фон при прокрутке, меню на телефоне, отступ под шапку при переходе к якорю ----------

function setupHeader() {
  const header = $('[data-header]');
  const toggle = $('[data-menu-toggle]');
  const nav = $('#site-nav');

  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 40);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Шапка закреплена сверху: блок, к которому ведет меню, не должен уходить под нее
  const syncOffset = () => {
    document.documentElement.style.scrollPaddingTop = header.offsetHeight + 'px';
  };
  new ResizeObserver(syncOffset).observe(header);

  const setMenu = (open) => {
    nav.classList.toggle('is-open', open);
    header.classList.toggle('is-menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setMenu(!nav.classList.contains('is-open')));
  nav.addEventListener('click', (event) => {
    if (event.target.closest('a[href^="#"]')) setMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('is-open')) {
      setMenu(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (nav.classList.contains('is-open') && !header.contains(event.target)) setMenu(false);
  });
}

// ---------- Старт ----------

setupHeader();
loadAuth();
loadStudio();
loadBlock($('[data-services]'), api.getServices, renderServices, 'услуги');
loadBlock($('[data-masters]'), api.getMasters, renderMasters, 'мастеров');
// В прототипе — три работы в ряд; остальные — в профилях мастеров
loadBlock($('[data-gallery]'), () => api.getGallery({ limit: 3 }), renderGallery, 'работы');
