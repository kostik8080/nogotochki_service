// Файл .ics для календаря телефона: «Добавить в календарь» на экране успеха (BOOK-05) и в карточке записи (CAB-03).
// Файл собирает браузер из записи, API для этого не нужен (docs/ui-map.md).

/** Текст для поля iCalendar: запятая, точка с запятой, обратная косая и перевод строки экранируются (RFC 5545) */
const icsText = (value) => String(value).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
/** 2026-09-30T09:00:00.000Z → 20260930T090000Z */
const icsTime = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** «Маникюр с покрытием гель-лаком, Дизайн ногтей ×2» */
export const bookingServices = (booking) =>
  booking.items.map((i) => (i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name)).join(', ');

/**
 * Скачать файл календаря с визитом.
 * @param {{ id: number, startsAt: string, endsAt: string, master: { name: string }, items: any[] }} booking
 * @param {{ address: string }} studio
 */
export function downloadIcs(booking, studio) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nogotochki//Online booking//RU',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:booking-${booking.id}@nogotochki`,
    `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(booking.startsAt)}`,
    `DTEND:${icsTime(booking.endsAt)}`,
    `SUMMARY:${icsText(`Ноготочки: ${bookingServices(booking)}`)}`,
    `LOCATION:${icsText(studio.address)}`,
    `DESCRIPTION:${icsText(`Мастер: ${booking.master.name}. Изменить или отменить запись — в личном кабинете.`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `nogotochki-${booking.startsAt.slice(0, 10)}.ics`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
