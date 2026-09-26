// HTTP-приложение API: разбирает запрос, находит сессию, вызывает обработчик и отвечает JSON.
// Сервер (src/server.ts) и тесты (test/api.test.ts) создают его одинаково: createApp(db).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { adminMasterRoutes } from './api/admin-masters.js';
import { adminServiceRoutes } from './api/admin-services.js';
import { authRoutes } from './api/auth.js';
import { bookingRoutes } from './api/bookings.js';
import { catalogRoutes } from './api/catalog.js';
import { holdRoutes } from './api/holds.js';
import { clearSessionCookie, findSession, SESSION_COOKIE } from './auth/sessions.js';
import type { Db } from './db/connection.js';
import { fromDatabaseError, HttpError } from './http/errors.js';
import { parseCookies, readJson, sendJson } from './http/io.js';
import { RateLimiter } from './http/rate-limit.js';
import { type Context, type LimitBucket, Router } from './http/router.js';

export interface AppOptions {
  /** Текущий момент; тесты подставляют свой. */
  now?: () => Date;
  /** Флаг Secure у cookie сессии — только по HTTPS. В production включен. */
  secureCookies?: boolean;
  /** Брать IP клиента из X-Forwarded-For (сервер за прокси). */
  trustProxy?: boolean;
  /** Ограничение частоты запросов; тесты его выключают. */
  rateLimit?: boolean;
  /** Куда писать непредвиденные ошибки. */
  logError?: (error: unknown) => void;
}

export interface App {
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Освободить память ограничителей частоты; вызывается периодической уборкой. */
  prune(now: Date): void;
}

export function createApp(db: Db, options: AppOptions = {}): App {
  const now = options.now ?? (() => new Date());
  const secureCookies = options.secureCookies ?? false;
  const logError = options.logError ?? ((error) => console.error(error));

  // Вход — 20 попыток в минуту с одного IP; регистрация — 10 в час; бронь — 30 в минуту на пользователя.
  const limiters: Record<LimitBucket, RateLimiter> = {
    login: new RateLimiter(20, 60_000),
    register: new RateLimiter(10, 3600_000),
    hold: new RateLimiter(30, 60_000),
  };

  const router = new Router();
  authRoutes(router, { secureCookies });
  catalogRoutes(router);
  holdRoutes(router);
  bookingRoutes(router);
  adminServiceRoutes(router);
  adminMasterRoutes(router);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cookies: string[] = [];
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const { handler, params } = router.match(method, url.pathname);
      const body = method === 'GET' ? undefined : await readJson(req);

      const at = now();
      const ctx: Context = {
        db, req, params, query: url.searchParams, body, now: at, user: null, sessionStatus: 'none',
        ip: clientIp(req, options.trustProxy ?? false),
        limit: (bucket, key) => {
          if (options.rateLimit !== false) limiters[bucket].hit(key, at.getTime());
        },
        setCookie: (value) => cookies.push(value),
      };

      const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (token) {
        const session = findSession(db, token, at);
        ctx.sessionStatus = session.status;
        if (session.status === 'ok') ctx.user = session.user;
        // Недействительную cookie браузер больше не присылает: так клиент сразу видит, что нужно войти.
        else cookies.push(clearSessionCookie(secureCookies));
      }

      const result = await handler(ctx);
      sendJson(res, result.status, result.body, { ...result.headers, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
    } catch (error) {
      const known = error instanceof HttpError ? error : fromDatabaseError(error);
      if (!known) logError(error);
      const e = known ?? new HttpError(500, 'INTERNAL_ERROR', 'Что-то пошло не так. Попробуйте еще раз');
      sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } }, {
        ...e.headers, ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
      });
    }
  }

  return {
    handle: (req, res) => {
      handle(req, res).catch((error) => {
        logError(error);
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Что-то пошло не так' } });
      });
    },
    prune: (at) => {
      for (const limiter of Object.values(limiters)) limiter.prune(at.getTime());
    },
  };
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
