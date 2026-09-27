// Раздел мастера: свое расписание, только просмотр (GET /api/master/schedule).
// Контактов клиентов и цен в ответе нет — это проверка того, что API их не отдает.
import { useState } from 'react';
import { api, fmtTime, minutes, STATUS_LABELS, studioToday, type BookingStatus } from '../api';
import { ErrorBox, Json, Loading, useApp, useLoad } from '../ui';

interface ScheduleDay {
  date: string;
  status: 'open' | 'studio_closed' | 'master_off';
  window: { start: string; end: string } | null;
  reason: string | null;
  bookings: {
    id: number;
    startsAt: string;
    endsAt: string;
    status: BookingStatus;
    isOverbooking: boolean;
    services: { name: string; quantity: number; durationMin: number }[];
    comment: string | null;
    client: { name: string; importantNote: string | null };
  }[];
  timeBlocks: { type: string; startsAt: string; endsAt: string; comment: string | null }[];
}

const BLOCK_LABELS: Record<string, string> = {
  lunch: 'Обед', personal: 'Личное время', day_off: 'Выходной', vacation: 'Отпуск', sick_leave: 'Больничный', other: 'Другое',
};

export function MasterSchedulePage() {
  const { user } = useApp();
  const [from, setFrom] = useState(studioToday());
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState({ from, to });
  const schedule = useLoad(
    () => (user?.role === 'master'
      ? api.get<{ master: { name: string }; days: ScheduleDay[] }>('/api/master/schedule', applied)
      : Promise.resolve(undefined)),
    [applied, user?.role],
  );

  if (!user) return <div className="error">Нужно <a href="#/login">войти</a> учетной записью мастера.</div>;
  if (user.role !== 'master') return <div className="error">Раздел только для мастера.</div>;

  return (
    <>
      <h1>Мое расписание{schedule.data && `: ${schedule.data.master.name}`}</h1>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setApplied({ from, to }); }}>
        <label>С <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>по <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button>Показать</button>
        <span className="muted small">По умолчанию — неделя; не больше 31 дня.</span>
      </form>
      <ErrorBox error={schedule.error} />
      <Loading loading={schedule.loading}>
        {schedule.data?.days.map((d) => (
          <section key={d.date}>
            <h3>
              {d.date}:{' '}
              {d.status === 'open' && d.window ? `работаю ${fmtTime(d.window.start)}–${fmtTime(d.window.end)}`
                : d.status === 'studio_closed' ? `студия закрыта${d.reason ? ` (${d.reason})` : ''}` : 'выходной'}
            </h3>
            {d.timeBlocks.map((t, i) => (
              <div key={i} className="muted">{BLOCK_LABELS[t.type] ?? t.type}: {fmtTime(t.startsAt)}–{fmtTime(t.endsAt)}{t.comment && ` — ${t.comment}`}</div>
            ))}
            {d.bookings.length === 0 ? <p className="muted small">Записей нет.</p> : (
              <ul>
                {d.bookings.map((b) => (
                  <li key={b.id}>
                    <b>{fmtTime(b.startsAt)}–{fmtTime(b.endsAt)}</b> {b.client.name}: {b.services.map((s) => `${s.name}${s.quantity > 1 ? ` × ${s.quantity}` : ''} (${minutes(s.durationMin)})`).join(', ')}
                    {' '}· {STATUS_LABELS[b.status]}{b.isOverbooking && <b> · наложение</b>}
                    {b.client.importantNote && <div><b>Важно:</b> {b.client.importantNote}</div>}
                    {b.comment && <div className="muted">Комментарий: {b.comment}</div>}
                    {' '}<a href={`#/bookings/${b.id}`}>Карточка</a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        {schedule.data && <Json value={schedule.data} />}
      </Loading>
    </>
  );
}
