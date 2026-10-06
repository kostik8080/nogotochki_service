// Страницы разделов сотрудников: /admin (файлы web/admin/*.html) и /master (web/master/*.html).
// Их отдает сервер API, а не статический сервер: только он знает сессию и роли, поэтому доступ к разделам
// закрыт на сервере, а не только в интерфейсе.
//   гость или сессия истекла — 302 на общую форму входа с возвратом в раздел;
//   вошел, но нужной роли нет — 403 и страница отказа: web/forbidden.html для /admin,
//   web/forbidden-master.html для /master;
//   роль подходит — страница раздела.
// Доступ проверяют те же функции, что закрывают эндпоинты разделов: requireAdmin для /admin и
// requireRole(ctx, 'master') для /master (api/guards.ts). Своей проверки роли у страниц нет.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireAdmin, requireRole, type SessionState } from '../api/guards.js';
import { HttpError } from '../http/errors.js';

/** Адрес раздела → файл в web/. Других страниц в разделах нет: неизвестный адрес — 404. */
const ADMIN_PAGES: Record<string, string> = {
  '/admin': 'admin/bookings.html',
  '/admin/requests': 'admin/requests.html',
  '/admin/clients': 'admin/clients.html',
  '/admin/services': 'admin/services.html',
  '/admin/services/form': 'admin/service-form.html',
  '/admin/masters': 'admin/masters.html',
  '/admin/masters/form': 'admin/master-card.html',
  '/admin/settings': 'admin/settings.html',
};

/** Раздел мастера: свое расписание и свои заявки. Записи мастер не ведет (паспорт). */
const MASTER_PAGES: Record<string, string> = {
  '/master': 'master/schedule.html',
  '/master/requests': 'master/requests.html',
};

const FORBIDDEN_PAGE = 'forbidden.html';
const FORBIDDEN_MASTER_PAGE = 'forbidden-master.html';
/** SYS-01: тот же экран «Страница не найдена», что и на остальном сайте (web/static-files.ts). */
const NOT_FOUND_PAGE = 'not-found.html';

export interface PageResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** Адрес относится к разделу сотрудника: /admin или /master и все, что под ними. */
export function isStaffPagePath(pathname: string): boolean {
  return ['/admin', '/master'].some((root) => pathname === root || pathname.startsWith(root + '/'));
}

// Ответ зависит от сессии: ни браузер, ни прокси не должны его запоминать и отдавать другому человеку.
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie' };

async function html(status: number, file: string, webDir: string): Promise<PageResponse> {
  return {
    status,
    headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8' },
    body: await readFile(path.join(webDir, file)),
  };
}

const text = (status: number, message: string, headers: Record<string, string> = {}): PageResponse => ({
  status,
  headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  body: message,
});

export async function staffPage(req: {
  method: string;
  pathname: string;
  /** Строка запроса страницы (?id=5): гость вернется после входа туда же. */
  search?: string;
  session: SessionState;
  webDir: string;
}): Promise<PageResponse> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Метод не поддерживается', { Allow: 'GET, HEAD' });

  // Сначала права, потом адрес: чужой роли не нужно знать, какие страницы в разделе есть.
  const page = req.pathname.replace(/\/+$/, '');
  const master = page === '/master' || page.startsWith('/master/');
  const pages = master ? MASTER_PAGES : ADMIN_PAGES;
  try {
    if (master) requireRole(req.session, 'master');
    else requireAdmin(req.session);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status === 401) {
      const search = /^\?[\w=&%.-]*$/.test(req.search ?? '') ? req.search ?? '' : '';
      const next = pages[page] ? page + search : (master ? '/master' : '/admin');
      return { status: 302, headers: { ...NO_STORE, Location: `/login.html?next=${encodeURIComponent(next)}` }, body: '' };
    }
    return html(403, master ? FORBIDDEN_MASTER_PAGE : FORBIDDEN_PAGE, req.webDir);
  }

  const file = pages[page];
  // Сотрудник ошибся в адресе внутри своего раздела — тот же экран SYS-01, что и на остальном сайте,
  // а не голая строка текста. Файла нет — остается прежний короткий ответ.
  if (!file) return html(404, NOT_FOUND_PAGE, req.webDir).catch(() => text(404, 'Страница не найдена'));
  return html(200, file, req.webDir);
}
