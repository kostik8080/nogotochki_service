// Обертка над REST API сервера (docs/api.md). Все запросы идут на тот же адрес (/api — прокси Vite),
// cookie сессии браузер присылает сам. Ошибка API превращается в ApiError с кодом, текстом и details,
// чтобы страница могла показать ее человеку, а не только в консоли.

export type Role = 'client' | 'admin' | 'master';
export type Level = 'master' | 'top_master';
export type BookingStatus = 'active' | 'cancelled_by_client' | 'cancelled_by_studio' | 'completed' | 'no_show';

export interface User {
  id: number;
  role: Role;
  name: string;
  phone: string | null;
  email: string | null;
  phoneVerified: boolean;
  emailVerified: boolean;
  marketingConsent: boolean;
}

export interface Studio {
  name: string;
  address: string;
  phone: string;
  timezone: string;
  hours: { weekday: number; open: string; close: string }[];
  rules: { slotStepMin: number; bookingHorizonDays: number; minLeadMin: number; clientChangeDeadlineHours: number; slotHoldMin: number };
  isMaintenance: boolean;
}

export interface CatalogService {
  id: number;
  kind: 'main' | 'addon';
  name: string;
  description: string | null;
  durationMin: number;
  priceMasterKop: number;
  priceTopKop: number;
  priceUnit: string | null;
  maxQuantity: number;
}

export interface Catalog {
  categories: { id: number; name: string; services: CatalogService[] }[];
  addonRules: { addonServiceId: number; mainServiceIds: number[] }[];
  incompatibilities: { serviceIds: [number, number]; reason: string }[];
}

export interface Master {
  id: number;
  name: string;
  level: Level;
  specialty: string | null;
  experienceYears: number | null;
  bio: string | null;
  serviceIds: number[];
  visit?: { durationMin: number; priceKop: number };
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  masterIds?: number[];
}

export interface SlotsResponse {
  date: string;
  timezone: string;
  day?: { status: 'open' | 'studio_closed' | 'master_off'; reason: string | null };
  durationMin: number;
  priceKop?: number;
  masters?: { id: number; name: string; level: Level; priceKop: number }[];
  slots: Slot[];
}

export interface Hold {
  id: number;
  masterId: number;
  startsAt: string;
  endsAt: string;
  bookingId: number | null;
  expiresAt: string;
  secondsLeft: number;
  master?: { id: number; name: string; level: Level };
  durationMin?: number;
  priceKop?: number;
}

export interface BookingEvent {
  type: string;
  at: string;
  actor: { id: number; name: string | null; role: Role | null } | null;
  oldStatus?: string | null;
  newStatus?: string | null;
  oldStartsAt?: string | null;
  newStartsAt?: string | null;
  oldMasterId?: number | null;
  newMasterId?: number | null;
  oldTotalPriceKop?: number;
  newTotalPriceKop?: number;
  reason: string | null;
}

export interface Booking {
  id: number;
  status: BookingStatus;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  master: { id: number; name: string; level: Level };
  isAnyMaster: boolean;
  items: { serviceId: number; name: string; quantity: number; durationMin: number; unitPriceKop?: number; priceKop?: number }[];
  comment: string | null;
  cancellation: { at: string; by: 'client' | 'studio'; reason: string | null } | null;
  version: number;
  totalPriceKop?: number;
  changeDeadline?: string;
  canChange?: boolean;
  studioChange?: { type: string; at: string } | null;
  client?: { id?: number; name: string; phone?: string | null; email?: string | null; importantNote?: string | null };
  busyUntil?: string;
  isOverbooking?: boolean;
  createdBy?: { id: number; name: string; role: Role };
  events?: BookingEvent[];
}

export interface Alternative {
  masterId: number;
  startsAt: string;
  endsAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** Ближайшие свободные слоты из ответа 409 SLOT_TAKEN. */
  get alternatives(): Alternative[] {
    const d = this.details as { alternatives?: Alternative[] } | undefined;
    return d?.alternatives ?? [];
  }

  /** Ошибки полей формы из ответа 400 VALIDATION_ERROR. */
  get fields(): { field: string; message: string }[] {
    const d = this.details as { fields?: { field: string; message: string }[] } | undefined;
    return d?.fields ?? [];
  }
}

type Query = Record<string, string | number | undefined | null>;

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const url = params.size > 0 ? `${path}?${params}` : path;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Сервер API не отвечает. Запущен ли он (npm start в папке server)?');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', `Сервер ответил не JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string; details?: unknown } } | undefined)?.error;
    const retry = res.headers.get('Retry-After');
    const message = (e?.message ?? `Ошибка HTTP ${res.status}`) + (retry ? ` (повторить через ${retry} с)` : '');
    throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, message, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// ---------------------------------------------------------------------------
// Форматирование: деньги в копейках, время в UTC → часовой пояс студии
// ---------------------------------------------------------------------------

let studioTimezone = 'Europe/Moscow';
export const setStudioTimezone = (tz: string) => {
  studioTimezone = tz;
};

export const rub = (kop: number | undefined) =>
  kop === undefined ? '—' : `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

export const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: studioTimezone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: studioTimezone, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));

/** Сегодняшняя дата студии в формате YYYY-MM-DD. */
export const studioToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: studioTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Дата и время студии (YYYY-MM-DD, HH:MM) → момент UTC в формате API. */
export function studioToUtc(date: string, time: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  // Смещение пояса в этот момент: сколько показывают часы студии минус UTC. Два шага — на случай перехода времени.
  const offsetAt = (t: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: studioTimezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t).toISOString();
}

/** Дата студии (YYYY-MM-DD) момента UTC. */
export const studioDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: studioTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export const minutes =(m: number) => (m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}` : `${m} мин`);

export const STATUS_LABELS: Record<BookingStatus, string> = {
  active: 'Активна',
  cancelled_by_client: 'Отменена клиентом',
  cancelled_by_studio: 'Отменена студией',
  completed: 'Завершена',
  no_show: 'Клиент не пришел',
};

export const LEVEL_LABELS: Record<Level, string> = { master: 'Мастер', top_master: 'Топ-мастер' };

export const ROLE_LABELS: Record<Role, string> = { client: 'Клиент', admin: 'Администратор', master: 'Мастер' };

/** Строка услуг визита для запроса: ?services=8,3:2. */
export const servicesQuery = (items: { serviceId: number; quantity: number }[]) =>
  items.map((i) => (i.quantity > 1 ? `${i.serviceId}:${i.quantity}` : String(i.serviceId))).join(',');

export const parseServicesQuery = (value: string | null): { serviceId: number; quantity: number }[] =>
  (value ?? '').split(',').filter(Boolean).map((part) => {
    const [id, qty] = part.split(':');
    return { serviceId: Number(id), quantity: qty ? Number(qty) : 1 };
  });
