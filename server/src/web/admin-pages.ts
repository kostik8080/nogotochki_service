// Страницы раздела администратора /admin (файлы web/admin/*.html). Их отдает сервер API, а не статический
// сервер: только он знает сессию и роли, поэтому доступ к разделу закрыт на сервере, а не только в интерфейсе.
//   гость или сессия истекла — 302 на общую форму входа с возвратом в раздел;
//   вошел, но роли администратора нет (клиент, мастер) — 403 и страница «Этот раздел только для администраторов»
//   (web/forbidden.html);
//   администратор — страница раздела.
// Доступ проверяет та же функция, что закрывает /api/admin/*, — requireAdmin (api/guards.ts): здесь ее 401
// становится входом, а 403 — страницей отказа. Своей проверки роли у страниц нет.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireAdmin, type SessionState } from '../api/guards.js';
import { HttpError } from '../http/errors.js';

/** Адрес раздела → файл в web/. Других страниц в разделе нет: неизвестный адрес — 404. */
const PAGES: Record<string, string> = {
  '/admin': 'admin/bookings.html',
  '/admin/services': 'admin/services.html',
  '/admin/services/form': 'admin/service-form.html',
  '/admin/masters': 'admin/masters.html',
  '/admin/masters/form': 'admin/master-card.html',
};

const FORBIDDEN_PAGE = 'forbidden.html';

export interface PageResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** Адрес относится к разделу администратора: /admin и все, что под ним. */
export function isAdminPagePath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
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

export async function adminPage(req: {
  method: string;
  pathname: string;
  /** Строка запроса страницы (?id=5): гость вернется после входа туда же. */
  search?: string;
  session: SessionState;
  webDir: string;
}): Promise<PageResponse> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Метод не поддерживается', { Allow: 'GET, HEAD' });

  // Сначала права, потом адрес: клиент не должен узнавать, какие страницы в разделе есть.
  const page = req.pathname.replace(/\/+$/, '');
  try {
    requireAdmin(req.session);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status === 401) {
      const search = /^\?[\w=&%.-]*$/.test(req.search ?? '') ? req.search ?? '' : '';
      const next = PAGES[page] ? page + search : '/admin';
      return { status: 302, headers: { ...NO_STORE, Location: `/login.html?next=${encodeURIComponent(next)}` }, body: '' };
    }
    return html(403, FORBIDDEN_PAGE, req.webDir);
  }

  const file = PAGES[page];
  if (!file) return text(404, 'Страница не найдена');
  return html(200, file, req.webDir);
}
