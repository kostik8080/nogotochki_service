// Единый источник моковых данных для прототипа «Ноготочки».
const DAY_MS = 24 * 60 * 60 * 1000;
function addDays(d, n) { return new Date(d.getTime() + n * DAY_MS); }
function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function pad(n) { return String(n).padStart(2, '0'); }

export const salonSettings = {
  address: 'Москва, ул. Цветочная, 12',
  phone: '+7 (999) 123-45-67',
  bookingHorizonMonths: 3,
  minLeadHours: 2,
  freeCancelHours: 24,
  slotHoldMinutes: 10,
  slotStepMinutes: 30,
  workHours: { from: '10:00', to: '20:00' },
  closedWeekdays: [0, 1], // вс, пн (0=вс если считать с вс; используем JS getDay(): 0=вс,1=пн)
};

export const serviceCategories = [
  { id: 'nails', name: 'Маникюр' },
  { id: 'pedicure', name: 'Педикюр' },
  { id: 'extension', name: 'Наращивание' },
  { id: 'brows', name: 'Брови' },
];

// cleanupMin — перерыв на уборку и дезинфекцию после услуги. На визит резервируется наибольший
// перерыв среди его услуг; он не даёт начать следующего клиента раньше, но может заходить на обед и конец смены.
export const services = [
  { id: 's1', categoryId: 'nails', name: 'Маникюр с покрытием гель-лаком', desc: 'Классический уход и стойкое покрытие', durationMin: 90, cleanupMin: 15, priceFrom: 1800, priceByLevel: { master: 1800, topMaster: 2200 } },
  { id: 's2', categoryId: 'nails', name: 'Маникюр без покрытия', desc: 'Аппаратный или комбинированный уход', durationMin: 45, cleanupMin: 15, priceFrom: 1200, priceByLevel: { master: 1200, topMaster: 1500 } },
  { id: 's3', categoryId: 'nails', name: 'Дизайн ногтей', desc: 'Дополнение к маникюру, маникюру и педикюру или наращиванию', durationMin: 30, cleanupMin: 0, priceFrom: 300, priceByLevel: { master: 300, topMaster: 300 }, addon: true },
  { id: 's4', categoryId: 'nails', name: 'Снятие покрытия', desc: 'Аккуратное снятие гель-лака', durationMin: 20, cleanupMin: 15, priceFrom: 500, priceByLevel: { master: 500, topMaster: 600 } },
  { id: 's5', categoryId: 'pedicure', name: 'Педикюр с покрытием', desc: 'Уход за стопами и стойкое покрытие', durationMin: 90, cleanupMin: 15, priceFrom: 2200, priceByLevel: { master: 2200, topMaster: 2600 } },
  { id: 's6', categoryId: 'pedicure', name: 'Педикюр без покрытия', desc: 'Уход за стопами без покрытия', durationMin: 60, cleanupMin: 15, priceFrom: 1600, priceByLevel: { master: 1600, topMaster: 1900 } },
  { id: 's7', categoryId: 'pedicure', name: 'Маникюр и педикюр', desc: 'Комплексный уход за руками и ногами', durationMin: 150, cleanupMin: 15, priceFrom: 3200, priceByLevel: { master: 3200, topMaster: 3800 } },
  { id: 's8', categoryId: 'extension', name: 'Наращивание ногтей', desc: 'Форма и длина по вашему желанию', durationMin: 150, cleanupMin: 15, priceFrom: 2800, priceByLevel: { master: 2800, topMaster: 3400 } },
  { id: 's9', categoryId: 'extension', name: 'Коррекция наращённых ногтей', desc: 'Поддержание формы между визитами', durationMin: 90, cleanupMin: 15, priceFrom: 1800, priceByLevel: { master: 1800, topMaster: 2200 } },
  { id: 's10', categoryId: 'extension', name: 'Снятие наращённых ногтей', desc: 'Бережное снятие материала', durationMin: 30, cleanupMin: 15, priceFrom: 600, priceByLevel: { master: 600, topMaster: 700 } },
  { id: 's11', categoryId: 'brows', name: 'Коррекция и окрашивание бровей', desc: 'Форма и цвет, подобранные под лицо', durationMin: 40, cleanupMin: 10, priceFrom: 1200, priceByLevel: { master: 1200, topMaster: 1500 } },
  { id: 's12', categoryId: 'brows', name: 'Ламинирование бровей', desc: 'Ухоженный вид без макияжа', durationMin: 60, cleanupMin: 10, priceFrom: 1800, priceByLevel: { master: 1800, topMaster: 2100 } },
  { id: 's13', categoryId: 'brows', name: 'Коррекция бровей', desc: 'Только форма, без окрашивания', durationMin: 20, cleanupMin: 10, priceFrom: 700, priceByLevel: { master: 700, topMaster: 900 } },
  { id: 's14', categoryId: 'brows', name: 'Окрашивание бровей хной', desc: 'Естественный стойкий цвет', durationMin: 30, cleanupMin: 10, priceFrom: 900, priceByLevel: { master: 900, topMaster: 1100 } },
];

