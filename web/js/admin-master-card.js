// A-22 Карточка мастера (docs/ui-map.md, «Раздел администратора»): /admin/masters/form — новый мастер,
// ?id=3 — изменение. Имя, специализация, опыт, рассказ; уровень «Мастер / Топ-мастер»; отметки услуг, которые
// он выполняет (цена — по уровню); недельный график с формой «Новый график с даты» (A-22p); «Активен»; «Удалить».
// Данные: GET /api/admin/masters, GET /api/admin/services, GET /api/studio (часовой пояс).
// Кнопки: «Сохранить» — POST /api/admin/masters или PATCH /api/admin/masters/:id (при отключении в ответе —
// предстоящие записи мастера); «Удалить» — DELETE /api/admin/masters/:id: удалить или только отключить, решает сервер;
// «Сохранить график» — PUT /api/admin/masters/:id/schedule, сначала с dryRun: true, чтобы показать записи,
// которые в новый график не попадают.
// Блок «Учетная запись»: вход мастера и доступ к нему — PUT и DELETE /api/admin/users/:id/block
// (паспорт, функция 1 администратора). Номер пользователя берется из `account.userId` мастера.
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

// Блок «Учетная запись»: доступ мастера к разделу /master закрывает и открывает администратор
const accountPanel = /** @type {HTMLElement} */ (form.querySelector('[data-account-panel]'));
const accountText = /** @type {HTMLElement} */ (form.querySelector('[data-account-text]'));
const accountAlert = /** @type {HTMLElement} */ (form.querySelector('[data-account-alert]'));
const accountActions = /** @type {HTMLElement} */ (form.querySelector('[data-account-actions]'));
const blockButton = /** @type {HTMLButtonElement} */ (form.querySelector('[data-account-block]'));
const unblockButton = /** @type {HTMLButtonElement} */ (form.querySelector('[data-account-unblock]'));

const idParam = new URLSearchParams(window.location.search).get('id');
const masterId = idParam && /^\d+$/.test(idParam) ? Number(idParam) : null;
/** Мастер, каким его отдал сервер; null — новый. */
let master = null;
let catalog = { categories: [], services: [] };
let timezone = 'Europe/Moscow';
/** Режим работы студии по дням недели: в закрытый день график мастеру не задать. */
let studioHours = [];

const level = () => /** @type {HTMLInputElement | null} */ (form.querySelector('input[name="level"]:checked'))?.value ?? 'master';

function showStatus() {
  statusSlot.innerHTML = master
    ? `<span class="admin-badge admin-badge--${master.isActive ? 'on' : 'off'}">${master.isActive ? 'Активен' : 'Отключен'}</span>`
    : '';
}

/**
 * Учетная запись мастера: есть ли она и закрыт ли доступ. Доступ и «Активен» — разные вещи:
 * отключенный мастер пропадает у клиентов, но в свое расписание входит, а закрытый доступ рвет его сессии
 * и не пускает в сервис, при этом в записях и в расписании он остается.
 */
function showAccount() {
  accountPanel.hidden = !master;
  if (!master) return;
  const account = master.account ?? null;
  if (!account) {
    accountText.textContent = 'Учетной записи нет: мастер не может войти и посмотреть свое расписание. '
      + 'Ее заводит администратор — пока только запросом к API.';
    accountActions.hidden = true;
    return;
  }
  const login = [account.email, account.phone].filter(Boolean).join(' · ');
  accountText.textContent = account.isBlocked
    ? `Вход: ${login}. Доступ закрыт — мастер в сервис не войдет, в записях и расписании он остается.`
    : `Вход: ${login}. Доступ открыт — мастер видит свое расписание и подает заявки.`;
  accountActions.hidden = false;
  blockButton.hidden = account.isBlocked;
  unblockButton.hidden = !account.isBlocked;
}

