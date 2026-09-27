// Отправка писем с одноразовыми кодами и ссылками (паспорт: e-mail — только для кодов; SMS в сервисе нет).
// SMTP-клиент написан на встроенных node:net и node:tls: у серверной сборки нет зависимостей.
// Умеет ровно то, что нужно для писем с кодами: TLS сразу (порт 465) или STARTTLS, вход AUTH PLAIN,
// одно письмо текстом в UTF-8 за соединение.
import { Socket, connect as connectTcp } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Для разработки: письмо печатается в консоль сервера вместо отправки. */
export class ConsoleMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    console.log(`\n[письмо] Кому: ${mail.to}\nТема: ${mail.subject}\n\n${mail.text}\n`);
  }
}

/** Для тестов: письма складываются в массив. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  from: string;
  /** Сколько ждать ответа сервера. */
  timeoutMs?: number;
  /** Разрешить соединение без шифрования с сервером не на этом компьютере (только для тестов). */
  allowInsecure?: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export class SmtpMailer implements Mailer {
  constructor(private readonly options: SmtpOptions) {}

  async send(mail: Mail): Promise<void> {
    const o = this.options;
    const implicitTls = o.port === 465;
    let socket: Socket | TLSSocket = implicitTls
      ? connectTls({ host: o.host, port: o.port, servername: o.host })
      : connectTcp({ host: o.host, port: o.port });
    let reader = new ReplyReader(socket, o.timeoutMs ?? 15_000);
    try {
      await reader.expect(220);
      let features = await command(socket, reader, `EHLO ${ehloName()}`, 250);

      if (!implicitTls) {
        if (/STARTTLS/i.test(features)) {
          await command(socket, reader, 'STARTTLS', 220);
          reader.detach();
          socket = await upgrade(socket as Socket, o.host);
          reader = new ReplyReader(socket, o.timeoutMs ?? 15_000);
          features = await command(socket, reader, `EHLO ${ehloName()}`, 250);
        } else if (!LOCAL_HOSTS.has(o.host) && !o.allowInsecure) {
          // Пароль почты и письма с кодами не передаются открытым текстом по сети.
          throw new Error(`SMTP ${o.host}: сервер не поддерживает STARTTLS — используйте порт 465 или другой сервер`);
        }
      }

      if (o.user) {
        const token = Buffer.from(`\0${o.user}\0${o.password ?? ''}`).toString('base64');
        await command(socket, reader, `AUTH PLAIN ${token}`, 235);
      }
      await command(socket, reader, `MAIL FROM:<${address(o.from)}>`, 250);
      await command(socket, reader, `RCPT TO:<${address(mail.to)}>`, [250, 251]);
      await command(socket, reader, 'DATA', 354);
      await command(socket, reader, message(o.from, mail), 250);
      socket.write('QUIT\r\n');
    } finally {
      reader.detach();
      socket.end();
    }
  }
}

/** Адрес из «Имя <адрес>» или сам адрес. Переводы строк запрещены: иначе в команду можно подставить свою. */
function address(value: string): string {
  const m = /<([^>]+)>/.exec(value);
  const result = (m ? m[1]! : value).trim();
  if (/[\r\n<>]/.test(result)) throw new Error('SMTP: недопустимый адрес');
  return result;
}

const ehloName = () => 'nogotochki.local';

/** Заголовок в UTF-8 по RFC 2047: тема письма на русском. */
const encodeHeader = (value: string) => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;

function message(from: string, mail: Mail): string {
  const body = Buffer.from(mail.text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    `From: ${from.replace(/[\r\n]/g, '')}`,
    `To: <${address(mail.to)}>`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '.',
  ].join('\r\n');
}

async function command(socket: Socket, reader: ReplyReader, line: string, expected: number | number[]): Promise<string> {
  socket.write(line + '\r\n');
  return reader.expect(expected);
}

function upgrade(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = connectTls({ socket, servername: host }, () => resolve(tls));
    tls.once('error', reject);
  });
}

/** Читает ответы SMTP-сервера: строки «250-…» продолжают ответ, «250 …» его завершают. */
class ReplyReader {
  private buffer = '';
  private lines: string[] = [];
  private waiting: { resolve: (reply: { code: number; text: string }) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString('utf8');
    let i: number;
    while ((i = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) this.finish();
    }
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new Error('SMTP: сервер закрыл соединение'));
  private replies: { code: number; text: string }[] = [];

  constructor(private readonly socket: Socket, private readonly timeoutMs: number) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  async expect(expected: number | number[]): Promise<string> {
    const reply = await this.next();
    const codes = Array.isArray(expected) ? expected : [expected];
    if (!codes.includes(reply.code)) throw new Error(`SMTP: ожидался ответ ${codes.join(' или ')}, получен ${reply.code} ${reply.text}`);
    return reply.text;
  }

  private finish(): void {
    const text = this.lines.join('\n');
    const reply = { code: Number(text.slice(0, 3)), text };
    this.lines = [];
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(reply);
    } else {
      this.replies.push(reply);
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(error);
    }
  }

  private next(): Promise<{ code: number; text: string }> {
    const ready = this.replies.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('SMTP: сервер не ответил вовремя')), this.timeoutMs);
      this.waiting = {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }
}