export const masters = [
  {
    id: 'm1', name: 'Анна Ковалева', specialty: 'Маникюр и педикюр', level: 'master',
    workdays: [2, 3, 4, 5], workHours: { from: '10:00', to: '18:00' }, experienceYears: 7,
    // Паспорт, сценарий 2: наращивание с дизайном ногтей выполняет только Анна.
    serviceIds: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'],
  },
  {
    id: 'm2', name: 'Марина Орлова', specialty: 'Мастер по бровям', level: 'master',
    workdays: [3, 4, 5, 6], workHours: { from: '11:00', to: '20:00' }, experienceYears: 4,
    serviceIds: ['s11', 's12', 's13', 's14'],
  },
  {
    id: 'm3', name: 'Елена Смирнова', specialty: 'Универсальный мастер', level: 'master',
    workdays: [2, 4, 6], workHours: { from: '10:00', to: '19:00' }, experienceYears: 5,
    // Паспорт: Елена делает маникюр, наращивание (без дизайна) и ламинирование бровей.
    serviceIds: ['s1', 's2', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12', 's13'],
    // Паспорт, сценарий 8: отпуск Елены — блокировка в timeBlocks (таблица time_blocks).
  },
];

// Особые дни студии (таблица studio_day_overrides): закрыта весь день или работает в особые часы.
// Важнее режима студии по дню недели и графика мастеров.
export const studioDays = [
  { date: '2026-09-29', isOpen: false, from: '', to: '', reason: 'Санитарный день' },
  { date: '2026-12-31', isOpen: true, from: '10:00', to: '16:00', reason: 'Предпраздничный день' },
  { date: '2027-01-01', isOpen: false, from: '', to: '', reason: 'Новогодние праздники' },
  { date: '2027-03-08', isOpen: true, from: '10:00', to: '18:00', reason: 'Международный женский день — дополнительный рабочий день' },
];

export function studioDayFor(dateStr) {
  return studioDays.find((d) => d.date === dateStr) || null;
}

// Закрыта ли студия в этот день: сначала особый день, затем режим по дню недели.
export function isSalonClosedOn(dateStr) {
  const special = studioDayFor(dateStr);
  if (special) return !special.isOpen;
  const [y, m, dd] = dateStr.split('-').map(Number);
  return salonSettings.closedWeekdays.includes(new Date(y, m - 1, dd).getDay());
}

const hhmmToMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const minToHhmm = (mins) => pad(Math.floor(mins / 60)) + ':' + pad(mins % 60);
const parseLocalDate = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(y, m - 1, d); };
const atTime = (dateStr, hhmm) => new Date(parseLocalDate(dateStr).getTime() + hhmmToMin(hhmm) * 60000);
const TODAY = parseLocalDate(fmtDate(new Date()));
const HORIZON_DAYS = salonSettings.bookingHorizonMonths * 30;
const horizonDates = () => Array.from({ length: HORIZON_DAYS }, (_, i) => fmtDate(addDays(TODAY, i)));
const datesOnWeekday = (weekday) => horizonDates().filter((d) => parseLocalDate(d).getDay() === weekday);

// ===================================================================================
// Данные, из которых считается свободное время. Каждый массив повторяет таблицу БД
// (docs/db-schema.md). Готовых слотов нигде нет: свободное время мастера на день
// вычисляется в момент запроса — см. dayInfo(), getFreeIntervals(), getFreeStartTimes().
// ===================================================================================