/** Закрыть или открыть доступ к учетной записи мастера и перечитать карточку. */
async function setAccess(button, blocked) {
  const done = setBusy(button, blocked ? 'Закрываем…' : 'Открываем…');
  accountAlert.hidden = true;
  try {
    const userId = master.account.userId;
    if (blocked) await api.blockUser(userId);
    else await api.unblockUser(userId);
    const masters = await api.getAdminMasters();
    master = masters.find((m) => m.id === master.id) ?? master;
    done();
    showAccount();
    showAlert(accountAlert, 'success', blocked
      ? `Доступ закрыт: ${master.name} больше не сможет войти, пока вы не откроете доступ. Сессии этой учетной записи уже закрыты.`
      : `Доступ открыт: ${master.name} снова может войти прежним паролем.`);
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showAlert(accountAlert, 'error', error instanceof api.ApiError
      ? error.message
      : 'Не удалось изменить доступ. Попробуйте еще раз.');
  }
}

blockButton.addEventListener('click', () => setAccess(blockButton, true));
unblockButton.addEventListener('click', () => setAccess(unblockButton, false));

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
  /** @type {HTMLElement} */ (form.querySelector('[data-schedule-actions]')).hidden = !master;
  showStatus();
  showAccount();
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

// ---------------------------------------------------------------------------
// A-22p Новый график с даты
// ---------------------------------------------------------------------------

const scheduleBox = /** @type {HTMLElement} */ (form.querySelector('[data-schedule-form]'));
const scheduleActions = /** @type {HTMLElement} */ (form.querySelector('[data-schedule-actions]'));
const scheduleAlert = /** @type {HTMLElement} */ (form.querySelector('[data-schedule-alert]'));
const scheduleDays = /** @type {HTMLElement} */ (form.querySelector('[data-schedule-days]'));
const scheduleAffected = /** @type {HTMLElement} */ (form.querySelector('[data-schedule-affected]'));
const scheduleSave = /** @type {HTMLButtonElement} */ (form.querySelector('[data-schedule-save]'));

const WEEKDAY_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Показаны ли записи, которые не попадают в новый график: второе нажатие сохраняет график вместе с ними. */
let affectedConfirmed = false;

/** Действующий (последний) период графика мастера: его дни и часы подставляются в форму. */
function currentPeriod() {
  const rows = master?.schedule ?? [];
  if (!rows.length) return null;
  const validFrom = rows.map((r) => r.validFrom).sort().at(-1);
  const days = rows.filter((r) => r.validFrom === validFrom);
  return { weekdays: days.map((d) => d.weekday), start: days[0].start, end: days[0].end };
}

/** Флажки дней недели. День, в который студия закрыта, выбрать нельзя: слотов в нем все равно не будет. */
function renderWeekdays(checked) {
  const open = new Set(studioHours.map((h) => h.weekday));
  scheduleDays.innerHTML = [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const isOpen = open.has(weekday);
    const mark = checked.includes(weekday) && isOpen ? ' checked' : '';
    return `<label class="admin-weekday${isOpen ? '' : ' is-off'}">
      <input type="checkbox" name="scheduleWeekday" value="${weekday}"${mark}${isOpen ? '' : ' disabled'}>
      <span>${WEEKDAY_SHORT[weekday]}</span>
    </label>`;
  }).join('');
  const closed = [1, 2, 3, 4, 5, 6, 7].filter((d) => !open.has(d)).map((d) => WEEKDAY_SHORT[d]);
  /** @type {HTMLElement} */ (form.querySelector('[data-schedule-studio]')).textContent = closed.length
    ? `Студия закрыта: ${closed.join(', ')} — эти дни выбрать нельзя. Режим работы студии меняется отдельно.`
    : 'Студия работает все дни недели.';
}

const checkedWeekdays = () => [...form.querySelectorAll('input[name="scheduleWeekday"]:checked')]
  .map((i) => Number(/** @type {HTMLInputElement} */ (i).value));

function openScheduleForm() {
  const period = currentPeriod();
  const today = studioToday(timezone);
  // По прототипу новый график начинается с завтрашнего дня: сегодняшние слоты клиенты уже видели.
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  field('scheduleFrom').value = tomorrow.toISOString().slice(0, 10);
  field('scheduleFrom').min = today;
  field('scheduleStart').value = period?.start ?? studioHours[0]?.open ?? '10:00';
  field('scheduleEnd').value = period?.end ?? studioHours[0]?.close ?? '20:00';
  renderWeekdays(period?.weekdays ?? []);

  affectedConfirmed = false;
  scheduleAffected.hidden = true;
  scheduleAffected.replaceChildren();
  scheduleSave.textContent = 'Сохранить график';
  scheduleAlert.hidden = true;
  scheduleActions.hidden = true;
  scheduleBox.hidden = false;
  field('scheduleFrom').focus();
}

