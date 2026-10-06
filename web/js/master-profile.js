// PUB-05 Профиль мастера (docs/ui-map.md): кто это, что делает, сколько стоит у него визит и его работы.
// Сюда ведут «Подробнее» с лендинга и с шага выбора мастера, имя мастера в карточке записи и подпись
// под фото в галерее.
//
// Данные: GET /api/masters/:id — уровень, специализация, опыт, рассказ и услуги, у которых `priceKop`
// уже посчитан по уровню мастера (сервер не отдает обе цены, и выбирать здесь нечего);
// GET /api/gallery?masterId=:id — опубликованные работы этого мастера.
// 404 — «Мастер не найден»: такого номера нет или мастера отключили.
//
// Плашки «в отпуске до …» из прототипа здесь нет: блокировки видит только администратор, а отпуск и так
// виден клиенту — в эти дни у мастера нет свободного времени (docs/ui-map.md, список 1, пункт 2).
import * as api from './api.js';
import { duration, escapeHtml as esc, initials, money } from './format.js';
import { routes } from './routes.js';
import { getDraft, servicesParam } from './store.js';

const $ = (selector) => /** @type {HTMLElement} */ (document.querySelector(selector));

const views = {
  loading: $('[data-view="loading"]'),
  content: $('[data-view="content"]'),
  error: $('[data-view="error"]'),
};

const LEVEL = { master: 'Мастер', top_master: 'Топ-мастер' };

const idParam = new URLSearchParams(window.location.search).get('id');
const masterId = idParam && /^\d+$/.test(idParam) ? Number(idParam) : null;

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function showError(title, text) {
  $('[data-error-title]').textContent = title;
  $('[data-error-text]').textContent = text;
  show('error');
}

/** Опыт словами: 1 год, 2 года, 7 лет. */
function years(n) {
  const last = n % 10, two = n % 100;
  if (two >= 11 && two <= 14) return `${n} лет опыта`;
  if (last === 1) return `${n} год опыта`;
  if (last >= 2 && last <= 4) return `${n} года опыта`;
  return `${n} лет опыта`;
}

/**
 * Куда ведет «Записаться к мастеру». Если человек уже набрал услуги и зашел сюда посмотреть мастера,
 * возвращаем его сразу к выбору времени с этим мастером; если нет — на первый шаг с закрепленным мастером.
 */
function bookHref(id) {
  const draft = getDraft();
  return draft.items.length
    ? routes.bookingTime({ services: servicesParam(draft.items), master: id })
    : routes.booking({ master: id });
}

/** «← Назад» возвращает туда, откуда пришли: с шага выбора мастера — на него, иначе к мастерам на лендинге. */
function setBack() {
  const from = document.referrer;
  if (!from) return;
  try {
    const url = new URL(from);
    if (url.origin === window.location.origin && url.pathname.endsWith('/booking-master.html')) {
      const link = /** @type {HTMLAnchorElement} */ ($('[data-back]'));
      link.href = url.pathname.replace(/^\//, '') + url.search;
      link.textContent = '← К выбору мастера';
    }
  } catch {
    // Чужой или испорченный адрес — остается ссылка на лендинг
  }
}

function renderMaster(master) {
  document.title = `${master.name} — Ноготочки`;

  $('[data-photo]').innerHTML = master.photoUrl
    ? `<img src="${esc(master.photoUrl)}" alt="${esc(master.name)}">`
    : `<span class="avatar" aria-hidden="true">${esc(initials(master.name))}</span>`;
  $('[data-name]').textContent = master.name;
  $('[data-meta]').textContent = [
    LEVEL[master.level] ?? master.level,
    master.specialty,
    master.experienceYears ? years(master.experienceYears) : null,
  ].filter(Boolean).join(' · ');

  const bio = $('[data-bio]');
  bio.textContent = master.bio ?? '';
  bio.hidden = !master.bio;

  /** @type {HTMLAnchorElement} */ ($('[data-book]')).href = bookHref(master.id);

  const services = master.services ?? [];
  $('[data-services]').innerHTML = services.length
    ? services.map((s) => `
      <div class="master-service">
        <span>
          <span class="master-service__name">${esc(s.name)}</span>
          <span class="master-service__duration">${esc(duration(s.durationMin))}${s.kind === 'addon' ? ' · дополнение к визиту' : ''}</span>
        </span>
        <span class="master-service__price">${esc(money(s.priceKop))}${s.priceUnit ? ` <span class="master-service__unit">${esc(s.priceUnit)}</span>` : ''}</span>
      </div>`).join('')
    : '<p class="empty-note">У мастера пока не отмечено ни одной услуги.</p>';
}

function renderWorks(photos, masterName) {
  const box = $('[data-works]');
  if (!photos.length) {
    box.innerHTML = '<p class="empty-note">Работы этого мастера скоро появятся.</p>';
    return;
  }
  box.innerHTML = photos.map((p) => {
    const title = p.title || p.service?.name || 'Работа мастера';
    return `
      <span class="work">
        <img src="${esc(p.url)}" alt="${esc(`${title} — ${masterName}`)}" loading="lazy">
        <span class="work__caption"><span class="work__title">${esc(title)}</span></span>
      </span>`;
  }).join('');
  // Файл не загрузился — остается полосатая заглушка вместо значка битой картинки (как на лендинге)
  box.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

async function load() {
  if (masterId === null) {
    showError('Мастер не найден', 'В адресе страницы нет номера мастера. Откройте профиль из списка мастеров.');
    return;
  }
  try {
    const { master } = await api.getMaster(masterId);
    renderMaster(master);
    show('content');
    // Работы — необязательная часть: без них профиль все равно показывается
    try {
      const { photos } = await api.getGallery({ masterId: master.id });
      renderWorks(photos, master.name);
    } catch {
      $('[data-works]').innerHTML = '<p class="empty-note">Не удалось загрузить работы мастера.</p>';
    }
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 404) {
      showError('Мастер не найден', 'Возможно, мастер больше не принимает в студии.');
      return;
    }
    // Ошибку от API показываем текстом на экране (docs/frontend-rules.md, правило 7)
    showError('Не удалось открыть профиль', error instanceof api.ApiError ? error.message : 'Обновите страницу или попробуйте позже.');
  }
}

setBack();
load();