// master_weekly_hours — обычный недельный график с периодом действия (valid_to = null — бессрочно).
export const weeklyHours = masters.flatMap((m) => m.workdays.map((weekday) => ({
  masterId: m.id, weekday, start: m.workHours.from, end: m.workHours.to, validFrom: '2024-01-01', validTo: null,
})));

// master_day_overrides — изменение смены на конкретную дату (из «Графика смен»).
// Пример: Елена выходит в ближайшую среду, хотя по графику работает вт, чт, сб.
export const masterDayOverrides = [
  { masterId: 'm3', date: datesOnWeekday(3)[0], isWorking: true, start: '12:00', end: '19:00' },
];

// time_blocks — блокировки времени мастера: конкретные промежутки (обед по четвергам — серия блокировок).
const firstSaturday = datesOnWeekday(6)[0];
export const timeBlocks = [
  // Паспорт, сценарий 1: обед Анны по четвергам 13:00–14:00.
  ...datesOnWeekday(4).map((d) => ({ masterId: 'm1', type: 'lunch', reason: 'Обед', startsAt: atTime(d, '13:00'), endsAt: atTime(d, '14:00') })),
  // Паспорт, сценарий 3: личное время Марины по пятницам 15:00–17:00.
  ...datesOnWeekday(5).map((d) => ({ masterId: 'm2', type: 'personal', reason: 'Личное время', startsAt: atTime(d, '15:00'), endsAt: atTime(d, '17:00') })),
  // Паспорт, сценарий 3: суббота Елены заблокирована как выходной.
  { masterId: 'm3', type: 'day_off', reason: 'Выходной', startsAt: atTime(firstSaturday, '00:00'), endsAt: addDays(atTime(firstSaturday, '00:00'), 1) },
  // Паспорт, сценарий 8: Елена уходит в отпуск на неделю (через 10 дней).
  { masterId: 'm3', type: 'vacation', reason: 'Отпуск', startsAt: addDays(TODAY, 10), endsAt: addDays(TODAY, 17) },
];

// slot_holds — брони времени на 10 минут у других клиентов. В демо пусто: сценарий «слот заняли»
// показывается через панель разработчика. Формат: { masterId, startsAt, busyUntil, expiresAt, ownerId }.
export const slotHolds = [];

// Статусы записей, которые занимают время мастера (отменённые время освобождают).
const OCCUPYING = new Set(['active', 'done', 'noShow']);

// ---- Режим дня: студия → изменение смены мастера → недельный график → блокировка на весь день ----
const dayInfoCache = new Map();
export function dayInfo(masterId, dateStr) {
  const key = masterId + '|' + dateStr;
  if (dayInfoCache.has(key)) return dayInfoCache.get(key);
  const date = parseLocalDate(dateStr);
  const weekday = date.getDay();
  const special = studioDayFor(dateStr);
  const res = { date: dateStr, weekday, status: 'available', startMin: 0, endMin: 0, reason: special ? special.reason : '' };
  if (isSalonClosedOn(dateStr)) { res.status = 'salonClosed'; dayInfoCache.set(key, res); return res; }
  const studio = special && special.isOpen ? special : salonSettings.workHours;
  const override = masterDayOverrides.find((o) => o.masterId === masterId && o.date === dateStr);
  const weekly = weeklyHours.find((w) => w.masterId === masterId && w.weekday === weekday && w.validFrom <= dateStr && (!w.validTo || w.validTo >= dateStr));
  const shift = override ? (override.isWorking ? override : null) : weekly;
  if (!shift) { res.status = 'masterOff'; dayInfoCache.set(key, res); return res; }
  res.startMin = Math.max(hhmmToMin(shift.start), hhmmToMin(studio.from));
  res.endMin = Math.min(hhmmToMin(shift.end), hhmmToMin(studio.to));
  if (res.endMin <= res.startMin) res.status = 'masterOff';
  // Блокировка, закрывающая всё рабочее окно: отпуск показывается отдельно, остальное — как выходной.
  const winStart = atTime(dateStr, minToHhmm(res.startMin)), winEnd = atTime(dateStr, minToHhmm(res.endMin));
  const fullBlock = timeBlocks.find((b) => b.masterId === masterId && b.startsAt <= winStart && b.endsAt >= winEnd);
  if (res.status === 'available' && fullBlock) { res.status = fullBlock.type === 'vacation' ? 'vacation' : 'masterOff'; res.reason = fullBlock.reason; }
  dayInfoCache.set(key, res);
  return res;
}

