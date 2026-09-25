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
    // Паспорт, сценарий 8: Елена уходит в отпуск на неделю.
    vacation: { startOffsetDays: 10, lengthDays: 7 },
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

// Генерация расписания мастера на bookingHorizonMonths вперёд.
export function generateSchedule(masterId) {
  const master = masters.find((m) => m.id === masterId);
  if (!master) return [];
  const today = new Date();
  const days = [];
  const horizonDays = salonSettings.bookingHorizonMonths * 30;
  let vacationStart = null, vacationEnd = null;
  if (master.vacation) {
    vacationStart = addDays(today, master.vacation.startOffsetDays);
    vacationEnd = addDays(vacationStart, master.vacation.lengthDays);
  }
  for (let i = 0; i < horizonDays; i++) {
    const date = addDays(today, i);
    const weekday = date.getDay(); // 0=вс..6=сб
    const special = studioDayFor(fmtDate(date));
    const salonClosed = isSalonClosedOn(fmtDate(date));
    // Рабочее окно — пересечение смены мастера с часами студии (в особый день — с его часами).
    let startMin = hhmmToMin(master.workHours.from), endMin = hhmmToMin(master.workHours.to);
    if (special && special.isOpen) { startMin = Math.max(startMin, hhmmToMin(special.from)); endMin = Math.min(endMin, hhmmToMin(special.to)); }
    const masterWorks = master.workdays.includes(weekday);
    const onVacation = vacationStart && date >= vacationStart && date < vacationEnd;
    let status = 'available';
    if (salonClosed) status = 'salonClosed';
    else if (onVacation) status = 'vacation';
    else if (!masterWorks || endMin <= startMin) status = 'masterOff';
    const busy = [];
    if (status === 'available') {
      const stepMin = salonSettings.slotStepMinutes;
      const slotsCount = (endMin - startMin) / stepMin;
      // детерминированная "занятость" — псевдослучайно по дню/индексу
      const fillRatio = master.almostFullyBooked ? 0.97 : 0.35;
      for (let s = 0; s < slotsCount; s++) {
        const seed = (i * 7 + s * 13 + masterId.length) % 100;
        if (seed / 100 < fillRatio) {
          const mins = startMin + s * stepMin;
          busy.push(`${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`);
        }
      }
    }
    days.push({ date: fmtDate(date), weekday, status, busy, startMin, endMin, reason: special ? special.reason : '' });
  }
  return days;
}

// Отпуск мастера относительно текущей даты.
export function getVacationInfo(master, ref = new Date()) {
  if (!master.vacation) return null;
  const start = addDays(ref, master.vacation.startOffsetDays);
  const end = addDays(start, master.vacation.lengthDays);
  return { start, end, active: ref >= start && ref < end };
}

