// Общее для тестов API: сервер поверх базы в памяти с тестовыми данными и клиент с cookie сессии.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { type Db, openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrator.js';
import { seedDevData } from '../../src/db/seed/dev-seed.js';
import { addDays, isoWeekday, zonedDate, zonedTimeToUtc } from '../../src/lib/studio-time.js';
import { MemoryMailer } from '../../src/notify/mailer.js';
import { MemorySms } from '../../src/notify/sms.js';

export const TZ = 'Europe/Moscow';
export const PASSWORDS = { adminPassword: 'admin-password-1', masterPassword: 'master-password-1', clientPassword: 'client-password-1' };

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
  sms: MemorySms;
  uploadsDir: string;
  client(): Client;
  close(): void;
}

/**
 * База в памяти со всеми миграциями и тестовыми данными, сервер на свободном порту, папка фото во временной папке.
 * sms: false — SMS-шлюз не подключен, как сейчас в production.
 */
export async function startApi(options: { sms?: boolean } = {}): Promise<TestApi> {
  const db = openDatabase(':memory:');
  runMigrations(db);
  seedDevData(db, PASSWORDS);
  const mailer = new MemoryMailer();
  const sms = new MemorySms();
  const uploadsDir = mkdtempSync(path.join(tmpdir(), 'nogotochki-uploads-'));
  const server = createServer(createApp(db, {
    rateLimit: false, mailer, sms: options.sms === false ? null : sms, appUrl: 'https://nogotochki.test', uploadsDir,
  }).handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db, base, mailer, sms, uploadsDir,
    client: () => new Client(() => base),
    close: () => {
      server.close();
      db.close();
      rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}