// Календарь мастера на горизонт записи (режим каждого дня, без слотов).
export function generateSchedule(masterId) {
  return horizonDates().map((d) => dayInfo(masterId, d));
}

// Ближайший или текущий отпуск мастера — из блокировок типа vacation.
export function getVacationInfo(master, ref = new Date()) {
  const vac = timeBlocks.filter((b) => b.masterId === master.id && b.type === 'vacation' && b.endsAt > ref).sort((a, b) => a.startsAt - b.startsAt)[0];
  if (!vac) return null;
  return { start: vac.startsAt, end: vac.endsAt, active: ref >= vac.startsAt && ref < vac.endsAt };
}

// ---- bookings: записи всех клиентов ----
// В демо это записи тестового клиента плюс детерминированно сгенерированные записи других клиентов.
// Генератор сам соблюдает правила базы: запись помещается в рабочее окно, не заходит на блокировки
// и вместе с уборкой не пересекается с другими записями.
const rand = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
let bookingsIndex = null;
function toBooking(b) {
  const s = services.find((x) => x.id === b.serviceId);
  const endsAt = new Date(b.datetime.getTime() + b.durationMin * 60000);
  return { id: b.id, masterId: b.masterId, clientId: 'c1', serviceIds: [b.serviceId], status: b.status,
    startsAt: b.datetime, endsAt, busyUntil: new Date(endsAt.getTime() + (s ? s.cleanupMin || 0 : 0) * 60000) };
}
function buildBookings() {
  const list = testClientBookings.map(toBooking);
  const overlaps = (masterId, from, to) => list.some((b) => b.masterId === masterId && OCCUPYING.has(b.status) && b.startsAt < to && b.busyUntil > from);
  const hitsBlock = (masterId, from, to) => timeBlocks.some((b) => b.masterId === masterId && b.startsAt < to && b.endsAt > from);
  const step = salonSettings.slotStepMinutes;
  masters.forEach((m, mi) => {
    const fill = m.almostFullyBooked ? 0.95 : 0.4;
    const mains = m.serviceIds.filter((id) => !(services.find((s) => s.id === id) || {}).addon);
    horizonDates().forEach((dateStr, di) => {
      const day = dayInfo(m.id, dateStr);
      if (day.status !== 'available') return;
      let cursor = day.startMin;
      while (cursor + step <= day.endMin) {
        const r = rand((mi + 1) * 100003 + di * 101 + cursor);
        const svc = services.find((s) => s.id === mains[Math.floor(rand(r * 7919) * mains.length)]);
        const startsAt = atTime(dateStr, minToHhmm(cursor));
        const endsAt = new Date(startsAt.getTime() + svc.durationMin * 60000);
        const busyUntil = new Date(endsAt.getTime() + (svc.cleanupMin || 0) * 60000);
        if (r < fill && cursor + svc.durationMin <= day.endMin && !hitsBlock(m.id, startsAt, endsAt) && !overlaps(m.id, startsAt, busyUntil)) {
          list.push({ id: 'g' + m.id + '-' + di + '-' + cursor, masterId: m.id, clientId: 'other', serviceIds: [svc.id], status: 'active', startsAt, endsAt, busyUntil });
          cursor += Math.ceil((svc.durationMin + (svc.cleanupMin || 0)) / step) * step;
        } else {
          cursor += step;
        }
      }
    });
  });
  // Индекс по мастеру и дате начала — как индекс bookings (master_id, starts_at) в БД.
  const index = new Map();
  list.forEach((b) => { const k = b.masterId + '|' + fmtDate(b.startsAt); if (!index.has(k)) index.set(k, []); index.get(k).push(b); });
  return { list, index };
}
export function allBookings() {
  if (!bookingsIndex) bookingsIndex = buildBookings();
  return bookingsIndex.list;
}

