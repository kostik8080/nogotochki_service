// Чтение запроса и отправка ответа JSON поверх встроенного node:http.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './errors.js';

/** Больше тело запроса к этому API не бывает: услуги, комментарий, причина. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Тело запроса как JSON. Пустое тело — undefined. Другой Content-Type отклоняется (415):
 * HTML-форма с чужого сайта не может отправить application/json без разрешения CORS,
 * и это вторая защита от подделки запросов после SameSite у cookie сессии.
 */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'Слишком большой запрос');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;

  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(;|$)/i.test(type)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Тело запроса отправляется как application/json');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Тело запроса — не JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...(payload ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    // Ответы API содержат персональные данные: не кэшировать ни в браузере, ни в прокси.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Поврежденную cookie пропускаем: она просто не найдется.
    }
  }
  return cookies;
}
