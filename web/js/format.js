// Форматирование данных API для показа: деньги приходят в копейках, длительность — в минутах,
// телефон — в виде +79991234567 (docs/api.md, «Общие правила»).

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** 180000 → «1 800 ₽» */
export const money = (kop) => rub.format(kop / 100) + ' ₽';

/** 90 → «1 ч 30 мин», 60 → «1 ч», 40 → «40 мин» */
export function duration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/** +79991234567 → «+7 (999) 123-45-67»; номер другого вида возвращается как есть. */
export function phone(value) {
  const d = String(value).replace(/\D/g, '');
  if (d.length !== 11 || !/^[78]/.test(d)) return value;
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

/** Ссылка для звонка: tel:+79991234567 */
export const phoneHref = (value) => 'tel:' + String(value).replace(/[^\d+]/g, '');

/** «Анна Ковалева» → «АК» */
export const initials = (name) =>
  String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');

/** 1 → «час», 3 → «часа», 5 → «часов» */
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// ---------- Дата и время: API присылает UTC, показываем в часовом поясе студии ----------

/** «чт, 1 октября» */
export const dateLabel = (iso, timeZone) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(iso));

/** «1 октября 2026» */
export const dateLong = (iso, timeZone) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(iso)).replace(/\s*г\.$/, '');

/** «10:00» */
export const timeLabel = (iso, timeZone) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** «через 3 дня», «через 5 часов», «меньше чем через час», «уже началась» */
export function countdown(iso, now = Date.now()) {
  const diff = Date.parse(iso) - now;
  if (diff <= 0) return 'уже началась';
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return `через ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1) return `через ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  return 'меньше чем через час';
}

/** Экранирование текста из API перед вставкой в разметку. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
