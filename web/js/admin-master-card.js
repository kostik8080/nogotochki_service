// A-22 Карточка мастера (docs/ui-map.md, «Раздел администратора»): /admin/masters/form — новый мастер,
// ?id=3 — изменение. Имя, специализация, опыт, рассказ; уровень «Мастер / Топ-мастер»; отметки услуг, которые
// он выполняет (цена — по уровню); недельный график — только просмотр; «Активен»; «Удалить».
// Данные: GET /api/admin/masters, GET /api/admin/services, GET /api/studio (часовой пояс).
// Кнопки: «Сохранить» — POST /api/admin/masters или PATCH /api/admin/masters/:id (при отключении в ответе —
// предстоящие записи мастера); «Удалить» — DELETE /api/admin/masters/:id: удалить или только отключить, решает сервер.
// Клиентский выбор мастера (BOOK-02) показывает только активных мастеров, у которых отмечены все услуги визита.
import { adminReady, handleAccessError, schedulePeriods, setFlash, studioToday } from './admin.js';
import * as api from './api.js';
import { clearErrors, clearOnInput, setBusy, showAlert, showErrors, showServerError } from './form.js';
import { dateLabel, duration, escapeHtml as esc, money, timeLabel } from './format.js';
import { routes } from './routes.js';

const form = /** @type {HTMLFormElement} */ (document.querySelector('[data-form]'));
const alert = /** @type {HTMLElement} */ (form.querySelector('[data-alert]'));
const loading = /** @type {HTMLElement} */ (document.querySelector('[data-page-loading]'));
const pageError = /** @type {HTMLElement} */ (document.querySelector('[data-page-error]'));
const title = /** @type {HTMLElement} */ (document.querySelector('[data-title]'));
const statusSlot = /** @type {HTMLElement} */ (document.querySelector('[data-status]'));
const servicesSlot = /** @type {HTMLElement} */ (form.querySelector('[data-services]'));
const deleteButton = /** @type {HTMLButtonElement} */ (form.querySelector('[data-delete]'));
const field = (name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name));

const idParam = new URLSearchParams(window.location.search).get('id');
const masterId = idParam && /^\d+$/.test(idParam) ? Number(idParam) : null;
/** Мастер, каким его отдал сервер; null — новый. */
let master = null;
let catalog = { categories: [], services: [] };
let timezone = 'Europe/Moscow';

const level = () => /** @type {HTMLInputElement | null} */ (form.querySelector('input[name="level"]:checked'))?.value ?? 'master';

function showStatus() {
  statusSlot.innerHTML = master
    ? `<span class="admin-badge admin-badge--${master.isActive ? 'on' : 'off'}">${master.isActive ? 'Активен' : 'Отключен'}</span>`
    : '';
}

/** Отметки услуг по категориям; цена — по выбранному уровню. Отмеченные сохраняются при перерисовке. */
function renderServices() {
  const checked = new Set([...form.querySelectorAll('input[name="serviceIds"]:checked')]
    .map((i) => Number(/** @type {HTMLInputElement} */ (i).value)));
  if (!servicesSlot.dataset.ready) {
    (master?.serviceIds ?? []).forEach((id) => checked.add(id));
    servicesSlot.dataset.ready = 'true';
  }
  const top = level() === 'top_master';
  if (!catalog.services.length) {
    servicesSlot.innerHTML = '<p class="admin-panel__hint">Услуг пока нет — добавьте их в разделе «Услуги».</p>';
    return;
  }
  servicesSlot.innerHTML = catalog.categories.map((category) => {
    const services = catalog.services.filter((s) => s.categoryId === category.id);
    if (!services.length) return '';
    return `<p class="admin-checks__group">${esc(category.name)}</p>` + services.map((s) => `
      <label class="check__label">
        <input type="checkbox" name="serviceIds" value="${s.id}"${checked.has(s.id) ? ' checked' : ''}>
        <span class="admin-checks__text">
          ${esc(s.name)}
          <span class="admin-checks__meta">${esc(duration(s.durationMin))} · ${esc(money(top ? s.priceTopKop : s.priceMasterKop))}</span>
          ${s.isActive ? '' : '<span class="admin-badge admin-badge--off">Отключена</span>'}
        </span>
      </label>`).join('');
  }).join('');
}

function renderSchedule(today) {
  const slot = /** @type {HTMLElement} */ (form.querySelector('[data-schedule]'));
  const periods = master ? schedulePeriods(master.schedule, today) : [];
  if (!periods.length) {
    slot.innerHTML = '<p class="admin-panel__hint">График не задан. Пока его нет, клиенты не увидят у мастера свободного времени.</p>';
    return;
  }
  slot.innerHTML = `<dl class="admin-schedule">${periods.map((p) => `
    <dt>${p.current ? 'Сейчас' : `С ${esc(dateLabel(p.from + 'T12:00:00Z', timezone))}`}</dt>
    <dd>${esc(p.days)} · ${esc(p.hours)}</dd>`).join('')}</dl>`;
}