// Занятые промежутки мастера на день в минутах от полуночи: записи и брони — вместе с уборкой.
function busyForDay(masterId, dateStr, excludeBookingId) {
  allBookings();
  const dayStart = parseLocalDate(dateStr), dayEnd = addDays(dayStart, 1);
  const toMin = (d) => Math.round((d - dayStart) / 60000);
  const bookings = (bookingsIndex.index.get(masterId + '|' + dateStr) || [])
    .filter((b) => OCCUPYING.has(b.status) && b.id !== excludeBookingId)
    .map((b) => [toMin(b.startsAt), toMin(b.busyUntil)]);
  const now = new Date();
  const holds = slotHolds.filter((h) => h.masterId === masterId && h.expiresAt > now && h.startsAt < dayEnd && h.busyUntil > dayStart)
    .map((h) => [toMin(h.startsAt), toMin(h.busyUntil)]);
  const blocks = timeBlocks.filter((b) => b.masterId === masterId && b.startsAt < dayEnd && b.endsAt > dayStart)
    .map((b) => [Math.max(0, toMin(b.startsAt)), Math.min(24 * 60, toMin(b.endsAt))]);
  return { clients: bookings.concat(holds), blocks };
}

// Свободные интервалы мастера на день: рабочее окно минус записи (с уборкой), брони и блокировки.
export function getFreeIntervals(masterId, dateStr, excludeBookingId = null) {
  const day = dayInfo(masterId, dateStr);
  if (day.status !== 'available') return [];
  const { clients, blocks } = busyForDay(masterId, dateStr, excludeBookingId);
  let free = [[day.startMin, day.endMin]];
  clients.concat(blocks).forEach(([a, b]) => {
    free = free.flatMap(([s, e]) => (b <= s || a >= e) ? [[s, e]] : [[s, Math.min(a, e)], [Math.max(b, s), e]].filter(([x, y]) => y > x));
  });
  return free;
}

// Ближайшее свободное время мастера (для карточки на шаге «Мастер»).
export function nearestFreeSlot(masterId, durationMin = salonSettings.slotStepMinutes, cleanupMin = 0) {
  for (const dateStr of horizonDates()) {
    const slots = getFreeStartTimes(masterId, dateStr, durationMin, cleanupMin);
    if (slots.length) return { date: dateStr, time: slots[0].start };
  }
  return null;
}

// Несовместимые в одном визите услуги (мок для проверки конфликтов).
export const incompatiblePairs = [
  { pair: ['s1', 's8'], reason: 'Маникюр с покрытием и наращивание ногтей выполняются на одних и тех же ногтях — выберите одну из услуг.' },
];

export function findIncompatible(cartIds, newId) {
  for (const item of incompatiblePairs) {
    const [a, b] = item.pair;
    if ((newId === a && cartIds.includes(b)) || (newId === b && cartIds.includes(a))) return item;
  }
  return null;
}

// ---- Пароли: хранится только хеш (как users.password_hash), открытого пароля в данных нет ----
// Формат: алгоритм$итерации$соль$хеш (соль и хеш — base64). В настоящем сервисе хеш считает сервер
// (argon2id или bcrypt), в прототипе — браузер через Web Crypto (PBKDF2-SHA256, 600 000 итераций).
const PBKDF2_ITERATIONS = 600000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (ch) => ch.charCodeAt(0));
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return 'pbkdf2-sha256$' + PBKDF2_ITERATIONS + '$' + b64(salt) + '$' + b64(await pbkdf2(password, salt, PBKDF2_ITERATIONS));
}
export async function verifyPassword(password, stored) {
  const [algo, iter, salt, hash] = String(stored || '').split('$');
  if (algo !== 'pbkdf2-sha256' || !salt || !hash) return false;
  const actual = b64(await pbkdf2(password, unb64(salt), Number(iter)));
  // Сравнение без раннего выхода, чтобы время ответа не подсказывало совпавшие символы.
  let diff = actual.length ^ hash.length;
  for (let i = 0; i < Math.max(actual.length, hash.length); i++) diff |= (actual.charCodeAt(i) || 0) ^ (hash.charCodeAt(i) || 0);
  return diff === 0;
}

