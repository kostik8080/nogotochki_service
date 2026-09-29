// Страница 3: свободное время мастера на дату (GET /api/masters/:id/slots, GET /api/slots для «Любого мастера»).
// Клиент нажимает на слот — создается бронь (POST /api/holds, «Продолжить»), и открывается подтверждение.
// Администратор записывает без брони: слот сразу ведет на страницу создания записи.
import { useState } from 'react';
import {
  api, fmtTime, LEVEL_LABELS, minutes, parseServicesQuery, rub, servicesQuery, studioToday,
  type Catalog, type Hold, type Master, type Slot, type SlotsResponse,
} from '../api';
import { ErrorBox, go, Json, Loading, useAction, useApp, useLoad } from '../ui';

type VisitItems = { serviceId: number; quantity: number }[];

/** Выбор услуг визита по каталогу: основные — галочкой, опция — с количеством. */
function ServicePicker({ catalog, value, onChange }: {
  catalog: Catalog;
  value: VisitItems;
  onChange: (items: VisitItems) => void;
}) {
  const quantityOf = (id: number) => value.find((i) => i.serviceId === id)?.quantity ?? 0;
  const setQuantity = (id: number, quantity: number) => {
    const rest = value.filter((i) => i.serviceId !== id);
    onChange(quantity > 0 ? [...rest, { serviceId: id, quantity }] : rest);
  };
  return (
    <div>
      {catalog.categories.map((c) => (
        <div key={c.id}>
          <h3>{c.name}</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>№</th><th>Услуга</th><th>Длительность</th><th>Цена мастера</th><th>Цена топ-мастера</th></tr></thead>
              <tbody>
                {c.services.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.maxQuantity > 1 ? (
                        <input type="number" min={0} max={s.maxQuantity} style={{ width: 56 }} value={quantityOf(s.id)}
                          onChange={(e) => setQuantity(s.id, Math.max(0, Number(e.target.value) || 0))} />
                      ) : (
                        <input type="checkbox" checked={quantityOf(s.id) > 0} onChange={(e) => setQuantity(s.id, e.target.checked ? 1 : 0)} />
                      )}
                    </td>
                    <td>{s.id}</td>
                    <td>
                      {s.name}
                      {s.kind === 'addon' && <span className="muted small"> (опция{s.priceUnit ? `, цена ${s.priceUnit}` : ''}, до {s.maxQuantity})</span>}
                      {s.description && <div className="muted small">{s.description}</div>}
                    </td>
                    <td>{minutes(s.durationMin)}</td>
                    <td>от {rub(s.priceMasterKop)}</td>
                    <td>{rub(s.priceTopKop)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

const DAY_STATUS: Record<string, string> = {
  open: 'Рабочий день',
  studio_closed: 'Студия закрыта',
  master_off: 'У мастера выходной',
};

export function SlotsPage({ params }: { params: URLSearchParams }) {
  const { user } = useApp();
  const [items, setItems] = useState<VisitItems>(() => parseServicesQuery(params.get('services')));
  const [master, setMaster] = useState(params.get('master') ?? 'any');
  const [date, setDate] = useState(params.get('date') ?? studioToday());
  const [shown, setShown] = useState<{ master: string; date: string; services: string } | null>(
    params.get('services') ? { master, date, services: params.get('services')! } : null,
  );
  const query = servicesQuery(items);

  const catalog = useLoad(() => api.get<Catalog>('/api/services'), []);
  const masters = useLoad(
    () => (query ? api.get<{ masters: Master[] }>('/api/masters', { services: query }) : Promise.resolve({ masters: [] })),
    [query],
  );
  const slots = useLoad(async () => {
    if (!shown) return undefined;
    return shown.master === 'any'
      ? api.get<SlotsResponse>('/api/slots', { date: shown.date, services: shown.services })
      : api.get<SlotsResponse>(`/api/masters/${shown.master}/slots`, { date: shown.date, services: shown.services });
  }, [shown]);

  const hold = useAction();

  const show = () => {
    setShown({ master, date, services: query });
    go('/slots', { master, date, services: query });
  };

  // «Продолжить»: клиент закрепляет время за собой, администратор переходит к записи без брони.
  const pick = async (slot: Slot, masterId: number | null) => {
    if (!shown) return;
    const bookParams = {
      master: masterId ?? 'any', startsAt: slot.startsAt, services: shown.services,
      ...(shown.master === 'any' ? { any: 1 } : {}),
    };
    if (user?.role === 'admin') {
      go('/book', bookParams);
      return;
    }
    if (!user) {
      hold.setError(new Error('Чтобы закрепить время, войдите в аккаунт клиента.'));
      return;
    }
    const res = await hold.run(() => api.post<{ hold: Hold }>('/api/holds', {
      masterId, startsAt: slot.startsAt, services: parseServicesQuery(shown.services),
    }));
    if (res) go('/book', { ...bookParams, master: res.hold.masterId });
  };

  const masterName = (id: number) => slots.data?.masters?.find((m) => m.id === id)?.name
    ?? masters.data?.masters.find((m) => m.id === id)?.name ?? `№${id}`;

  return (
    <>
      <h1>Свободное время</h1>
      <section>
        <h2>1. Услуги визита</h2>
        <ErrorBox error={catalog.error} />
        <Loading loading={catalog.loading}>
          {catalog.data && <ServicePicker catalog={catalog.data} value={items} onChange={setItems} />}
        </Loading>
      </section>

      <section>
        <h2>2. Мастер и дата</h2>
        <ErrorBox error={masters.error} />
        <div className="row">
          <label>Мастер{' '}
            <select value={master} onChange={(e) => setMaster(e.target.value)}>
              <option value="any">Любой свободный мастер</option>
              {masters.data?.masters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({LEVEL_LABELS[m.level]}){m.visit ? ` — ${rub(m.visit.priceKop)}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>Дата <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <button type="button" onClick={show} disabled={!query}>Показать свободное время</button>
        </div>
        {!query && <p className="muted small">Сначала выберите хотя бы одну услугу.</p>}
        {query && masters.data?.masters.length === 0 && (
          <div className="warn">Ни один мастер не выполняет все выбранные услуги. Разделите их на несколько визитов.</div>
        )}
      </section>

      {shown && (
        <section>
          <h2>3. Свободное время на {shown.date}</h2>
          <ErrorBox error={slots.error} />
          <Loading loading={slots.loading}>
            {slots.data && (
              <>
                <p>
                  {slots.data.day && <>{DAY_STATUS[slots.data.day.status]}{slots.data.day.reason ? ` — ${slots.data.day.reason}` : ''}. </>}
                  Длительность визита: {minutes(slots.data.durationMin)}.
                  {slots.data.priceKop !== undefined && <> Стоимость: {rub(slots.data.priceKop)}.</>}
                  {' '}Часовой пояс: {slots.data.timezone}.
                </p>
                {slots.data.masters && (
                  <p className="muted small">
                    Подходящие мастера: {slots.data.masters.map((m) => `${m.name} (${rub(m.priceKop)})`).join(', ')}
                  </p>
                )}
                {slots.data.slots.length === 0 ? (
                  <div className="warn">Свободного времени в этот день нет. Выберите другую дату или мастера.</div>
                ) : (
                  <div className="slots">
                    {slots.data.slots.map((s) => (
                      <button key={s.startsAt} type="button" disabled={hold.busy}
                        title={s.masterIds ? `Свободны: ${s.masterIds.map(masterName).join(', ')}` : undefined}
                        onClick={() => pick(s, shown.master === 'any' ? (user?.role === 'admin' ? s.masterIds?.[0] ?? null : null) : Number(shown.master))}>
                        {fmtTime(s.startsAt)}–{fmtTime(s.endsAt)}
                        {s.masterIds && <span className="muted small"> ({s.masterIds.length})</span>}
                      </button>
                    ))}
                  </div>
                )}
                <p className="muted small">
                  {user?.role === 'admin'
                    ? 'Администратор: слот откроет создание записи без брони.'
                    : 'Нажатие на время закрепляет его за вами на 10 минут (бронь) и открывает подтверждение.'}
                </p>
                <ErrorBox error={hold.error} onPickAlternative={(a) => pick(a, a.masterId)} />
                <Json value={slots.data} />
              </>
            )}
          </Loading>
        </section>
      )}
    </>
  );
}