/** Предстоящие записи отключенного мастера: их нужно перенести или отменить в разделе «Записи». */
function showUpcoming(message, bookings) {
  const box = document.createElement('div');
  box.append(message);
  if (bookings?.length) {
    const intro = document.createElement('p');
    intro.textContent = 'Предстоящие записи мастера не отменяются сами — перенесите или отмените их:';
    const list = document.createElement('ul');
    list.className = 'admin-list';
    for (const b of bookings) {
      const item = document.createElement('li');
      item.textContent = `${dateLabel(b.startsAt, timezone)}, ${timeLabel(b.startsAt, timezone)} · ${b.client?.name ?? ''} · ${b.items.map((i) => i.name).join(', ')}`;
      list.append(item);
    }
    box.append(intro, list);
  }
  showAlert(alert, 'warning', box);
  alert.scrollIntoView({ block: 'nearest' });
}

function fill(today) {
  if (master) {
    title.textContent = master.name;
    document.title = `${master.name} — раздел администратора — Ноготочки`;
    field('name').value = master.name;
    field('specialty').value = master.specialty ?? '';
    field('experienceYears').value = master.experienceYears === null ? '' : String(master.experienceYears);
    field('bio').value = master.bio ?? '';
    field('isActive').checked = master.isActive;
    deleteButton.hidden = false;
  } else {
    title.textContent = 'Новый мастер';
    document.title = 'Новый мастер — раздел администратора — Ноготочки';
    field('isActive').checked = true;
  }
  const levelInput = /** @type {HTMLInputElement} */ (form.querySelector(`input[name="level"][value="${master?.level ?? 'master'}"]`));
  levelInput.checked = true;
  renderServices();
  renderSchedule(today);
  showStatus();
}

function values() {
  const text = (name) => field(name).value.trim() || null;
  const experience = field('experienceYears').value.trim();
  return {
    name: field('name').value.trim(),
    specialty: text('specialty'),
    experienceYears: experience === '' ? null : Number(experience),
    bio: text('bio'),
    level: level(),
    serviceIds: [...form.querySelectorAll('input[name="serviceIds"]:checked')].map((i) => Number(/** @type {HTMLInputElement} */ (i).value)),
    isActive: field('isActive').checked,
  };
}

function validate(v) {
  return showErrors(form, {
    name: v.name ? null : 'Введите имя мастера',
    experienceYears: v.experienceYears === null || (Number.isInteger(v.experienceYears) && v.experienceYears >= 0 && v.experienceYears <= 80)
      ? null : 'Опыт — целое число лет от 0 до 80',
  });
}

form.addEventListener('change', (event) => {
  if (/** @type {HTMLInputElement} */ (event.target).name === 'level') renderServices();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors(form, alert);
  const v = values();
  if (!validate(v)) return;
  const done = setBusy(/** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]')), 'Сохраняем…');
  try {
    if (!master) {
      await api.createMaster(v);
      setFlash('success', `Мастер «${v.name}» добавлен. Чтобы клиенты увидели у него свободное время, нужен график работы.`);
      window.location.assign(routes.adminMasters);
      return;
    }
    const wasActive = master.isActive;
    const answer = await api.updateMaster(master.id, v);
    master = answer.master;
    if (wasActive && !master.isActive && answer.upcomingBookings?.length) {
      // Отключили мастера с предстоящими записями: остаемся здесь и показываем, что с ними сделать
      done();
      showStatus();
      showUpcoming(`Мастер «${master.name}» отключен: клиенты больше не увидят его при записи.`, answer.upcomingBookings);
      return;
    }
    setFlash('success', `Мастер «${master.name}» сохранен`);
    window.location.assign(routes.adminMasters);
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(form, alert, error);
  }
});

deleteButton.addEventListener('click', async () => {
  if (!master) return;
  if (!window.confirm(`Удалить мастера «${master.name}»?\n\nЕсли у него есть записи, сервер не удалит его, а отключит.`)) return;
  clearErrors(form, alert);
  const done = setBusy(deleteButton, 'Удаляем…');
  try {
    const answer = await api.deleteMaster(master.id);
    if (answer.result === 'deleted') {
      setFlash('success', `Мастер «${master.name}» удален`);
      window.location.assign(routes.adminMasters);
      return;
    }
    // Есть записи, фото, заметки или учетная запись: мастер только отключен — объясняем и показываем его записи
    master = answer.master;
    field('isActive').checked = false;
    showStatus();
    showUpcoming(answer.message, answer.upcomingBookings);
    done();
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(form, alert, error);
  }
});

clearOnInput(form);

async function load() {
  try {
    const [studio, masters, services] = await Promise.all([api.getStudio(), api.getAdminMasters(), api.getAdminServices()]);
    timezone = studio.timezone;
    catalog = services;
    if (masterId !== null) {
      master = masters.find((m) => m.id === masterId) ?? null;
      if (!master) {
        pageError.textContent = 'Мастер не найден. Возможно, его уже удалили.';
        pageError.hidden = false;
        return;
      }
    }
    fill(studioToday(timezone));
    form.hidden = false;
  } catch (error) {
    if (handleAccessError(error)) return;
    pageError.textContent = `Не удалось загрузить мастера. ${error instanceof api.ApiError ? error.message : 'Обновите страницу.'}`;
    pageError.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

if (await adminReady) load();
