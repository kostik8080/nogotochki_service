// Страницы раздела администратора /admin (файлы web/admin/*.html). Их отдает сервер API, а не статический
// сервер: только он знает сессию и роли, поэтому доступ к разделу закрыт на сервере, а не только в интерфейсе.
//   гость или сессия истекла — 302 на общую форму входа с возвратом в раздел;
//   вошел, но роли администратора нет (клиент, мастер) — 403 и страница «Этот раздел только для администраторов»
//   (web/forbidden.html);
//   администратор — страница раздела.
// Роль проверяется наличием в списке ролей пользователя — той же функцией hasRole, что и в /api/admin/*.
// Данные страницы берут из /api/admin/*, которые сами проверяют роль (api/guards.ts, requireRole).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hasRole, type SessionUser } from '../auth/sessions.js';

/** Адрес раздела → файл в web/. Других страниц в разделе нет: неизвестный адрес — 404. */
const PAGES: Record<string, string> = {
  '/admin': 'admin/bookings.html',
  '/admin/services': 'admin/services.html',
  '/admin/masters': 'admin/masters.html',
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
  user: SessionUser | null;
  webDir: string;
}): Promise<PageResponse> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Метод не поддерживается', { Allow: 'GET, HEAD' });

  // Сначала права, потом адрес: клиент не должен узнавать, какие страницы в разделе есть.
  if (!req.user) {
    const next = PAGES[req.pathname.replace(/\/+$/, '')] ? req.pathname.replace(/\/+$/, '') : '/admin';
    return { status: 302, headers: { ...NO_STORE, Location: `/login.html?next=${encodeURIComponent(next)}` }, body: '' };
  }
  if (!hasRole(req.user, 'admin')) return html(403, FORBIDDEN_PAGE, req.webDir);

  const file = PAGES[req.pathname.replace(/\/+$/, '')];
  if (!file) return text(404, 'Страница не найдена');
  return html(200, file, req.webDir);
}
