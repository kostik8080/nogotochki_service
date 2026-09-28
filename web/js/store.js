// Черновик записи: что клиент выбрал на шагах записи (BOOK-01…BOOK-04). Все шаги читают и пишут его
// только через этот файл.
//
// Где хранится — решение из docs/ui-map.md (список 1, пункт 6): в sessionStorage вкладки. Выбор переживает
// переход между страницами и перезагрузку, но не выходит за пределы вкладки и исчезает, когда ее закрывают.
// Здесь нет ничего секретного: только номера услуг и мастера, время и комментарий. Цены и длительность
// в черновике не хранятся — их каждый раз считает сервер.
//
// Если хранилище недоступно (приватный режим, запрет в браузере), черновик живет в памяти страницы:
// запись работает, но выбор не переживет переход на другую страницу.

const KEY = 'nog_booking_draft';

/**
 * @typedef {{ serviceId: number, quantity: number }} DraftItem
 * @typedef {{
 *   items: DraftItem[],          // услуги визита по порядку выбора; quantity > 1 — у опции вроде «Дизайн ногтей»
 *   masterId: number | null,     // выбранный мастер; null — не выбран или «Любой свободный мастер»
 *   anyMaster: boolean,          // выбран «Любой свободный мастер»
 *   lockedMasterId: number | null, // мастер закреплен заранее: «Записаться к мастеру» — шаг «Мастер» пропускается
 *   startsAt: string | null,     // выбранное время, UTC (шаг «Время»)
 *   comment: string,             // комментарий мастеру (шаг «Подтверждение»)
 * }} Draft
 */

/** @returns {Draft} */
const empty = () => ({ items: [], masterId: null, anyMaster: false, lockedMasterId: null, startsAt: null, comment: '' });

let memory = empty();

function read() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return empty();
    const data = JSON.parse(raw);
    // Старый или испорченный черновик не должен ломать страницу: берем только понятные поля
    return {
      ...empty(),
      items: Array.isArray(data.items)
        ? data.items.filter((i) => Number.isInteger(i?.serviceId) && Number.isInteger(i?.quantity) && i.quantity > 0)
        : [],
      masterId: Number.isInteger(data.masterId) ? data.masterId : null,
      anyMaster: data.anyMaster === true,
      lockedMasterId: Number.isInteger(data.lockedMasterId) ? data.lockedMasterId : null,
      startsAt: typeof data.startsAt === 'string' ? data.startsAt : null,
      comment: typeof data.comment === 'string' ? data.comment : '',
    };
  } catch {
    return memory;
  }
}

function write(draft) {
  memory = draft;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Хранилище недоступно — остается копия в памяти
  }
}

/** Текущий черновик. */
export const getDraft = () => read();

/**
 * Изменить черновик. Смена услуг сбрасывает время: под другой состав визита оно могло не подойти.
 * @param {Partial<Draft>} patch
 */
export function updateDraft(patch) {
  const current = read();
  const next = { ...current, ...patch };
  if (patch.items && servicesParam(patch.items) !== servicesParam(current.items)) next.startsAt = null;
  write(next);
  return next;
}

/** Начать запись заново: с услугой или закрепленным мастером (ссылки с лендинга и из кабинета). */
export function startDraft(patch = {}) {
  write({ ...empty(), ...patch });
  return read();
}

/** Забыть черновик: клиент вышел из записи или запись создана. */
export function clearDraft() {
  memory = empty();
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // нечего удалять
  }
}

/** Услуги в формате API: [{1,1},{3,2}] → «1,3:2». */
export const servicesParam = (items) =>
  items.map((i) => (i.quantity > 1 ? `${i.serviceId}:${i.quantity}` : String(i.serviceId))).join(',');

/** Обратно: «1,3:2» → [{1,1},{3,2}]. Неверные части пропускаются. */
export function parseServicesParam(value) {
  if (!value) return [];
  return value.split(',').map((part) => /^(\d{1,9})(?::(\d{1,3}))?$/.exec(part.trim())).filter(Boolean)
    .map((m) => ({ serviceId: Number(m[1]), quantity: m[2] ? Number(m[2]) : 1 }))
    .filter((i) => i.serviceId > 0 && i.quantity > 0);
}
