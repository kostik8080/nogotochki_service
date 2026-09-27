// Страница 5 (продолжение): детали записи, перенос и отмена (GET /api/bookings/:id,
// POST /api/bookings/:id/reschedule, POST /api/bookings/:id/cancel).
// Клиент переносит запись по брони (POST /api/holds с bookingId) и только до срока правила 24 часов.
// Администратор переносит и отменяет без этих ограничений, может сменить мастера, поставить запись
// поверх занятого времени и отметить итог визита (POST /api/bookings/:id/status).
import { useEffect, useState } from 'react';
import {
  api, fmtDateTime, fmtTime, LEVEL_LABELS, minutes, rub, STATUS_LABELS, studioDate, studioToday, studioToUtc,
  type Booking, type Hold, type Master, type SlotsResponse,
} from '../api';
import { ErrorBox, Json, Loading, useAction, useApp, useLoad } from '../ui';

const statusLabel = (s: string | null | undefined) => (s ? STATUS_LABELS[s as keyof typeof STATUS_LABELS] ?? s : '—');

const EVENT_LABELS: Record<string, string> = {
  edited: 'Изменена',
  rescheduled: 'Перенесена',
  cancelled: 'Отменена',
  status_changed: 'Статус изменен',
};

export function BookingPage({ id }: { id: number }) {
  const { user, studio } = useApp();
  const booking = useLoad(() => api.get<{ booking: Booking }>(`/api/bookings/${id}`), [id]);
  const b = booking.data?.booking;

  return (
    <>
      <h1>Запись №{id}</h1>
      <p>{user?.role === 'client' ? <a href="#/cabinet">← Мои записи</a> : user?.role === 'admin' ? <a href="#/admin">← Все записи</a> : <a href="#/master">← Расписание</a>}</p>
      <ErrorBox error={booking.error} />
      <Loading loading={booking.loading && !b}>
        {b && (
          <>
            <Details b={b} />
            {user?.role === 'client' && b.status === 'active' && !b.canChange && (
              <div className="warn">
                До визита меньше {studio?.rules.clientChangeDeadlineHours ?? 24} часов: отменить или перенести запись можно только через студию
                {studio?.phone ? ` по телефону ${studio.phone}` : ''}.
              </div>
            )}
            {b.status === 'active' && (user?.role === 'admin' || (user?.role === 'client' && b.canChange)) && (
              <>
                <Reschedule b={b} isAdmin={user.role === 'admin'} onDone={booking.reload} />
                <Cancel b={b} isAdmin={user.role === 'admin'} onDone={booking.reload} />
              </>
            )}
            {user?.role === 'admin' && b.status !== 'cancelled_by_client' && b.status !== 'cancelled_by_studio' && (
              <VisitResult b={b} onDone={booking.reload} />
            )}
            {b.events && <History b={b} />}
            <Json value={b} />
          </>
        )}
      </Loading>
    </>
  );
}

function Details({ b }: { b: Booking }) {
  return (
    <section>
      <table>
        <tbody>
          <tr><th>Статус</th><td>{STATUS_LABELS[b.status]}{b.isOverbooking && <b> · наложение</b>}</td></tr>
          <tr><th>Когда</th><td>{fmtDateTime(b.startsAt)}–{fmtTime(b.endsAt)} ({minutes(b.durationMin)})</td></tr>
          <tr><th>Мастер</th><td>{b.master.name} ({LEVEL_LABELS[b.master.level]}){b.isAnyMaster && ' — выбран «Любой свободный мастер»'}</td></tr>
          <tr>
            <th>Услуги</th>
            <td>
              <ul>
                {b.items.map((i) => (
                  <li key={i.serviceId}>
                    {i.name}{i.quantity > 1 && ` × ${i.quantity}`}, {minutes(i.durationMin)}{i.priceKop !== undefined && `, ${rub(i.priceKop)}`}
                  </li>
                ))}
              </ul>
            </td>
          </tr>
          {b.totalPriceKop !== undefined && <tr><th>Итого</th><td>{rub(b.totalPriceKop)}</td></tr>}
          <tr><th>Комментарий</th><td>{b.comment ?? '—'}</td></tr>
          {b.client && (
            <tr>
              <th>Клиент</th>
              <td>
                {b.client.name}{b.client.id !== undefined && ` (id ${b.client.id})`}
                {b.client.phone && <div>{b.client.phone}</div>}
                {b.client.email && <div>{b.client.email}</div>}
                {b.client.importantNote && <div><b>Важно:</b> {b.client.importantNote}</div>}
              </td>
            </tr>
          )}
          {b.changeDeadline && <tr><th>Изменить сам клиент может до</th><td>{fmtDateTime(b.changeDeadline)} {b.status === 'active' && !b.canChange ? '(срок прошел)' : ''}</td></tr>}
          {b.cancellation && (
            <tr><th>Отмена</th><td>{b.cancellation.by === 'client' ? 'клиентом' : 'студией'}, {fmtDateTime(b.cancellation.at)}{b.cancellation.reason && `. Причина: ${b.cancellation.reason}`}</td></tr>
          )}
          {b.busyUntil && <tr><th>Мастер занят до (с уборкой)</th><td>{fmtTime(b.busyUntil)}</td></tr>}
          {b.createdBy && <tr><th>Создал</th><td>{b.createdBy.name} ({b.createdBy.role})</td></tr>}
          <tr><th>Версия</th><td>{b.version}</td></tr>
        </tbody>
      </table>
    </section>
  );
}

