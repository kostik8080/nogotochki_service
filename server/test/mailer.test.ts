// SMTP-клиент против учебного SMTP-сервера на localhost: порядок команд, вход, тема и текст в UTF-8.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, before, it } from 'node:test';
import { SmtpMailer } from '../src/notify/mailer.js';

let server: Server;
let port: number;
const commands: string[] = [];
let data = '';

before(async () => {
  server = createServer((socket) => {
    let buffer = '';
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
          } else {
            data += line + '\n';
          }
          continue;
        }
        commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.2', resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => server.close());

it('отправляет письмо: вход, отправитель, получатель, тема и текст в UTF-8', async () => {
  const mailer = new SmtpMailer({ host: '127.0.0.2', port, user: 'studio', password: 'secret', from: 'Ноготочки <noreply@nogotochki.test>', allowInsecure: true });
  await mailer.send({ to: 'maria@example.com', subject: 'Восстановление пароля', text: 'Ссылка: https://nogotochki.test/x' });

  assert.equal(commands[0], 'EHLO nogotochki.local');
  assert.equal(commands[1], `AUTH PLAIN ${Buffer.from('\0studio\0secret').toString('base64')}`);
  assert.equal(commands[2], 'MAIL FROM:<noreply@nogotochki.test>');
  assert.equal(commands[3], 'RCPT TO:<maria@example.com>');
  assert.match(data, /Subject: =\?UTF-8\?B\?/);
  const subject = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(data)![1]!;
  assert.equal(Buffer.from(subject, 'base64').toString(), 'Восстановление пароля');
  const body = data.split('\n\n')[1]!.replace(/\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString(), 'Ссылка: https://nogotochki.test/x');
});

it('не передает пароль открытым текстом на удаленный сервер без STARTTLS', async () => {
  // 127.0.0.2 — тот же компьютер, но не из списка локальных имен: для такого адреса клиент требует шифрования.
  const mailer = new SmtpMailer({ host: '127.0.0.2', port, from: 'noreply@nogotochki.test', timeoutMs: 2000 });
  await assert.rejects(mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), /STARTTLS/);
});

it('отклоняет адрес с переводом строки — подстановку своих команд', async () => {
  const mailer = new SmtpMailer({ host: '127.0.0.2', port, from: 'noreply@nogotochki.test', allowInsecure: true });
  await assert.rejects(mailer.send({ to: 'a@example.com>\r\nRCPT TO:<b@example.com', subject: 's', text: 't' }), /недопустимый адрес/);
});
