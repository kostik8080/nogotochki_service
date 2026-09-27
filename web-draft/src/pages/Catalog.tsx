// Страница 2: каталог услуг и мастера (GET /api/services, GET /api/masters?services=…).
// Выбранные услуги можно сразу передать на страницу свободного времени.
import { useState } from 'react';
import { api, LEVEL_LABELS, minutes, rub, servicesQuery, type Catalog, type Master } from '../api';
import { ErrorBox, go, Json, Loading, useLoad } from '../ui';

export type VisitItems = { serviceId: number; quantity: number }[];

/** Выбор услуг визита по каталогу: основные — галочкой, опция — с количеством. */
export function ServicePicker({ catalog, value, onChange }: {
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

export function CatalogPage() {
  const [items, setItems] = useState<VisitItems>([]);
  const catalog = useLoad(() => api.get<Catalog>('/api/services'), []);
  const query = servicesQuery(items);
  const masters = useLoad(
    () => api.get<{ masters: Master[] }>('/api/masters', { services: query || undefined }),
    [query],
  );
  const serviceName = (id: number) =>
    catalog.data?.categories.flatMap((c) => c.services).find((s) => s.id === id)?.name ?? `№${id}`;

  return (
    <>
      <h1>Услуги и мастера</h1>
      <section>
        <h2>Каталог услуг</h2>
        <ErrorBox error={catalog.error} />
        <Loading loading={catalog.loading}>
          {catalog.data && (
            <>
              <ServicePicker catalog={catalog.data} value={items} onChange={setItems} />
              {catalog.data.addonRules.length > 0 && (
                <>
                  <h3>Опции</h3>
                  <ul>
                    {catalog.data.addonRules.map((r) => (
                      <li key={r.addonServiceId}>
                        «{serviceName(r.addonServiceId)}» добавляется к: {r.mainServiceIds.map(serviceName).join(', ')}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {catalog.data.incompatibilities.length > 0 && (
                <>
                  <h3>Несовместимые услуги</h3>
                  <ul>
                    {catalog.data.incompatibilities.map((p) => (
                      <li key={p.serviceIds.join('-')}>
                        {serviceName(p.serviceIds[0])} + {serviceName(p.serviceIds[1])}: <span className="muted">{p.reason}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <Json value={catalog.data} />
            </>
          )}
        </Loading>
      </section>

      <section>
        <h2>{items.length ? 'Мастера, которые выполняют все выбранные услуги' : 'Все мастера'}</h2>
        {items.length > 0 && <p className="muted small">Запрос: <code>GET /api/masters?services={query}</code></p>}
        <ErrorBox error={masters.error} />
        <Loading loading={masters.loading}>
          {masters.data && masters.data.masters.length === 0 && (
            <div className="warn">Ни один мастер не выполняет весь набор. Разделите услуги на несколько визитов.</div>
          )}
          {masters.data && masters.data.masters.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>№</th><th>Мастер</th><th>Уровень</th><th>Специализация</th><th>Услуги (№)</th>{items.length > 0 && <th>Визит</th>}<th></th></tr>
                </thead>
                <tbody>
                  {masters.data.masters.map((m) => (
                    <tr key={m.id}>
                      <td>{m.id}</td>
                      <td>{m.name}</td>
                      <td>{LEVEL_LABELS[m.level]}</td>
                      <td>{m.specialty ?? '—'}</td>
                      <td>{m.serviceIds.join(', ')}</td>
                      {items.length > 0 && <td>{m.visit ? `${rub(m.visit.priceKop)}, ${minutes(m.visit.durationMin)}` : '—'}</td>}
                      <td>
                        {items.length > 0 && (
                          <button type="button" onClick={() => go('/slots', { master: m.id, services: query })}>Свободное время</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {items.length > 0 && masters.data && masters.data.masters.length > 0 && (
            <p><button type="button" onClick={() => go('/slots', { master: 'any', services: query })}>Любой свободный мастер</button></p>
          )}
          {items.length === 0 && <p className="muted">Отметьте услуги выше, чтобы увидеть подходящих мастеров и цену визита.</p>}
        </Loading>
      </section>
    </>
  );
}
