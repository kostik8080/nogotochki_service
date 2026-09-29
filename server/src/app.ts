// HTTP-приложение API: разбирает запрос, находит сессию, вызывает обработчик и отвечает JSON.
// Сервер (src/server.ts) и тесты (test/api.test.ts) создают его одинаково: createApp(db).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { adminClientRoutes } from './api/admin-clients.js';
import { adminMasterRoutes } from './api/admin-masters.js';
import { adminScheduleRoutes } from './api/admin-schedule.js';
import { adminServiceRoutes } from './api/admin-services.js';
import { adminSettingsRoutes } from './api/admin-settings.js';
import { authRoutes } from './api/auth.js';
import { bookingRoutes } from './api/bookings.js';
import { catalogRoutes } from './api/catalog.js';
import { holdRoutes } from './api/holds.js';
import { masterRoutes } from './api/master.js';
import { passwordResetRoutes } from './api/password-reset.js';
import { photoRoutes } from './api/photos.js';
import { profileRoutes } from './api/profile.js';
import { clearSessionCookie, findSession, SESSION_COOKIE, type SessionUser } from './auth/sessions.js';
import { config } from './config.js';
import type { Db } from './db/connection.js';
import { fromDatabaseError, HttpError } from './http/errors.js';
import { parseCookies, readJson, readRaw, sendFile, sendJson } from './http/io.js';
import { RateLimiter } from './http/rate-limit.js';
import { type Context, type LimitBucket, Router, type Services } from './http/router.js';
import type { Mailer } from './notify/mailer.js';
import { adminPage, isAdminPagePath } from './web/admin-pages.js';

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
  /** Почта для кодов и ссылок; null — не настроена. */
  mailer?: Mailer | null;
  /** Публичный адрес сервиса для ссылок в письмах. */
  appUrl?: string;
  /** Папка фото работ. */
  uploadsDir: string;
  /** Папка интерфейса web/ — страницы раздела администратора /admin. По умолчанию из настроек (WEB_DIR). */
  webDir?: string;
}

export interface App {
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Освободить память ограничителей частоты; вызывается периодической уборкой. */
  prune(now: Date): void;
}

export function createApp(db: Db, options: AppOptions): App {
  const now = options.now ?? (() => new Date());
  const secureCookies = options.secureCookies ?? false;
  const logError = options.logError ?? ((error) => console.error(error));
  const webDir = options.webDir ?? config.webDir;
  const services: Services = {
    mailer: options.mailer ?? null,
    appUrl: options.appUrl ?? 'http://localhost:3000',
    uploadsDir: options.uploadsDir,
    secureCookies,
  };

  // Вход — 20 попыток в минуту с одного IP; регистрация — 10 в час; бронь — 30 в минуту на пользователя;
  // коды и ссылки (сброс пароля, подтверждение контактов) — 10 в час с одного IP.
  const limiters: Record<LimitBucket, RateLimiter> = {
    login: new RateLimiter(20, 60_000),
    register: new RateLimiter(10, 3600_000),
    hold: new RateLimiter(30, 60_000),
    code: new RateLimiter(10, 3600_000),
  };

  const router = new Router();
  authRoutes(router, { secureCookies });
  passwordResetRoutes(router);
  profileRoutes(router);
  catalogRoutes(router);
  holdRoutes(router);
  bookingRoutes(router);
  masterRoutes(router);
  photoRoutes(router);
  adminServiceRoutes(router);
  adminMasterRoutes(router);
  adminScheduleRoutes(router);
  adminClientRoutes(router);
  adminSettingsRoutes(router);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cookies: string[] = [];
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const at = now();

      let user: SessionUser | null = null;
      let sessionStatus: Context['sessionStatus'] = 'none';
      const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (token) {
        const session = findSession(db, token, at);
        sessionStatus = session.status;
        if (session.status === 'ok') user = session.user;
        // Недействительную cookie браузер больше не присылает: так клиент сразу видит, что нужно войти.
        else cookies.push(clearSessionCookie(secureCookies));
      }

      // Страницы раздела администратора: доступ решает сервер по сессии (web/admin-pages.ts).
      if (isAdminPagePath(url.pathname)) {
        const page = await adminPage({ method, pathname: url.pathname, user, webDir });
        res.writeHead(page.status, { ...page.headers, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
        res.end(method === 'HEAD' ? undefined : page.body);
        return;
      }

      const { handler, params, raw } = router.match(method, url.pathname);
      const ctx: Context = {
        db, req, params, query: url.searchParams, body: undefined, services, now: at, user, sessionStatus,
        ip: clientIp(req, options.trustProxy ?? false),
        limit: (bucket, key) => {
          if (options.rateLimit !== false) limiters[bucket].hit(key, at.getTime());
        },
        setCookie: (value) => cookies.push(value),
      };

      // Файл (фото) принимается только от вошедшего пользователя: без входа 10 МБ даже не читаются.
      if (raw) {
        if (!ctx.user) throw new HttpError(401, ctx.sessionStatus === 'expired' ? 'SESSION_EXPIRED' : 'UNAUTHORIZED', 'Нужно войти в аккаунт');
        ctx.rawBody = await readRaw(req, raw);
      } else if (method !== 'GET') {
        ctx.body = await readJson(req);
      }

      const result = await handler(ctx);
      if (result.file) sendFile(res, result.file.data, result.file.type, result.file.cache);
      else sendJson(res, result.status, result.body, { ...result.headers, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
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
