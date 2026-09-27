// Страница 5: личный кабинет клиента — мои записи (GET /api/bookings).
// Если студия отменила или перенесла запись, показывается сообщение, пока клиент его не закроет
// (POST /api/bookings/:id/acknowledge).
import { useState } from 'react';
import { api, fmtDateTime, rub, STATUS_LABELS, type Booking, type BookingStatus } from '../api';
import { ErrorBox, Json, Loading, useAction, useApp, useLoad } from '../ui';

export function CabinetPage() {
  const { user } = useApp();
  const [status, setStatus] = useState<BookingStatus | ''>('');
  const [period, setPeriod] = useState<'' | 'upcoming' | 'past'>('');
  const list = useLoad(
    () => (user?.role === 'client'
      ? api.get<{ bookings: Booking[] }>('/api/bookings', { status, period })
      : Promise.resolve({ bookings: [] as Booking[] })),
    [status, period, user?.role],
  );
  const ack = useAction();

  if (!user) return <div className="error">Нужно <a href="#/login">войти</a>.</div>;
  if (user.role !== 'client') return <div className="error">Личный кабинет — для клиентов. {user.role === 'admin' ? 'Администратор видит записи в своем разделе.' : 'Мастер видит свои записи в разделе «Мое расписание».'}</div>;

  const acknowledge = async (id: number) => {
    if (await ack.run(() => api.post(`/api/bookings/${id}/acknowledge`))) await list.reload();
  };
  const bookings = list.data?.bookings ?? [];
  const banners = bookings.filter((b) => b.studioChange);

  return (
    <>
      <h1>Мои записи</h1>
      {banners.map((b) => (
        <div key={b.id} className="warn">
          Студия {b.studioChange!.type === 'cancelled' ? 'отменила' : 'перенесла'} запись №{b.id} ({fmtDateTime(b.startsAt)}, {b.master.name}).{' '}
          <button type="button" onClick={() => acknowledge(b.id)}>Закрыть</button>
        </div>
      ))}
      <ErrorBox error={ack.error} />
      <section>
        <div className="row">
          <label>Статус{' '}
            <select value={status} onChange={(e) => setStatus(e.target.value as BookingStatus | '')}>
              <option value="">все</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Период{' '}
            <select value={period} onChange={(e) => setPeriod(e.target.value as '' | 'upcoming' | 'past')}>
              <option value="">все</option>
              <option value="upcoming">предстоящие</option>
              <option value="past">прошедшие и отмененные</option>
            </select>
          </label>
          <a href="#/slots">+ Новая запись</a>
        </div>
      </section>
      <ErrorBox error={list.error} />
      <Loading loading={list.loading}>
        {bookings.length === 0 ? <p className="muted">Записей нет.</p> : <BookingsTable bookings={bookings} />}
        {list.data && <Json value={list.data} />}
      </Loading>
    </>
  );
}

export function BookingsTable({ bookings, admin = false }: { bookings: Booking[]; admin?: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>№</th><th>Когда</th><th>Мастер</th><th>Услуги</th><th>Сумма</th><th>Статус</th>
            {admin ? <th>Клиент</th> : <th>Изменить можно</th>}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {bookings.map((b) => (
            <tr key={b.id}>
              <td>{b.id}</td>
              <td>{fmtDateTime(b.startsAt)}</td>
              <td>{b.master.name}{b.isAnyMaster && <span className="muted small"> (любой)</span>}</td>
              <td>{b.items.map((i) => `${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`).join(', ')}</td>
              <td>{rub(b.totalPriceKop)}</td>
              <td>
                {STATUS_LABELS[b.status]}
                {b.isOverbooking && <div className="small"><b>наложение</b></div>}
                {b.cancellation?.reason && <div className="muted small">Причина: {b.cancellation.reason}</div>}
              </td>
              {admin ? (
                <td>{b.client?.name}<div className="muted small">{b.client?.phone ?? b.client?.email ?? ''}</div></td>
              ) : (
                <td>{b.canChange ? `да, до ${fmtDateTime(b.changeDeadline!)}` : 'нет'}</td>
              )}
              <td><a href={`#/bookings/${b.id}`}>Подробнее</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