// Тестовый клиент и его записи. Пароль для входа в демо — в подсказке панели разработчика, не в данных.
export const testClient = { id: 'c1', name: 'Мария Кузнецова', phone: '+7 (911) 222-33-44', email: 'maria@example.com',
  passwordHash: 'pbkdf2-sha256$600000$QZeO66KJpRl6i7oWxkw0eg==$wR/Ui6yghDzymEcT5h+QOrB+IdZRakePRejs3WLdPos=' };

export const testClientBookings = (() => {
  const now = new Date();
  // Время записей выровнено по шагу слотов (30 минут), как у настоящих записей.
  const inHours = (h) => { const t = new Date(now.getTime() + h * 3600 * 1000); t.setMinutes(Math.round(t.getMinutes() / 30) * 30, 0, 0); return t; };
  const agoDays = (d) => addDays(now, -d);
  return [
    { id: 'b1', serviceId: 's1', status: 'active', service: 'Маникюр с покрытием гель-лаком', master: 'Анна Ковалева', masterId: 'm1', datetime: inHours(30), durationMin: 90, price: '1 800 ₽', canModify: true, comment: 'Пожалуйста, покороче форму', address: salonSettings.address },
    { id: 'b2', serviceId: 's11', status: 'active', service: 'Коррекция и окрашивание бровей', master: 'Марина Орлова', masterId: 'm2', datetime: inHours(10), durationMin: 40, price: '1 200 ₽', canModify: false, restrictReason: 'Изменение недоступно менее чем за сутки до визита', address: salonSettings.address },
    { id: 'b8', serviceId: 's8', status: 'active', service: 'Наращивание ногтей', master: 'Анна Ковалева', masterId: 'm1', datetime: inHours(96), durationMin: 150, price: '2 800 ₽', canModify: true, address: salonSettings.address },
    { id: 'b3', serviceId: 's7', status: 'done', service: 'Маникюр и педикюр', master: 'Елена Смирнова', masterId: 'm3', datetime: agoDays(6), durationMin: 150, price: '3 200 ₽', address: salonSettings.address },
    { id: 'b4', serviceId: 's8', status: 'done', service: 'Наращивание ногтей', master: 'Елена Смирнова', masterId: 'm3', datetime: agoDays(20), durationMin: 150, price: '2 800 ₽', address: salonSettings.address },
    { id: 'b5', serviceId: 's12', status: 'done', service: 'Ламинирование бровей', master: 'Марина Орлова', masterId: 'm2', datetime: agoDays(45), durationMin: 60, price: '1 800 ₽', address: salonSettings.address },
    { id: 'b6', serviceId: 's2', status: 'cancelledClient', service: 'Маникюр без покрытия', master: 'Елена Смирнова', masterId: 'm3', datetime: agoDays(12), durationMin: 45, price: '1 200 ₽', address: salonSettings.address },
    { id: 'b7', serviceId: 's5', status: 'cancelledStudio', service: 'Педикюр с покрытием', master: 'Анна Ковалева', masterId: 'm1', datetime: agoDays(30), durationMin: 90, price: '2 200 ₽', reason: 'Мастер заболела', address: salonSettings.address },
    { id: 'b9', serviceId: 's13', status: 'noShow', service: 'Коррекция бровей', master: 'Марина Орлова', masterId: 'm2', datetime: agoDays(50), durationMin: 20, price: '700 ₽', address: salonSettings.address },
  ];
})();


// ---- Помощники для шага «Дата и время» ----

export function findCoveringMasters(cartIds) {
  return masters.filter((m) => cartIds.every((id) => m.serviceIds.includes(id)));
}

// Перерыв на уборку для визита из нескольких услуг — наибольший среди них (уборка одна, после визита).
export function cleanupForServices(serviceIds) {
  return serviceIds.reduce((max, id) => { const s = services.find((x) => x.id === id); return Math.max(max, s ? (s.cleanupMin || 0) : 0); }, 0);
}

