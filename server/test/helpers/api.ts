// Общее для тестов API: сервер поверх базы в памяти с тестовыми данными и клиент с cookie сессии.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { SERVER_ROOT } from '../../src/config.js';
import { type Db, openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrator.js';
import { seedDevData } from '../../src/db/seed/dev-seed.js';
import { addDays, isoWeekday, zonedDate, zonedTimeToUtc } from '../../src/lib/studio-time.js';
import { MemoryMailer } from '../../src/notify/mailer.js';

export const TZ = 'Europe/Moscow';

/**
 * Пароли тестовых учетных записей задаются переменными TEST_ADMIN_PASSWORD, TEST_MASTER_PASSWORD
 * и TEST_CLIENT_PASSWORD, а не строками в коде. Порядок: окружение (в том числе server/.env,
 * который подключает config.ts), затем server/.env.example — там они заполнены намеренно,
 * чтобы npm test работал сразу после git clone. Это не секрет: база тестов живет в памяти.
 */
function envFileValues(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) values[m[1]!] = m[2]!.trim();
  }
  return values;
}

const exampleEnv = envFileValues(path.join(SERVER_ROOT, '.env.example'));

function testPassword(name: string): string {
  const value = process.env[name]?.trim() || exampleEnv[name];
  if (!value || value.length < 8) {
    throw new Error(`Нет пароля для тестов: задайте ${name} в окружении или в server/.env.example (не короче 8 символов)`);
  }
  return value;
}

export const PASSWORDS = {
  adminPassword: testPassword('TEST_ADMIN_PASSWORD'),
  masterPassword: testPassword('TEST_MASTER_PASSWORD'),
  clientPassword: testPassword('TEST_CLIENT_PASSWORD'),
};

export const today = zonedDate(Date.now(), TZ);
/** Ближайшая дата с этим днем недели не раньше чем через minDays дней, минуя закрытый санитарный день. */
export function nextWeekday(weekday: number, minDays: number): string {
  let date = addDays(today, minDays);
  while (isoWeekday(date) !== weekday || date === '2026-09-29') date = addDays(date, 1);
  return date;
}
export const at = (date: string, time: string) => new Date(zonedTimeToUtc(date, time, TZ)).toISOString();

export interface Response {
  status: number;
  body: any;
  headers: Headers;
}

/** Клиент API с собственной cookie сессии — как отдельный браузер. */
export class Client {
  cookie: string | null = null;

  constructor(private readonly base: () => string) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const isBinary = body instanceof Uint8Array;
    const res = await fetch(this.base() + path, {
      method,
      // Перенаправление проверяют сами тесты (гостя со страниц /admin ведут на вход)
      redirect: 'manual',
      headers: {
        ...(body !== undefined && !isBinary ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBinary || typeof body === 'string' ? body as RequestInit['body'] : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      this.cookie = pair!.endsWith('=') ? null : pair!;
    }
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('application/json')) {
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body);
  patch = (path: string, body?: unknown) => this.request('PATCH', path, body);
  put = (path: string, body?: unknown) => this.request('PUT', path, body);
  delete = (path: string, body?: unknown) => this.request('DELETE', path, body);

  async login(login: string, password: string): Promise<this> {
    const res = await this.post('/api/auth/login', { login, password });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return this;
  }
}

export interface TestApi {
  db: Db;
  base: string;
  mailer: MemoryMailer;
  uploadsDir: string;
  client(): Client;
  close(): void;
}

/**
 * База в памяти со всеми миграциями и тестовыми данными, сервер на свободном порту, папка фото во временной папке.
 * mail: false — почта не настроена: коды и ссылки заменяет администратор.
 * rateLimit: true — включить ограничение частоты запросов. По умолчанию выключено: счетчики общие на
 * приложение, и тесты, которые к нему не относятся, глушили бы друг друга. Включает его rate-limit.test.ts,
 * и там на каждый счетчик поднимается отдельное приложение — иначе один тест выбирал бы лимит другого.
 */
export async function startApi(options: { mail?: boolean; rateLimit?: boolean } = {}): Promise<TestApi> {
  const db = openDatabase(':memory:');
  runMigrations(db);
  seedDevData(db, PASSWORDS);
  const mailer = new MemoryMailer();
  const uploadsDir = mkdtempSync(path.join(tmpdir(), 'nogotochki-uploads-'));
  const server = createServer(createApp(db, {
    rateLimit: options.rateLimit === true,
    mailer: options.mail === false ? null : mailer,
    appUrl: 'https://nogotochki.test',
    uploadsDir,
  }).handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db, base, mailer, uploadsDir,
    client: () => new Client(() => base),
    close: () => {
      server.close();
      db.close();
      rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}
