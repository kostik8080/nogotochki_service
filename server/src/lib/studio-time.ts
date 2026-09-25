// Время студии. В базе моменты хранятся в UTC, а график, режим работы и календарные даты
// заданы по часам студии (docs/db-schema.md, раздел 2). Здесь — перевод между ними
// через часовой пояс IANA из settings.timezone, например 'Europe/Moscow'.
// Моменты времени — миллисекунды с 1970 года (как Date.getTime()), даты — 'YYYY-MM-DD', время — 'HH:MM'.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Показания часов в поясе timeZone в указанный момент. */
function wallClock(instant: number, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Смещение пояса от UTC в миллисекундах в указанный момент (для Москвы — 3 часа). */
function offsetMs(instant: number, timeZone: string): number {
  const c = wallClock(instant, timeZone);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * Дата и время по часам студии → момент в UTC. Смещение уточняется вторым шагом:
 * у поясов с переходом на летнее время оно зависит от самого момента.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  return asUtc - offsetMs(asUtc - offsetMs(asUtc, timeZone), timeZone);
}

/** Календарная дата студии в указанный момент: 'YYYY-MM-DD'. */
export function zonedDate(instant: number, timeZone: string): string {
  const c = wallClock(instant, timeZone);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}`;
}

/** Время по часам студии в указанный момент: 'HH:MM'. */
export function zonedTime(instant: number, timeZone: string): string {
  const c = wallClock(instant, timeZone);
  return `${pad(c.hour)}:${pad(c.minute)}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** День недели по ISO: 1 — понедельник … 7 — воскресенье (в JavaScript воскресенье — 0). */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

const pad = (n: number) => String(n).padStart(2, '0');
