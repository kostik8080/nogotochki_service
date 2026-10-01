// Общее для заявок мастера: как называется тип, состояние и период. Одними и теми же словами заявку
// видят мастер в своем разделе (/master/requests) и администратор в своем (/admin/requests).
import { dateLong, escapeHtml as esc } from './format.js';

export const TYPE_LABEL = {
  vacation: 'Отпуск',
  day_off: 'Отгул',
  sick_leave: 'Больничный',
  schedule: 'Новый график работы',
  other: 'Просьба',
};

export const STATUS_LABEL = {
  pending: { label: 'На рассмотрении', cls: 'warn' },
  approved: { label: 'Одобрена', cls: 'on' },
  rejected: { label: 'Отклонена', cls: 'no-show' },
  cancelled: { label: 'Отозвана', cls: 'off' },
};

export const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/** «1 октября 2026» — дата заявки; в ней нет времени, поэтому часовой пояс не нужен. */
export const dayLabel = (date) => dateLong(date + 'T12:00:00Z', 'UTC');

/**
 * Что именно просит мастер: период дат, новый график или текст просьбы.
 * @param {{ type: string, startsOn: string | null, endsOn: string | null, validFrom: string | null,
 *   days: { weekday: number, start: string, end: string }[] | null }} request
 */
export function periodText(request) {
  if (request.startsOn) {
    return request.startsOn === request.endsOn
      ? dayLabel(request.startsOn)
      : `${dayLabel(request.startsOn)} — ${dayLabel(request.endsOn)}`;
  }
  if (request.type === 'schedule' && request.days) {
    const hours = new Set(request.days.map((d) => `${d.start}–${d.end}`));
    const days = request.days.map((d) => WEEKDAYS_SHORT[d.weekday - 1]).join(', ');
    return `с ${dayLabel(request.validFrom)}: ${days} · ` +
      (hours.size === 1 ? [...hours][0] : request.days.map((d) => `${WEEKDAYS_SHORT[d.weekday - 1]} ${d.start}–${d.end}`).join('; '));
  }
  return '';
}

/** Бейдж состояния заявки. */
export function statusBadge(status) {
  const s = STATUS_LABEL[status] ?? { label: status, cls: 'off' };
  return `<span class="admin-badge admin-badge--${s.cls}">${esc(s.label)}</span>`;
}

/** Решение администратора: кто, когда и почему. Пусто, пока заявка на рассмотрении. */
export function decisionText(request) {
  if (!request.decision) return '';
  const who = request.decision.by?.name ?? 'Администратор';
  const verb = request.status === 'approved' ? 'Одобрил' : 'Отклонил';
  return `${verb} ${who}${request.decision.reason ? `: ${request.decision.reason}` : ''}`;
}