function Reschedule({ b, isAdmin, onDone }: { b: Booking; isAdmin: boolean; onDone: () => Promise<void> }) {
  const [masterId, setMasterId] = useState(b.master.id);
  const [date, setDate] = useState(() => {
    const d = studioDate(b.startsAt);
    return d < studioToday() ? studioToday() : d;
  });
  const [shownDate, setShownDate] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [time, setTime] = useState(fmtTime(b.startsAt));
  const [reason, setReason] = useState('');
  const [isOverbooking, setIsOverbooking] = useState(false);
  const [done, setDone] = useState(false);
  const action = useAction();

  // Мастера, которые выполняют все услуги записи, — администратор может передать запись другому.
  const services = b.items.map((i) => (i.quantity > 1 ? `${i.serviceId}:${i.quantity}` : i.serviceId)).join(',');
  const masters = useLoad(
    () => (isAdmin ? api.get<{ masters: Master[] }>('/api/masters', { services }) : Promise.resolve({ masters: [] })),
    [isAdmin, services],
  );
  const slots = useLoad(
    () => (shownDate ? api.get<SlotsResponse>(`/api/masters/${masterId}/slots`, { date: shownDate, bookingId: b.id }) : Promise.resolve(undefined)),
    [shownDate, masterId, b.id],
  );

  useEffect(() => {
    if (!hold) {
      setLeft(null);
      return;
    }
    const until = Date.now() + hold.secondsLeft * 1000;
    const tick = () => setLeft(Math.max(0, Math.round((until - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [hold]);

  // Клиент выбирает слот — время закрепляется за ним (бронь переноса); администратору бронь не нужна.
  const pick = async (startsAt: string) => {
    setPicked(startsAt);
    setDone(false);
    if (isAdmin) return;
    setHold(null);
    const res = await action.run(() => api.post<{ hold: Hold }>('/api/holds', { bookingId: b.id, startsAt }));
    if (res) setHold(res.hold);
  };

  const startsAt = isAdmin && !picked && time ? studioToUtc(date, time) : picked;

  const confirm = async () => {
    if (!startsAt) return;
    const res = await action.run(() => api.post<{ booking: Booking }>(`/api/bookings/${b.id}/reschedule`, {
      startsAt, version: b.version, reason: reason.trim() || null,
      ...(isAdmin && masterId !== b.master.id ? { masterId } : {}),
      ...(isAdmin ? { isOverbooking } : {}),
    }));
    if (res) {
      setDone(true);
      setPicked(null);
      setHold(null);
      setShownDate(null);
      await onDone();
    }
  };

  return (
    <section>
      <h2>Перенос</h2>
      <div className="row">
        {isAdmin && (
          <label>Мастер{' '}
            <select value={masterId} onChange={(e) => { setMasterId(Number(e.target.value)); setPicked(null); }}>
              {(masters.data?.masters.length ? masters.data.masters : [{ ...b.master } as Master]).map((m) => (
                <option key={m.id} value={m.id}>{m.name} ({LEVEL_LABELS[m.level]})</option>
              ))}
            </select>
          </label>
        )}
        <label>Дата <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <button type="button" onClick={() => { setShownDate(date); setPicked(null); }}>Показать свободное время</button>
      </div>
      <ErrorBox error={slots.error} />
      {shownDate && slots.data && (
        <>
          <p className="muted small">
            {shownDate}: {slots.data.slots.length} слотов, визит {minutes(slots.data.durationMin)}
            {slots.data.priceKop !== undefined && `, стоимость у этого мастера ${rub(slots.data.priceKop)}`}
            {slots.data.day?.reason && ` · ${slots.data.day.reason}`}
          </p>
          {slots.data.slots.length === 0 && <div className="warn">Свободного времени в этот день нет.</div>}
          <div className="slots">
            {slots.data.slots.map((s) => (
              <button key={s.startsAt} type="button" aria-pressed={picked === s.startsAt} onClick={() => pick(s.startsAt)}
                style={picked === s.startsAt ? { fontWeight: 'bold' } : undefined}>
                {fmtTime(s.startsAt)}
              </button>
            ))}
          </div>
        </>
      )}
      {isAdmin && (
        <>
          <p className="muted small">Или вручную (администратор, время студии):</p>
          <div className="row">
            <label>Время <input type="time" value={time} onChange={(e) => { setTime(e.target.value); setPicked(null); }} /></label>
            <label><input type="checkbox" checked={isOverbooking} onChange={(e) => setIsOverbooking(e.target.checked)} /> Наложение (поверх занятого времени)</label>
          </div>
        </>
      )}
      {!isAdmin && hold && left !== null && (
        left > 0
          ? <div className="ok">Новое время {fmtDateTime(hold.startsAt)} закреплено за вами еще {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</div>
          : <div className="warn">Время брони истекло. Выберите время заново.</div>
      )}
      <label>Причина переноса <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} style={{ width: '100%' }} /></label>
      {startsAt && <p>Было: {fmtDateTime(b.startsAt)} → Станет: <b>{fmtDateTime(startsAt)}</b></p>}
      <button type="button" onClick={confirm} disabled={action.busy || !startsAt || (!isAdmin && !hold)}>Перенести</button>
      <ErrorBox error={action.error} onPickAlternative={(a) => { if (isAdmin) setMasterId(a.masterId); void pick(a.startsAt); }} />
      {done && <div className="ok">Запись перенесена. Новая запись не создавалась — изменилось время этой.</div>}
    </section>
  );
}

function Cancel({ b, isAdmin, onDone }: { b: Booking; isAdmin: boolean; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [by, setBy] = useState<'client' | 'studio'>('studio');
  const [asking, setAsking] = useState(false);
  const action = useAction();

  const cancel = async () => {
    setAsking(false);
    const res = await action.run(() => api.post(`/api/bookings/${b.id}/cancel`, {
      reason: reason.trim() || null, version: b.version, ...(isAdmin ? { by } : {}),
    }));
    if (res) await onDone();
  };

  return (
    <section>
      <h2>Отмена</h2>
      {isAdmin && (
        <div className="row">
          <label><input type="radio" checked={by === 'studio'} onChange={() => setBy('studio')} /> Отменена студией</label>
          <label><input type="radio" checked={by === 'client'} onChange={() => setBy('client')} /> Отменена клиентом</label>
        </div>
      )}
      <label>Причина <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} style={{ width: '100%' }} /></label>
      {asking ? (
        <div className="row">
          Точно отменить запись?
          <button type="button" onClick={cancel} disabled={action.busy}>Да, отменить</button>
          <button type="button" onClick={() => setAsking(false)}>Нет</button>
        </div>
      ) : (
        <button type="button" onClick={() => setAsking(true)} disabled={action.busy}>Отменить запись</button>
      )}
      <ErrorBox error={action.error} />
    </section>
  );
}

function VisitResult({ b, onDone }: { b: Booking; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const action = useAction();
  const mark = async (status: 'completed' | 'no_show') => {
    const res = await action.run(() => api.post(`/api/bookings/${b.id}/status`, { status, reason: reason.trim() || null, version: b.version }));
    if (res) await onDone();
  };
  return (
    <section>
      <h2>Итог визита</h2>
      <label>Комментарий <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} style={{ width: '100%' }} /></label>
      <div className="row">
        <button type="button" onClick={() => mark('completed')} disabled={action.busy}>Визит завершен</button>
        <button type="button" onClick={() => mark('no_show')} disabled={action.busy}>Клиент не пришел</button>
      </div>
      <ErrorBox error={action.error} />
    </section>
  );
}

function History({ b }: { b: Booking }) {
  return (
    <section>
      <h2>История изменений</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Когда</th><th>Что</th><th>Кто</th><th>Изменения</th><th>Причина</th></tr></thead>
          <tbody>
            {b.events!.map((e, i) => (
              <tr key={i}>
                <td>{fmtDateTime(e.at)}</td>
                <td>{EVENT_LABELS[e.type] ?? e.type}</td>
                <td>{e.actor ? `${e.actor.name} (${e.actor.role})` : '—'}</td>
                <td>
                  {e.oldStatus !== undefined && e.oldStatus !== e.newStatus && <div>Статус: {statusLabel(e.oldStatus)} → {statusLabel(e.newStatus)}</div>}
                  {e.oldStartsAt && e.newStartsAt && <div>Время: {fmtDateTime(e.oldStartsAt)} → {fmtDateTime(e.newStartsAt)}</div>}
                  {e.oldMasterId !== undefined && e.oldMasterId !== e.newMasterId && <div>Мастер: №{e.oldMasterId} → №{e.newMasterId}</div>}
                  {e.oldTotalPriceKop !== undefined && <div>Сумма: {rub(e.oldTotalPriceKop)} → {rub(e.newTotalPriceKop)}</div>}
                </td>
                <td>{e.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
