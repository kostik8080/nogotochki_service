// Страница 6: раздел администратора — все записи (GET /api/admin/bookings),
// услуги (/api/admin/services, категории, несовместимые пары) и мастера (/api/admin/masters, график, учетная запись).
import { useState, type FormEvent } from 'react';
import {
  api, fmtDateTime, LEVEL_LABELS, minutes, rub, STATUS_LABELS, studioToday,
  type Booking, type BookingStatus, type Level,
} from '../api';
import { ErrorBox, go, Json, Loading, useAction, useApp, useLoad } from '../ui';

/** Таблица записей: все записи, затронутые записи при смене графика. */
function BookingsTable({ bookings }: { bookings: Booking[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>№</th><th>Когда</th><th>Мастер</th><th>Услуги</th><th>Сумма</th><th>Статус</th><th>Клиент</th>
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
              <td>{b.client?.name}<div className="muted small">{b.client?.phone ?? b.client?.email ?? ''}</div></td>
              <td><a href={`#/bookings/${b.id}`}>Подробнее</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface AdminService {
  id: number;
  categoryId: number;
  kind: 'main' | 'addon';
  name: string;
  description: string | null;
  durationMin: number;
  cleanupMin: number;
  priceMasterKop: number;
  priceTopKop: number;
  priceUnit: string | null;
  maxQuantity: number;
  isFeatured: boolean;
  sortOrder: number;
  isActive: boolean;
  masterIds: number[];
  addonForServiceIds?: number[];
}

interface AdminServices {
  categories: { id: number; name: string; sortOrder: number; isActive: boolean }[];
  services: AdminService[];
  incompatibilities: { serviceIds: [number, number]; reason: string }[];
}

interface AdminMaster {
  id: number;
  name: string;
  level: Level;
  specialty: string | null;
  experienceYears: number | null;
  bio: string | null;
  isActive: boolean;
  serviceIds: number[];
  schedule: { weekday: number; validFrom: string; validTo: string | null; start: string; end: string }[];
  account: { userId: number; email: string | null; phone: string | null; isBlocked: boolean } | null;
}

const WEEKDAYS = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function AdminPage({ tab }: { tab: string }) {
  const { user } = useApp();
  if (!user) return <div className="error">Нужно <a href="#/login">войти</a> учетной записью администратора.</div>;
  if (user.role !== 'admin') return <div className="error">Раздел только для администратора.</div>;
  return (
    <>
      <h1>Администратор</h1>
      <div className="tabs">
        {[['bookings', 'Записи'], ['services', 'Услуги'], ['masters', 'Мастера']].map(([key, label]) => (
          <button key={key} type="button" aria-pressed={tab === key} onClick={() => go('/admin', { tab: key })}>{label}</button>
        ))}
      </div>
      {tab === 'bookings' && <BookingsTab />}
      {tab === 'services' && <ServicesTab />}
      {tab === 'masters' && <MastersTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Записи
// ---------------------------------------------------------------------------

function BookingsTab() {
  const [filters, setFilters] = useState({ dateFrom: studioToday(), dateTo: '', masterId: '', serviceId: '', status: '' as BookingStatus | '' });
  const [applied, setApplied] = useState(filters);
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const list = useLoad(
    () => api.get<{ total: number; bookings: Booking[] }>('/api/admin/bookings', { ...applied, limit, offset }),
    [applied, offset],
  );
  const refs = useLoad(() => Promise.all([
    api.get<{ masters: AdminMaster[] }>('/api/admin/masters'),
    api.get<AdminServices>('/api/admin/services'),
  ]), []);
  const set = (patch: Partial<typeof filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <>
      <section>
        <form className="row" onSubmit={(e) => { e.preventDefault(); setOffset(0); setApplied(filters); }}>
          <label>С <input type="date" value={filters.dateFrom} onChange={(e) => set({ dateFrom: e.target.value })} /></label>
          <label>по <input type="date" value={filters.dateTo} onChange={(e) => set({ dateTo: e.target.value })} /></label>
          <label>Мастер{' '}
            <select value={filters.masterId} onChange={(e) => set({ masterId: e.target.value })}>
              <option value="">все</option>
              {refs.data?.[0].masters.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>Услуга{' '}
            <select value={filters.serviceId} onChange={(e) => set({ serviceId: e.target.value })}>
              <option value="">все</option>
              {refs.data?.[1].services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>Статус{' '}
            <select value={filters.status} onChange={(e) => set({ status: e.target.value as BookingStatus | '' })}>
              <option value="">все</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button>Показать</button>
          <a href="#/slots">+ Новая запись</a>
        </form>
      </section>
      <ErrorBox error={refs.error} />
      <ErrorBox error={list.error} />
      <Loading loading={list.loading}>
        {list.data && (
          <>
            <p>Найдено: {list.data.total}{list.data.total > limit && `, показаны ${offset + 1}–${Math.min(offset + limit, list.data.total)}`}</p>
            {list.data.bookings.length > 0 && <BookingsTable bookings={list.data.bookings} />}
            <div className="row">
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>← Назад</button>
              <button type="button" disabled={offset + limit >= list.data.total} onClick={() => setOffset(offset + limit)}>Дальше →</button>
            </div>
            <Json value={list.data} />
          </>
        )}
      </Loading>
    </>
  );
}

// ---------------------------------------------------------------------------
// Услуги
// ---------------------------------------------------------------------------

const toRub = (kop: number) => String(kop / 100);
const toKop = (rubles: string) => Math.round(Number(rubles.replace(',', '.')) * 100);

interface ServiceForm {
  id: number | null;
  categoryId: number;
  kind: 'main' | 'addon';
  name: string;
  durationMin: string;
  cleanupMin: string;
  priceMaster: string;
  priceTop: string;
  priceUnit: string;
  maxQuantity: string;
  isActive: boolean;
  masterIds: number[];
  addonForServiceIds: number[];
}

const emptyService = (categoryId: number): ServiceForm => ({
  id: null, categoryId, kind: 'main', name: '', durationMin: '60', cleanupMin: '15', priceMaster: '', priceTop: '',
  priceUnit: '', maxQuantity: '1', isActive: true, masterIds: [], addonForServiceIds: [],
});

const toggle = (list: number[], id: number, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));

function ServicesTab() {
  const data = useLoad(() => api.get<AdminServices>('/api/admin/services'), []);
  const masters = useLoad(() => api.get<{ masters: AdminMaster[] }>('/api/admin/masters'), []);
  const [form, setForm] = useState<ServiceForm | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [pair, setPair] = useState({ a: 0, b: 0, reason: '' });
  const action = useAction();
  const [message, setMessage] = useState('');

  const d = data.data;
  const categoryOf = (id: number) => d?.categories.find((c) => c.id === id)?.name ?? `№${id}`;
  const serviceName = (id: number) => d?.services.find((s) => s.id === id)?.name ?? `№${id}`;
  const masterName = (id: number) => masters.data?.masters.find((m) => m.id === id)?.name ?? `№${id}`;

  const done = async (text: string) => {
    setMessage(text);
    await data.reload();
  };

  const edit = (s: AdminService) => setForm({
    id: s.id, categoryId: s.categoryId, kind: s.kind, name: s.name, durationMin: String(s.durationMin), cleanupMin: String(s.cleanupMin),
    priceMaster: toRub(s.priceMasterKop), priceTop: toRub(s.priceTopKop), priceUnit: s.priceUnit ?? '', maxQuantity: String(s.maxQuantity),
    isActive: s.isActive, masterIds: s.masterIds, addonForServiceIds: s.addonForServiceIds ?? [],
  });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setMessage('');
    const body: Record<string, unknown> = {
      categoryId: form.categoryId, name: form.name, durationMin: Number(form.durationMin), cleanupMin: Number(form.cleanupMin),
      priceMasterKop: toKop(form.priceMaster), priceTopKop: toKop(form.priceTop), priceUnit: form.priceUnit.trim() || null,
      maxQuantity: Number(form.maxQuantity), isActive: form.isActive, masterIds: form.masterIds,
      ...(form.kind === 'addon' ? { addonForServiceIds: form.addonForServiceIds } : {}),
    };
    const res = form.id === null
      ? await action.run(() => api.post('/api/admin/services', { ...body, kind: form.kind }))
      : await action.run(() => api.patch(`/api/admin/services/${form.id}`, body));
    if (res) {
      setForm(null);
      await done(form.id === null ? 'Услуга добавлена' : 'Услуга сохранена');
    }
  };

  const setActive = async (s: AdminService, isActive: boolean) => {
    setMessage('');
    if (await action.run(() => api.patch(`/api/admin/services/${s.id}`, { isActive }))) {
      await done(`«${s.name}» ${isActive ? 'включена' : 'отключена'}`);
    }
  };

  const addCategory = async (e: FormEvent) => {
    e.preventDefault();
    setMessage('');
    if (await action.run(() => api.post('/api/admin/service-categories', { name: categoryName }))) {
      setCategoryName('');
      await done('Категория добавлена');
    }
  };

  const addPair = async (e: FormEvent) => {
    e.preventDefault();
    setMessage('');
    if (await action.run(() => api.post('/api/admin/service-incompatibilities', { serviceIds: [pair.a, pair.b], reason: pair.reason }))) {
      setPair({ a: 0, b: 0, reason: '' });
      await done('Пара несовместимых услуг добавлена');
    }
  };

  const removePair = async (ids: [number, number]) => {
    setMessage('');
    // DELETE отвечает 204 без тела — успех отмечается явно.
    if (await action.run(async () => { await api.del(`/api/admin/service-incompatibilities/${ids[0]}/${ids[1]}`); return true; })) {
      await done('Пара удалена');
    }
  };

  return (
    <>
      <ErrorBox error={data.error} />
      <ErrorBox error={masters.error} />
      <ErrorBox error={action.error} />
      {message && <div className="ok">{message}</div>}
      <Loading loading={data.loading && !d}>
        {d && (
          <>
            <section>
              <div className="row">
                <h2 style={{ margin: 0 }}>Услуги</h2>
                <button type="button" disabled={d.categories.length === 0} onClick={() => setForm(emptyService(d.categories[0]?.id ?? 0))}>+ Услуга</button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>№</th><th>Категория</th><th>Название</th><th>Длит.</th><th>Уборка</th><th>Мастер</th><th>Топ</th><th>Мастера</th><th>Статус</th><th></th></tr>
                  </thead>
                  <tbody>
                    {d.services.map((s) => (
                      <tr key={s.id} className={s.isActive ? '' : 'inactive'}>
                        <td>{s.id}</td>
                        <td>{categoryOf(s.categoryId)}</td>
                        <td>
                          {s.name}
                          {s.kind === 'addon' && (
                            <div className="muted small">опция, до {s.maxQuantity}; к: {(s.addonForServiceIds ?? []).map(serviceName).join(', ') || '—'}</div>
                          )}
                        </td>
                        <td>{minutes(s.durationMin)}</td>
                        <td>{s.cleanupMin} мин</td>
                        <td>{rub(s.priceMasterKop)}</td>
                        <td>{rub(s.priceTopKop)}</td>
                        <td>{s.masterIds.map(masterName).join(', ') || '—'}</td>
                        <td>{s.isActive ? 'включена' : 'отключена'}</td>
                        <td>
                          <div className="row">
                            <button type="button" onClick={() => edit(s)}>Изменить</button>
                            <button type="button" disabled={action.busy} onClick={() => setActive(s, !s.isActive)}>{s.isActive ? 'Отключить' : 'Включить'}</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {form && (
              <section>
                <h2>{form.id === null ? 'Новая услуга' : `Услуга №${form.id}`}</h2>
                <form onSubmit={save}>
                  <div className="row">
                    <label>Категория{' '}
                      <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: Number(e.target.value) })}>
                        {d.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </label>
                    <label>Вид{' '}
                      <select value={form.kind} disabled={form.id !== null} onChange={(e) => setForm({ ...form, kind: e.target.value as 'main' | 'addon' })}>
                        <option value="main">основная</option>
                        <option value="addon">опция</option>
                      </select>
                    </label>
                  </div>
                  <label>Название <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: 320 }} /></label>
                  <div className="row">
                    <label>Длительность, мин <input value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: e.target.value })} size={5} /></label>
                    <label>Уборка, мин <input value={form.cleanupMin} onChange={(e) => setForm({ ...form, cleanupMin: e.target.value })} size={5} /></label>
                    <label>Цена мастера, ₽ <input value={form.priceMaster} onChange={(e) => setForm({ ...form, priceMaster: e.target.value })} size={7} /></label>
                    <label>Цена топ-мастера, ₽ <input value={form.priceTop} onChange={(e) => setForm({ ...form, priceTop: e.target.value })} size={7} /></label>
                  </div>
                  {form.kind === 'addon' && (
                    <div className="row">
                      <label>Единица цены <input value={form.priceUnit} onChange={(e) => setForm({ ...form, priceUnit: e.target.value })} placeholder="2 ногтя" /></label>
                      <label>Макс. количество <input value={form.maxQuantity} onChange={(e) => setForm({ ...form, maxQuantity: e.target.value })} size={4} /></label>
                    </div>
                  )}
                  <label><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Включена</label>
                  <div className="field">Мастера:{' '}
                    {masters.data?.masters.map((m) => (
                      <label key={m.id} style={{ display: 'inline-block', marginRight: 10 }}>
                        <input type="checkbox" checked={form.masterIds.includes(m.id)} onChange={(e) => setForm({ ...form, masterIds: toggle(form.masterIds, m.id, e.target.checked) })} /> {m.name}
                      </label>
                    ))}
                  </div>
                  {form.kind === 'addon' && (
                    <div className="field">Можно добавить к:{' '}
                      {d.services.filter((s) => s.kind === 'main').map((s) => (
                        <label key={s.id} style={{ display: 'inline-block', marginRight: 10 }}>
                          <input type="checkbox" checked={form.addonForServiceIds.includes(s.id)}
                            onChange={(e) => setForm({ ...form, addonForServiceIds: toggle(form.addonForServiceIds, s.id, e.target.checked) })} /> {s.name}
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="row">
                    <button disabled={action.busy}>Сохранить</button>
                    <button type="button" onClick={() => setForm(null)}>Отмена</button>
                  </div>
                </form>
              </section>
            )}

            <section>
              <h2>Категории</h2>
              <ul>{d.categories.map((c) => <li key={c.id} className={c.isActive ? '' : 'inactive'}>{c.id}. {c.name}{!c.isActive && ' (отключена)'}</li>)}</ul>
              <form className="row" onSubmit={addCategory}>
                <input value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder="Название категории" />
                <button disabled={action.busy}>+ Категория</button>
              </form>
            </section>

            <section>
              <h2>Несовместимые услуги</h2>
              <ul>
                {d.incompatibilities.map((p) => (
                  <li key={p.serviceIds.join('-')}>
                    {serviceName(p.serviceIds[0])} + {serviceName(p.serviceIds[1])}: <span className="muted">{p.reason}</span>{' '}
                    <button type="button" onClick={() => removePair(p.serviceIds)}>Убрать</button>
                  </li>
                ))}
              </ul>
              <form className="row" onSubmit={addPair}>
                {(['a', 'b'] as const).map((k) => (
                  <select key={k} value={pair[k]} onChange={(e) => setPair({ ...pair, [k]: Number(e.target.value) })}>
                    <option value={0}>— услуга —</option>
                    {d.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                ))}
                <input value={pair.reason} onChange={(e) => setPair({ ...pair, reason: e.target.value })} placeholder="Объяснение для клиента" />
                <button disabled={action.busy}>Добавить пару</button>
              </form>
            </section>
            <Json value={d} />
          </>
        )}
      </Loading>
    </>
  );
}

// ---------------------------------------------------------------------------
// Мастера
// ---------------------------------------------------------------------------

interface MasterForm {
  id: number | null;
  name: string;
  level: Level;
  specialty: string;
  experienceYears: string;
  bio: string;
  isActive: boolean;
  serviceIds: number[];
}

type WeekForm = Record<number, { on: boolean; start: string; end: string }>;

const defaultWeek = (): WeekForm => Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7].map((d) => [d, { on: d >= 2 && d <= 6, start: '10:00', end: '18:00' }]),
);

function MastersTab() {
  const data = useLoad(() => api.get<{ masters: AdminMaster[] }>('/api/admin/masters'), []);
  const services = useLoad(() => api.get<AdminServices>('/api/admin/services'), []);
  const [form, setForm] = useState<MasterForm | null>(null);
  const [scheduleFor, setScheduleFor] = useState<AdminMaster | null>(null);
  const [accountFor, setAccountFor] = useState<AdminMaster | null>(null);
  const [affected, setAffected] = useState<{ title: string; bookings: Booking[] } | null>(null);
  const [message, setMessage] = useState('');
  const action = useAction();

  const serviceName = (id: number) => services.data?.services.find((s) => s.id === id)?.name ?? `№${id}`;

  const done = async (text: string) => {
    setMessage(text);
    await data.reload();
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setMessage('');
    setAffected(null);
    const body = {
      name: form.name, level: form.level, specialty: form.specialty.trim() || null,
      experienceYears: form.experienceYears.trim() ? Number(form.experienceYears) : null,
      bio: form.bio.trim() || null, isActive: form.isActive, serviceIds: form.serviceIds,
    };
    type Saved = { master: AdminMaster; upcomingBookings?: Booking[] };
    const res = form.id === null
      ? await action.run(() => api.post<Saved>('/api/admin/masters', body))
      : await action.run(() => api.patch<Saved>(`/api/admin/masters/${form.id}`, body));
    if (res) {
      setForm(null);
      if (res.upcomingBookings?.length) {
        setAffected({ title: 'Мастер отключен. Предстоящие записи, которые нужно перенести или отменить:', bookings: res.upcomingBookings });
      }
      await done(form.id === null ? 'Мастер добавлен' : 'Мастер сохранен');
    }
  };

  const setActive = async (m: AdminMaster, isActive: boolean) => {
    setMessage('');
    setAffected(null);
    const res = await action.run(() => api.patch<{ upcomingBookings?: Booking[] }>(`/api/admin/masters/${m.id}`, { isActive }));
    if (res) {
      if (res.upcomingBookings?.length) setAffected({ title: `${m.name} отключен(а). Предстоящие записи, которые нужно перенести или отменить:`, bookings: res.upcomingBookings });
      await done(`${m.name}: ${isActive ? 'включен(а)' : 'отключен(а)'}`);
    }
  };

  return (
    <>
      <ErrorBox error={data.error} />
      <ErrorBox error={services.error} />
      <ErrorBox error={action.error} />
      {message && <div className="ok">{message}</div>}
      {affected && (
        <div className="warn">
          {affected.title}
          <BookingsTable bookings={affected.bookings} />
        </div>
      )}
      <Loading loading={data.loading && !data.data}>
        {data.data && (
          <section>
            <div className="row">
              <h2 style={{ margin: 0 }}>Мастера</h2>
              <button type="button" onClick={() => setForm({ id: null, name: '', level: 'master', specialty: '', experienceYears: '', bio: '', isActive: true, serviceIds: [] })}>+ Мастер</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>№</th><th>Имя</th><th>Уровень</th><th>Услуги</th><th>График</th><th>Учетная запись</th><th>Статус</th><th></th></tr></thead>
                <tbody>
                  {data.data.masters.map((m) => (
                    <tr key={m.id} className={m.isActive ? '' : 'inactive'}>
                      <td>{m.id}</td>
                      <td>{m.name}{m.specialty && <div className="muted small">{m.specialty}</div>}</td>
                      <td>{LEVEL_LABELS[m.level]}</td>
                      <td className="small">{m.serviceIds.map(serviceName).join(', ') || '—'}</td>
                      <td className="small">
                        {m.schedule.map((s, i) => (
                          <div key={i}>{WEEKDAYS[s.weekday]} {s.start}–{s.end} <span className="muted">с {s.validFrom}{s.validTo ? ` по ${s.validTo}` : ''}</span></div>
                        ))}
                      </td>
                      <td className="small">{m.account ? `${m.account.email ?? m.account.phone}${m.account.isBlocked ? ' (закрыт)' : ''}` : '—'}</td>
                      <td>{m.isActive ? 'активен' : 'отключен'}</td>
                      <td>
                        <div className="row">
                          <button type="button" onClick={() => setForm({
                            id: m.id, name: m.name, level: m.level, specialty: m.specialty ?? '', experienceYears: m.experienceYears?.toString() ?? '',
                            bio: m.bio ?? '', isActive: m.isActive, serviceIds: m.serviceIds,
                          })}>Изменить</button>
                          <button type="button" onClick={() => setScheduleFor(m)}>График</button>
                          {!m.account && <button type="button" onClick={() => setAccountFor(m)}>Учетная запись</button>}
                          <button type="button" disabled={action.busy} onClick={() => setActive(m, !m.isActive)}>{m.isActive ? 'Отключить' : 'Включить'}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </Loading>

      {form && (
        <section>
          <h2>{form.id === null ? 'Новый мастер' : `Мастер №${form.id}`}</h2>
          <form onSubmit={save}>
            <div className="row">
              <label>Имя <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label>Уровень{' '}
                <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value as Level })}>
                  <option value="master">Мастер</option>
                  <option value="top_master">Топ-мастер</option>
                </select>
              </label>
              <label>Специализация <input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} /></label>
              <label>Стаж, лет <input value={form.experienceYears} onChange={(e) => setForm({ ...form, experienceYears: e.target.value })} size={3} /></label>
            </div>
            <label>О мастере <textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></label>
            <label><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Активен</label>
            <div className="field">Услуги:{' '}
              {services.data?.services.map((s) => (
                <label key={s.id} style={{ display: 'inline-block', marginRight: 10 }}>
                  <input type="checkbox" checked={form.serviceIds.includes(s.id)} onChange={(e) => setForm({ ...form, serviceIds: toggle(form.serviceIds, s.id, e.target.checked) })} /> {s.name}
                </label>
              ))}
            </div>
            <div className="row">
              <button disabled={action.busy}>Сохранить</button>
              <button type="button" onClick={() => setForm(null)}>Отмена</button>
            </div>
          </form>
        </section>
      )}

      {scheduleFor && (
        <ScheduleForm master={scheduleFor} onClose={() => setScheduleFor(null)} onSaved={async (bookings) => {
          setAffected(bookings.length ? { title: `Записи ${scheduleFor.name}, которые не попадают в новый график:`, bookings } : null);
          setScheduleFor(null);
          await done('График сохранен');
        }} />
      )}

      {accountFor && (
        <AccountForm master={accountFor} onClose={() => setAccountFor(null)} onSaved={async () => {
          setAccountFor(null);
          await done('Учетная запись мастера создана');
        }} />
      )}
    </>
  );
}

function ScheduleForm({ master, onClose, onSaved }: { master: AdminMaster; onClose: () => void; onSaved: (affected: Booking[]) => Promise<void> }) {
  const [validFrom, setValidFrom] = useState(studioToday());
  const [week, setWeek] = useState<WeekForm>(defaultWeek);
  const [preview, setPreview] = useState<Booking[] | null>(null);
  const action = useAction();

  const send = async (dryRun: boolean) => {
    const days = Object.entries(week).filter(([, d]) => d.on).map(([weekday, d]) => ({ weekday: Number(weekday), start: d.start, end: d.end }));
    const res = await action.run(() => api.put<{ affectedBookings: Booking[] }>(`/api/admin/masters/${master.id}/schedule`, { validFrom, days, dryRun }));
    if (!res) return;
    if (dryRun) setPreview(res.affectedBookings);
    else await onSaved(res.affectedBookings);
  };

  return (
    <section>
      <h2>Новый график: {master.name}</h2>
      <label>Действует с <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></label>
      <table style={{ width: 'auto' }}>
        <tbody>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <tr key={d}>
              <td><label><input type="checkbox" checked={week[d]!.on} onChange={(e) => setWeek({ ...week, [d]: { ...week[d]!, on: e.target.checked } })} /> {WEEKDAYS[d]}</label></td>
              <td><input type="time" value={week[d]!.start} disabled={!week[d]!.on} onChange={(e) => setWeek({ ...week, [d]: { ...week[d]!, start: e.target.value } })} /></td>
              <td><input type="time" value={week[d]!.end} disabled={!week[d]!.on} onChange={(e) => setWeek({ ...week, [d]: { ...week[d]!, end: e.target.value } })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button type="button" disabled={action.busy} onClick={() => send(true)}>Проверить (какие записи не попадут)</button>
        <button type="button" disabled={action.busy} onClick={() => send(false)}>Сохранить график</button>
        <button type="button" onClick={onClose}>Закрыть</button>
      </div>
      <ErrorBox error={action.error} />
      {preview && (preview.length === 0
        ? <div className="ok">Все действующие записи попадают в новый график.</div>
        : <div className="warn">Не попадут в новый график: <BookingsTable bookings={preview} /></div>)}
    </section>
  );
}

function AccountForm({ master, onClose, onSaved }: { master: AdminMaster; onClose: () => void; onSaved: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { password, ...(email.trim() ? { email: email.trim() } : {}), ...(phone.trim() ? { phone: phone.trim() } : {}) };
    if (await action.run(() => api.post(`/api/admin/masters/${master.id}/account`, body))) await onSaved();
  };
  return (
    <section>
      <h2>Учетная запись мастера: {master.name}</h2>
      <form onSubmit={submit}>
        <div className="row">
          <label>E-mail <input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Телефон <input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <label>Пароль <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        </div>
        <div className="row">
          <button disabled={action.busy}>Создать</button>
          <button type="button" onClick={onClose}>Закрыть</button>
        </div>
      </form>
      <ErrorBox error={action.error} />
    </section>
  );
}