// Ближайший свободный слот мастера с учётом минимального времени до записи.
export function nearestFreeSlot(masterId) {
  const master = masters.find((m) => m.id === masterId);
  if (!master) return null;
  const schedule = generateSchedule(masterId);
  const now = new Date();
  const minLeadMs = salonSettings.minLeadHours * 3600 * 1000;
  const step = salonSettings.slotStepMinutes;
  for (const day of schedule) {
    if (day.status !== 'available') continue;
    for (let mins = day.startMin; mins < day.endMin; mins += step) {
      const time = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
      if (day.busy.includes(time)) continue;
      const dt = new Date(day.date + 'T' + time + ':00');
      if (dt.getTime() - now.getTime() < minLeadMs) continue;
      return { date: day.date, time };
    }
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

// Тестовый клиент и его записи.
export const testClient = { id: 'c1', name: 'Мария Кузнецова', phone: '+7 (911) 222-33-44', email: 'maria@example.com' };

export const testClientBookings = (() => {
  const now = new Date();
  const inHours = (h) => new Date(now.getTime() + h * 3600 * 1000);
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

function getMasterDay(masterId, dateStr) {
  return generateSchedule(masterId).find((d) => d.date === dateStr);
}

// Перерыв на уборку для визита из нескольких услуг — наибольший среди них (уборка одна, после визита).
export function cleanupForServices(serviceIds) {
  return serviceIds.reduce((max, id) => { const s = services.find((x) => x.id === id); return Math.max(max, s ? (s.cleanupMin || 0) : 0); }, 0);
}

// Список окон {start,end}, куда целиком помещается визит длительностью durationMin.
// cleanupMin — перерыв на уборку после визита: он не должен задевать занятое время,
// но может выходить за конец смены.
export function getFreeStartTimes(masterId, dateStr, durationMin, cleanupMin = 0) {
  const day = getMasterDay(masterId, dateStr);
  if (!day || day.status !== 'available') return [];
  const { startMin, endMin } = day;
  const step = salonSettings.slotStepMinutes;
  const busySet = new Set(day.busy);
  const now = new Date();
  const isToday = dateStr === fmtDate(now);
  const minLeadMs = salonSettings.minLeadHours * 3600 * 1000;
  const results = [];
  for (let mins = startMin; mins + durationMin <= endMin; mins += step) {
    let ok = true;
    const busyEnd = Math.min(mins + durationMin + cleanupMin, endMin);
    for (let m = mins; m < busyEnd; m += step) {
      const t = pad(Math.floor(m / 60)) + ':' + pad(m % 60);
      if (busySet.has(t)) { ok = false; break; }
    }
    if (!ok) continue;
    const startTime = pad(Math.floor(mins / 60)) + ':' + pad(mins % 60);
    if (isToday) {
      const dt = new Date(dateStr + 'T' + startTime + ':00');
      if (dt.getTime() - now.getTime() < minLeadMs) continue;
    }
    const endMins = mins + durationMin;
    const endTime = pad(Math.floor(endMins / 60)) + ':' + pad(endMins % 60);
    results.push({ start: startTime, end: endTime });
  }
  return results;
}

export function dayHasAvailability(masterIds, dateStr, durationMin, cleanupMin = 0) {
  return masterIds.some((id) => getFreeStartTimes(id, dateStr, durationMin, cleanupMin).length > 0);
}

// Следующие count дат (после fromDateStr), где у кого-то из masterIds есть окно.
export function nextAvailableDates(masterIds, durationMin, fromDateStr, count = 3, cleanupMin = 0) {
  if (!masterIds.length) return [];
  const schedule = generateSchedule(masterIds[0]);
  const out = [];
  for (const day of schedule) {
    if (day.date <= fromDateStr) continue;
    if (dayHasAvailability(masterIds, day.date, durationMin, cleanupMin)) {
      out.push(day.date);
      if (out.length >= count) break;
    }
  }
  return out;
}

// Первый доступный слот в горизонте записи (для «Ближайшее свободное время»).
export function nearestAvailableSlot(masterIds, durationMin, cleanupMin = 0) {
  if (!masterIds.length) return null;
  const schedule = generateSchedule(masterIds[0]);
  for (const day of schedule) {
    for (const masterId of masterIds) {
      const slots = getFreeStartTimes(masterId, day.date, durationMin, cleanupMin);
      if (slots.length) return { date: day.date, start: slots[0].start, end: slots[0].end, masterId };
    }
  }
  return null;
}

// Есть ли хоть один слот во всём горизонте (для «всё занято» / «нет окна для визита»).
export function hasAnyAvailability(masterIds, durationMin, cleanupMin = 0) {
  return !!nearestAvailableSlot(masterIds, durationMin, cleanupMin);
}


function nextAvailableDatesDetailed(masterIds, durationMin, fromDateStr, count, cleanupMin = 0) {
  const schedule = generateSchedule(masterIds[0]);
  const out = [];
  for (const day of schedule) {
    if (day.date <= fromDateStr) continue;
    for (const id of masterIds) {
      const slots = getFreeStartTimes(id, day.date, durationMin, cleanupMin);
      if (slots.length) { out.push({ date: day.date, start: slots[0].start, end: slots[0].end, masterId: id }); break; }
    }
    if (out.length >= count) break;
  }
  return out;
}

// Альтернативные слоты при конфликте (сначала тот же день, затем следующие дни).
export function getAlternativeSlots(masterIds, dateStr, durationMin, excludeStart, count = 5, cleanupMin = 0) {
  const sameDay = [];
  masterIds.forEach((id) => {
    getFreeStartTimes(id, dateStr, durationMin, cleanupMin).forEach((s) => {
      if (s.start !== excludeStart) sameDay.push({ date: dateStr, start: s.start, end: s.end, masterId: id });
    });
  });
  let out = sameDay.slice(0, count);
  if (out.length < count) out = out.concat(nextAvailableDatesDetailed(masterIds, durationMin, dateStr, count - out.length, cleanupMin));
  return out.slice(0, count);
}
