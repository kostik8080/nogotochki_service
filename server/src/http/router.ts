// Маршрутизатор: метод и шаблон пути (/api/bookings/:id) → обработчик.
// Отдельный фреймворк не нужен: у серверной сборки нет зависимостей (server/README.md),
// и так проще выкладка на хостинг без компилятора и доступа к npm.
import type { IncomingMessage } from 'node:http';
import type { Db } from '../db/connection.js';
import type { SessionUser } from '../auth/sessions.js';
import { HttpError } from './errors.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface Context {
  db: Db;
  req: IncomingMessage;
  /** Параметры пути: для /api/bookings/:id — { id: '42' }. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Тело запроса, разобранное из JSON; undefined, если тела нет. */
  body: unknown;
  /** Текущий момент. Один на весь запрос, чтобы проверки внутри запроса не расходились. */
  now: Date;
  /** Пользователь сессии; null — запрос без входа. */
  user: SessionUser | null;
  /** Что с cookie сессии: не было, действует, срок истек, недействительна. */
  sessionStatus: 'none' | 'ok' | 'expired' | 'invalid';
  /** IP клиента — для ограничения частоты запросов. */
  ip: string;
  /** Засчитать запрос в ограничение частоты; сверх лимита — 429. */
  limit(bucket: LimitBucket, key: string): void;
  /** Выставить cookie в ответе. */
  setCookie(value: string): void;
}

/** Ограничения частоты: вход, регистрация, создание брони. */
export type LimitBucket = 'login' | 'register' | 'hold';

export interface Result {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: Context) => Result | Promise<Result>;

interface Route {
  method: Method;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: Method, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    }) + '/?$');
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  get = (path: string, handler: Handler) => this.add('GET', path, handler);
  post = (path: string, handler: Handler) => this.add('POST', path, handler);
  patch = (path: string, handler: Handler) => this.add('PATCH', path, handler);
  put = (path: string, handler: Handler) => this.add('PUT', path, handler);
  delete = (path: string, handler: Handler) => this.add('DELETE', path, handler);

  /** Обработчик и параметры пути. 404 — пути нет, 405 — путь есть, но не с этим методом. */
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } {
    let pathExists = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1]!);
      });
      return { handler: route.handler, params };
    }
    if (pathExists) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается для этого адреса');
    throw new HttpError(404, 'NOT_FOUND', 'Такого адреса в API нет');
  }
}

/** Номер из пути (/api/bookings/:id). Не число — 404: такого ресурса нет. */
export function pathId(ctx: Context, key = 'id'): number {
  const raw = ctx.params[key] ?? '';
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, 'NOT_FOUND', 'Не найдено');
  return id;
}
