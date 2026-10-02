// Клиентский интерфейс из папки web/: лендинг, вход, регистрация, запись, кабинет и файлы
// css/, js/, img/, tokens.css. Их отдает сам сервер, поэтому сервис работает одним процессом:
// на сервере перед ним остается только HTTPS, без отдельной статики и без правил проксирования.
// При разработке ту же роль играет tools/web-dev-server.mjs — правила здесь те же.
//
// Чего эта отдача НЕ касается:
//   /api/… — это API, сюда запрос не попадает (src/app.ts);
//   web/admin/ и web/master/ — страницы разделов сотрудников. Их отдает src/web/admin-pages.ts
//     после проверки роли по сессии, и файлами отсюда они не отдаются никогда: иначе любой человек
//     открыл бы /admin/bookings.html напрямую и увидел бы разметку раздела мимо проверки прав.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Типы файлов интерфейса. Неизвестное расширение не отдается: в web/ таких файлов нет. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Папки, файлы которых отдает только сервер и только после проверки роли. */
const STAFF_DIRS = ['admin', 'master'];

export interface FileResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/**
 * Файл интерфейса по адресу страницы или `null`, если такого файла нет, — тогда запрос идет дальше
 * в маршруты API и получает обычный 404.
 */
export async function staticFile(req: { method: string; pathname: string; webDir: string }): Promise<FileResponse | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(req.pathname);
  } catch {
    // Неверная процентная последовательность в адресе: файла с таким именем все равно нет.
    return null;
  }
  // Обратный слэш на Windows разделяет папки, поэтому адрес с ним дальше не идет.
  if (pathname.includes('\\') || pathname.includes('\0')) return null;

  const root = path.resolve(req.webDir);
  let file = path.resolve(root, '.' + (pathname.startsWith('/') ? pathname : '/' + pathname));
  // Только файлы внутри web/: адрес с «..» наружу не выпускаем.
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  // Разделы сотрудников — мимо: /Admin/…, /%61dmin/… и прочие написания того же пути сюда не проходят,
  // потому что сравнивается уже разобранный путь, без учета регистра (на Windows он в именах не важен).
  const first = path.relative(root, file).split(path.sep)[0]?.toLowerCase();
  if (first !== undefined && STAFF_DIRS.includes(first)) return null;

  // Адрес без расширения — страница: ссылка из письма ведет на /reset-password?token=…, а файл — reset-password.html.
  if (!path.extname(file) && !(await exists(file))) file += '.html';
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = path.join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) return null;

  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;

  return {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(info.size),
      // Имена файлов интерфейса от версии к версии не меняются, поэтому долгий кеш отдавал бы
      // старую страницу после обновления: браузер каждый раз спрашивает, не изменился ли файл.
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
    body: req.method === 'HEAD' ? '' : await readFile(file),
  };
}

const exists = (file: string) => stat(file).then(() => true, () => false);