// Слоты {start,end}, с которых можно начать визит длительностью durationMin (алгоритм — docs/db-schema.md, раздел 7.3):
// визит целиком внутри одного свободного интервала; визит вместе с уборкой (cleanupMin) не задевает
// другие записи и брони, но может заходить на блокировки и за конец смены.
// excludeBookingId — переносимая запись: её собственное время не считается занятым.
export function getFreeStartTimes(masterId, dateStr, durationMin, cleanupMin = 0, excludeBookingId = null) {
  const day = dayInfo(masterId, dateStr);
  if (day.status !== 'available') return [];
  const free = getFreeIntervals(masterId, dateStr, excludeBookingId);
  const { clients } = busyForDay(masterId, dateStr, excludeBookingId);
  const step = salonSettings.slotStepMinutes;
  const earliest = Date.now() + salonSettings.minLeadHours * 3600 * 1000;
  const results = [];
  for (let mins = day.startMin; mins + durationMin <= day.endMin; mins += step) {
    if (!free.some(([a, b]) => mins >= a && mins + durationMin <= b)) continue;
    const busyEnd = mins + durationMin + cleanupMin;
    if (clients.some(([a, b]) => a < busyEnd && b > mins)) continue;
    if (atTime(dateStr, minToHhmm(mins)).getTime() < earliest) continue;
    results.push({ start: minToHhmm(mins), end: minToHhmm(mins + durationMin) });
  }
  return results;
}

export function dayHasAvailability(masterIds, dateStr, durationMin, cleanupMin = 0, excludeBookingId = null) {
  return masterIds.some((id) => getFreeStartTimes(id, dateStr, durationMin, cleanupMin, excludeBookingId).length > 0);
}

// Следующие count дат (после fromDateStr), где у кого-то из masterIds есть окно.
export function nextAvailableDates(masterIds, durationMin, fromDateStr, count = 3, cleanupMin = 0, excludeBookingId = null) {
  if (!masterIds.length) return [];
  const out = [];
  for (const dateStr of horizonDates()) {
    if (dateStr <= fromDateStr) continue;
    if (dayHasAvailability(masterIds, dateStr, durationMin, cleanupMin, excludeBookingId)) {
      out.push(dateStr);
      if (out.length >= count) break;
    }
  }
  return out;
}

// Первый доступный слот в горизонте записи (для «Ближайшее свободное время»).
export function nearestAvailableSlot(masterIds, durationMin, cleanupMin = 0, excludeBookingId = null) {
  if (!masterIds.length) return null;
  for (const dateStr of horizonDates()) {
    for (const masterId of masterIds) {
      const slots = getFreeStartTimes(masterId, dateStr, durationMin, cleanupMin, excludeBookingId);
      if (slots.length) return { date: dateStr, start: slots[0].start, end: slots[0].end, masterId };
    }
  }
  return null;
}

// Есть ли хоть один слот во всём горизонте (для «всё занято» / «нет окна для визита»).
export function hasAnyAvailability(masterIds, durationMin, cleanupMin = 0, excludeBookingId = null) {
  return !!nearestAvailableSlot(masterIds, durationMin, cleanupMin, excludeBookingId);
}

function nextAvailableDatesDetailed(masterIds, durationMin, fromDateStr, count, cleanupMin = 0, excludeBookingId = null) {
  const out = [];
  for (const dateStr of horizonDates()) {
    if (dateStr <= fromDateStr) continue;
    for (const id of masterIds) {
      const slots = getFreeStartTimes(id, dateStr, durationMin, cleanupMin, excludeBookingId);
      if (slots.length) { out.push({ date: dateStr, start: slots[0].start, end: slots[0].end, masterId: id }); break; }
    }
    if (out.length >= count) break;
  }
  return out;
}

// Альтернативные слоты при конфликте (сначала тот же день, затем следующие дни).
export function getAlternativeSlots(masterIds, dateStr, durationMin, excludeStart, count = 5, cleanupMin = 0, excludeBookingId = null) {
  const sameDay = [];
  masterIds.forEach((id) => {
    getFreeStartTimes(id, dateStr, durationMin, cleanupMin, excludeBookingId).forEach((s) => {
      if (s.start !== excludeStart) sameDay.push({ date: dateStr, start: s.start, end: s.end, masterId: id });
    });
  });
  let out = sameDay.slice(0, count);
  if (out.length < count) out = out.concat(nextAvailableDatesDetailed(masterIds, durationMin, dateStr, count - out.length, cleanupMin, excludeBookingId));
  return out.slice(0, count);
}
