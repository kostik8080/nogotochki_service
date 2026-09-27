// Локальный сервер для верстки из папки web/: отдает файлы как есть и проксирует /api на сервер API.
// Для браузера страница и API — один адрес, поэтому cookie сессии (HttpOnly, SameSite=Lax) работает без CORS.
// Это не сборщик: файлы не меняются. Зависимостей нет.
//
//   node tools/web-dev-server.mjs          # http://127.0.0.1:8090, API — http://127.0.0.1:3000
//   PORT=8091 API_URL=http://127.0.0.1:3001 node tools/web-dev-server.mjs
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT ?? 8090);
const API = new URL(process.env.API_URL ?? 'http://127.0.0.1:3000');

const TYPES = {
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
};

function proxy(req, res) {
  const upstream = http.request(
    { hostname: API.hostname, port: API.port, path: req.url, method: req.method, headers: { ...req.headers, host: API.host } },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'API_UNAVAILABLE', message: 'Сервер API не отвечает' } }));
  });
  req.pipe(upstream);
}

async function serveFile(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  // Только файлы внутри web/: адрес с «..» наружу не выпускаем.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return notFound(res);
  try {
    // Адрес без расширения — страница: письмо ведет на /reset-password?token=…, а файл — reset-password.html
    if (!path.extname(file) && !(await stat(file).catch(() => null))) file += '.html';
    let info = await stat(file);
    if (info.isDirectory()) {
      file = path.join(file, 'index.html');
      info = await stat(file);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    notFound(res);
  }
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Страница еще не сверстана или не существует');
}

http
  .createServer((req, res) => {
    if (req.url?.startsWith('/api/')) return proxy(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    serveFile(req, res);
  })
  // Явный IPv4: на Windows иначе сервер может слушать только [::1].
  .listen(PORT, '127.0.0.1', () => {
    console.log(`web/ — http://127.0.0.1:${PORT}, /api → ${API.origin}`);
  });
