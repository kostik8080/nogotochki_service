// Страница 4: создание записи (POST /api/bookings).
// Клиент подтверждает запись по своей брони (GET /api/holds/current показывает, сколько брони осталось);
// когда бронь истекла, время можно закрепить заново. Администратор записывает без брони: за клиента из базы
// или за нового клиента по имени и телефону, при необходимости — поверх занятого времени (наложение).
import { useEffect, useState } from 'react';
import {
  api, fmtDateTime, fmtTime, LEVEL_LABELS, minutes, parseServicesQuery, rub, servicesQuery, studioDate, studioToUtc,
  type Booking, type Catalog, type Hold, type Master,
} from '../api';
import { ErrorBox, go, Json, Loading, useAction, useApp, useLoad } from '../ui';

export function BookPage({ params }: { params: URLSearchParams }) {
  const { user } = useApp();
  if (!user) return <div className="error">Чтобы записаться, <a href="#/login">войдите</a> в аккаунт.</div>;
  if (user.role === 'master') return <div className="error">Мастер не создает записи — это делает администратор.</div>;
  return user.role === 'admin' ? <AdminBook params={params} /> : <ClientBook params={params} />;
}

/** Состав визита и цены по мастерам — для сводки на странице подтверждения. */
function useVisitSummary(services: string) {
  const catalog = useLoad(() => api.get<Catalog>('/api/services'), []);
  const masters = useLoad(() => api.get<{ masters: Master[] }>('/api/masters', { services }), [services]);
  const items = parseServicesQuery(services);
  const all = catalog.data?.categories.flatMap((c) => c.services) ?? [];
  const lines = items.map((i) => `${all.find((s) => s.id === i.serviceId)?.name ?? `Услуга №${i.serviceId}`}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`);
  return { items, lines, masters: masters.data?.masters ?? [], error: catalog.error ?? masters.error };
}

function Summary({ lines, master, startsAt }: { lines: string[]; master: Master | undefined; startsAt: string }) {
  return (
    <table>
      <tbody>
        <tr><th>Услуги</th><td>{lines.join(', ')}</td></tr>
        <tr><th>Мастер</th><td>{master ? `${master.name} (${LEVEL_LABELS[master.level]})` : '—'}</td></tr>
        <tr><th>Дата и время</th><td>{fmtDateTime(startsAt)}{master?.visit && `–${fmtTime(new Date(Date.parse(startsAt) + master.visit.durationMin * 60_000).toISOString())}`}</td></tr>
        <tr><th>Длительность</th><td>{master?.visit ? minutes(master.visit.durationMin) : '—'}</td></tr>
        <tr><th>Стоимость</th><td>{master?.visit ? rub(master.visit.priceKop) : '—'}</td></tr>
      </tbody>
    </table>
  );
}

function Created({ booking }: { booking: Booking }) {
  return (
    <div className="ok">
      Запись №{booking.id} создана: {fmtDateTime(booking.startsAt)}, мастер {booking.master.name}, {rub(booking.totalPriceKop)}.{' '}
      <a href={`#/bookings/${booking.id}`}>Открыть запись</a>
      <Json value={booking} />
    </div>
  );
}

