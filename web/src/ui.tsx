// Общие мелочи интерфейса: маршрут по hash, вывод ошибок API на странице, загрузка данных.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, fmtDateTime, fmtTime, type Alternative, type Studio, type User } from './api';

// ---------------------------------------------------------------------------
// Маршрут: #/путь?параметры
// ---------------------------------------------------------------------------

export interface Route {
  path: string;
  params: URLSearchParams;
}

const readRoute = (): Route => {
  const [path = '/', query = ''] = window.location.hash.replace(/^#/, '').split('?');
  return { path: path || '/', params: new URLSearchParams(query) };
};

export function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function go(path: string, params?: Record<string, string | number | undefined>): void {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') q.set(k, String(v));
  window.location.hash = q.size ? `${path}?${q}` : path;
}

// ---------------------------------------------------------------------------
// Сессия и студия — общие для всех страниц
// ---------------------------------------------------------------------------

export interface AppState {
  user: User | null;
  studio: Studio | null;
  refreshUser: () => Promise<void>;
}

export const AppContext = createContext<AppState>({ user: null, studio: null, refreshUser: async () => {} });
export const useApp = () => useContext(AppContext);

// ---------------------------------------------------------------------------
// Ошибки API — текстом на странице
// ---------------------------------------------------------------------------

/** Понятные пояснения к кодам, где одного текста сервера мало. */
const HINTS: Record<string, string> = {
  SLOT_TAKEN: 'Время уже занято другим клиентом или бронью. Выберите другое время.',
  HOLD_EXPIRED: 'Время брони истекло — время снова доступно другим. Закрепите его заново.',
  HOLD_NOT_FOUND: 'Брони на это время нет. Вернитесь к выбору времени и нажмите «Продолжить».',
  HOLD_MISMATCH: 'Бронь оформлена на другое время или состав визита. Закрепите время заново.',
  VERSION_CONFLICT: 'Запись изменил другой сотрудник. Обновите страницу, чтобы увидеть актуальные данные.',
  CHANGE_DEADLINE_PASSED: 'До визита меньше суток: изменить запись можно только через студию.',
  UNAUTHORIZED: 'Нужно войти в аккаунт.',
  SESSION_EXPIRED: 'Сессия истекла — войдите снова.',
};

export function ErrorBox({ error, onPickAlternative }: {
  error: unknown;
  /** Если передан, альтернативы из SLOT_TAKEN показываются кнопками. */
  onPickAlternative?: (alt: Alternative) => void;
}) {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return <div className="error">Ошибка: {error instanceof Error ? error.message : String(error)}</div>;
  }
  const hint = HINTS[error.code];
  return (
    <div className="error" role="alert">
      <div><b>{error.message}</b></div>
      {hint && hint !== error.message && <div>{hint}</div>}
      <div className="muted small">Код: {error.code}{error.status ? `, HTTP ${error.status}` : ''}</div>
      {error.fields.length > 0 && (
        <ul>{error.fields.map((f, i) => <li key={i}><code>{f.field}</code>: {f.message}</li>)}</ul>
      )}
      {error.code === 'SLOT_TAKEN' && error.alternatives.length > 0 && (
        <div>
          Ближайшее свободное время:
          <ul>
            {error.alternatives.map((a) => (
              <li key={`${a.masterId}-${a.startsAt}`}>
                {fmtDateTime(a.startsAt)}–{fmtTime(a.endsAt)} (мастер №{a.masterId}){' '}
                {onPickAlternative && <button type="button" onClick={() => onPickAlternative(a)}>Выбрать</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(error.code === 'UNAUTHORIZED' || error.code === 'SESSION_EXPIRED') && <a href="#/login">Войти</a>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Загрузка данных
// ---------------------------------------------------------------------------

/** Загружает данные при изменении deps; reload — загрузить заново. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await run());
    } catch (e) {
      // Прежние данные убираются: иначе под ошибкой остался бы предыдущий объект (например, другая запись).
      setData(undefined);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Выполняет действие с блокировкой кнопки и сохраняет ошибку для ErrorBox. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await action();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

export function Loading({ loading, children }: { loading: boolean; children?: ReactNode }) {
  return loading ? <p className="muted">Загрузка…</p> : <>{children}</>;
}

export function Json({ value }: { value: unknown }) {
  return (
    <details>
      <summary className="muted small">Ответ API (JSON)</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