function closeScheduleForm() {
  clearErrors(form, scheduleAlert);
  scheduleBox.hidden = true;
  scheduleActions.hidden = false;
}

/** Записи, которые в новый график не попадают: сервер их не трогает, разбирает администратор. */
function showAffected(bookings) {
  const intro = document.createElement('p');
  intro.className = 'admin-panel__hint';
  intro.textContent = `В новый график не попадают записи (${bookings.length}). Сами они не отменяются — перенесите или отмените их в разделе «Записи». Если график все равно нужен, нажмите «Сохранить всё равно»:`;
  const list = document.createElement('ul');
  list.className = 'admin-list';
  for (const b of bookings) {
    const item = document.createElement('li');
    item.textContent = `${dateLabel(b.startsAt, timezone)}, ${timeLabel(b.startsAt, timezone)} · ${b.client?.name ?? ''} · ${b.items.map((i) => i.name).join(', ')}`;
    list.append(item);
  }
  scheduleAffected.replaceChildren(intro, list);
  scheduleAffected.hidden = false;
  scheduleSave.textContent = 'Сохранить всё равно';
  affectedConfirmed = true;
}

/** Проверка до отправки — для удобства; настоящая проверка на сервере. */
function validateSchedule(validFrom, days, start, end) {
  const today = studioToday(timezone);
  return showErrors(form, {
    scheduleFrom: !validFrom ? 'Укажите дату' : validFrom < today ? 'График может начаться не раньше сегодняшнего дня' : null,
    scheduleDays: days.length ? null : 'Отметьте хотя бы один рабочий день',
    scheduleStart: start ? null : 'Укажите начало смены',
    scheduleEnd: !end ? 'Укажите конец смены' : start && end <= start ? 'Конец смены должен быть позже начала' : null,
  });
}

/** @type {HTMLButtonElement} */ (form.querySelector('[data-schedule-open]')).addEventListener('click', openScheduleForm);
/** @type {HTMLButtonElement} */ (form.querySelector('[data-schedule-cancel]')).addEventListener('click', closeScheduleForm);

scheduleSave.addEventListener('click', async () => {
  clearErrors(form, scheduleAlert);
  const validFrom = field('scheduleFrom').value;
  const start = field('scheduleStart').value;
  const end = field('scheduleEnd').value;
  const weekdays = checkedWeekdays();
  if (!validateSchedule(validFrom, weekdays, start, end)) return;

  // Часы у всех выбранных дней одинаковые: API принимает их для каждого дня отдельно (docs/ui-map.md, A-22p).
  const days = weekdays.map((weekday) => ({ weekday, start, end }));
  const done = setBusy(scheduleSave, affectedConfirmed ? 'Сохраняем…' : 'Проверяем…');
  try {
    // Сначала предпросмотр: показываем записи, которые выпадают из нового графика, и только потом сохраняем.
    if (!affectedConfirmed) {
      const preview = await api.setMasterSchedule(master.id, { validFrom, days, dryRun: true });
      if (preview.affectedBookings?.length) {
        done();
        showAffected(preview.affectedBookings);
        return;
      }
    }
    const saved = await api.setMasterSchedule(master.id, { validFrom, days });
    master = saved.master;
    done();
    renderSchedule(studioToday(timezone));
    closeScheduleForm();
    showAlert(alert, 'success', `График с ${dateLabel(validFrom + 'T12:00:00Z', timezone)} сохранен. Прежний действует по день накануне.`);
  } catch (error) {
    done();
    if (handleAccessError(error)) return;
    showServerError(form, scheduleAlert, error);
  }
});

clearOnInput(form);

async function load() {
  try {
    const [studio, masters, services] = await Promise.all([api.getStudio(), api.getAdminMasters(), api.getAdminServices()]);
    timezone = studio.timezone;
    studioHours = studio.hours ?? [];
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