function ClientBook({ params }: { params: URLSearchParams }) {
  const services = params.get('services') ?? '';
  const [startsAt, setStartsAt] = useState(params.get('startsAt') ?? '');
  const isAnyMaster = params.get('any') === '1';
  const summary = useVisitSummary(services);
  const hold = useLoad(() => api.get<{ hold: Hold | null }>('/api/holds/current'), []);
  const [left, setLeft] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [created, setCreated] = useState<Booking | null>(null);
  const action = useAction();

  const current = hold.data?.hold ?? null;
  const matches = current !== null && current.startsAt === startsAt && current.bookingId === null;

  // Обратный отсчет брони по secondsLeft сервера, чтобы не зависеть от часов телефона.
  useEffect(() => {
    if (!current || !matches) {
      setLeft(null);
      return;
    }
    const until = Date.now() + current.secondsLeft * 1000;
    const tick = () => setLeft(Math.max(0, Math.round((until - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [current, matches]);

  const expired = left === 0 || (!hold.loading && !matches);
  const masterId = current?.masterId ?? Number(params.get('master'));
  const master = summary.masters.find((m) => m.id === masterId);

  // Сценарий 12: бронь истекла — проверить слот заново и закрепить еще раз.
  const rehold = async (at = startsAt, forMaster: number | null = isAnyMaster ? null : masterId) => {
    const res = await action.run(() => api.post<{ hold: Hold }>('/api/holds', { masterId: forMaster, startsAt: at, services: summary.items }));
    if (res) {
      setStartsAt(at);
      go('/book', { master: res.hold.masterId, startsAt: at, services, ...(isAnyMaster ? { any: 1 } : {}) });
      await hold.reload();
    }
  };

  const confirm = async () => {
    const res = await action.run(() => api.post<{ booking: Booking }>('/api/bookings', {
      masterId, startsAt, services: summary.items, comment: comment.trim() || null, isAnyMaster,
    }));
    if (res) setCreated(res.booking);
  };

  const leave = async () => {
    await action.run(() => api.del('/api/holds/current'));
    go('/slots', { master: isAnyMaster ? 'any' : masterId, date: studioDate(startsAt), services });
  };

  if (!services || !startsAt) return <div className="error">Не выбраны услуги или время. <a href="#/slots">Выбрать время</a></div>;
  if (created) return <><h1>Запись создана</h1><Created booking={created} /></>;

  return (
    <>
      <h1>Подтверждение записи</h1>
      <section>
        <ErrorBox error={summary.error} />
        <Summary lines={summary.lines} master={master} startsAt={startsAt} />
        {isAnyMaster && <p className="muted small">Вы выбрали «Любой свободный мастер» — мастера назначил сервис.</p>}
        <ErrorBox error={hold.error} />
        <Loading loading={hold.loading}>
          {!expired && left !== null && (
            <div className="ok">Время закреплено за вами еще {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</div>
          )}
          {expired && (
            <div className="warn">
              Время брони истекло или бронь не найдена — время снова доступно другим.{' '}
              <button type="button" onClick={() => rehold()} disabled={action.busy}>Проверить и закрепить заново</button>
            </div>
          )}
        </Loading>
        <label>Комментарий для мастера <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} /></label>
        <div className="row">
          <button type="button" onClick={confirm} disabled={action.busy}>Подтвердить запись</button>
          <button type="button" onClick={leave} disabled={action.busy}>Выйти из записи (снять бронь)</button>
        </div>
        <ErrorBox error={action.error} onPickAlternative={(a) => rehold(a.startsAt, a.masterId)} />
      </section>
    </>
  );
}

function AdminBook({ params }: { params: URLSearchParams }) {
  const services = params.get('services') ?? '';
  const isAnyMaster = params.get('any') === '1';
  const initial = params.get('startsAt');
  const summary = useVisitSummary(services);
  const [masterId, setMasterId] = useState(Number(params.get('master')) || 0);
  const [date, setDate] = useState(initial ? studioDate(initial) : '');
  const [time, setTime] = useState(initial ? fmtTime(initial) : '10:00');
  const [clientMode, setClientMode] = useState<'existing' | 'new'>('new');
  const [clientId, setClientId] = useState('');
  const [newClient, setNewClient] = useState({ name: '', phone: '' });
  const [comment, setComment] = useState('');
  const [isOverbooking, setIsOverbooking] = useState(false);
  const [created, setCreated] = useState<Booking | null>(null);
  const action = useAction();

  const startsAt = date && time ? studioToUtc(date, time) : '';
  const master = summary.masters.find((m) => m.id === masterId);

  const submit = async () => {
    const res = await action.run(() => api.post<{ booking: Booking }>('/api/bookings', {
      masterId, startsAt, services: summary.items, comment: comment.trim() || null, isAnyMaster, isOverbooking,
      ...(clientMode === 'existing' ? { clientId: Number(clientId) } : { newClient }),
    }));
    if (res) setCreated(res.booking);
  };

  if (!services) return <div className="error">Не выбраны услуги. <a href="#/slots">Выбрать услуги и время</a></div>;
  if (created) return <><h1>Запись создана</h1><Created booking={created} /></>;

  return (
    <>
      <h1>Новая запись (администратор)</h1>
      <section>
        <ErrorBox error={summary.error} />
        <div className="row">
          <label>Мастер{' '}
            <select value={masterId} onChange={(e) => setMasterId(Number(e.target.value))}>
              <option value={0}>— выберите —</option>
              {summary.masters.map((m) => <option key={m.id} value={m.id}>{m.name} ({LEVEL_LABELS[m.level]})</option>)}
            </select>
          </label>
          <label>Дата <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Время (студии) <input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        <p className="muted small">Время можно ввести вручную — например, занятое, чтобы проверить наложение.</p>
        {startsAt && <Summary lines={summary.lines} master={master} startsAt={startsAt} />}

        <h3>Клиент</h3>
        <div className="row">
          <label><input type="radio" checked={clientMode === 'new'} onChange={() => setClientMode('new')} /> Новый клиент без учетной записи</label>
          <label><input type="radio" checked={clientMode === 'existing'} onChange={() => setClientMode('existing')} /> Клиент из базы</label>
        </div>
        {clientMode === 'new' ? (
          <div className="row">
            <label>Имя <input value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} /></label>
            <label>Телефон <input value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} /></label>
          </div>
        ) : (
          <label>Номер клиента (id) <input value={clientId} onChange={(e) => setClientId(e.target.value)} inputMode="numeric" /></label>
        )}

        <label>Комментарий <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} /></label>
        <label>
          <input type="checkbox" checked={isOverbooking} onChange={(e) => setIsOverbooking(e.target.checked)} />{' '}
          Наложение: поставить поверх записи другого клиента или блокировки мастера
        </label>
        <button type="button" onClick={submit} disabled={action.busy || !masterId || !startsAt}>Создать запись</button>
        <ErrorBox error={action.error} onPickAlternative={(a) => {
          setMasterId(a.masterId);
          setDate(studioDate(a.startsAt));
          setTime(fmtTime(a.startsAt));
        }} />
        {action.error !== undefined && !isOverbooking && (action.error as { code?: string }).code === 'SLOT_TAKEN' && (
          <div className="warn">
            Время занято. Можно выбрать другое время выше или осознанно поставить запись поверх —{' '}
            <button type="button" onClick={() => setIsOverbooking(true)}>Отметить наложение</button> и создать запись еще раз.
          </div>
        )}
        <p className="muted small">Запрос услуг: <code>{servicesQuery(summary.items)}</code></p>
      </section>
    </>
  );
}
