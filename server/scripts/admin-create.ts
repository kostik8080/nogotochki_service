// npm run admin:create (на сервере: npm run prod:admin:create) — создает учетную запись администратора.
// Имя, логин и пароль спрашиваются при запуске. Пароль не передается аргументом команды,
// чтобы не попасть в историю терминала и список процессов, и не хранится в .env.
// Можно подать ответы через stdin по одному в строке: имя, логин, пароль, повтор пароля.
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../src/auth/password.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';

/** Паспорт: у администратора надежный пароль. */
const MIN_PASSWORD_LENGTH = 12;

// Пока вводится пароль, эхо нажатых клавиш не выводится.
let muted = false;
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  },
});
const rl = readline.createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });
const lines = rl[Symbol.asyncIterator]();

async function ask(question: string, hidden = false): Promise<string> {
  process.stdout.write(question);
  muted = hidden;
  const { value, done } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  if (done) throw new Error('Ввод закончился раньше, чем были заданы все вопросы');
  return String(value).trim();
}

/** Логин — e-mail или телефон. Телефон приводится к формату базы: +79991234567. */
function parseLogin(login: string): { email: string | null; phone: string | null } {
  if (login.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) throw new Error(`«${login}» не похож на e-mail`);
    return { email: login.toLowerCase(), phone: null };
  }
  const phone = login.replace(/[\s()-]/g, '');
  if (!/^\+\d{7,15}$/.test(phone)) throw new Error(`«${login}»: телефон нужен в международном формате, например +79991234567`);
  return { email: null, phone };
}

async function main(): Promise<void> {
  const db = openDatabase();
  try {
    const hasSchema = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!hasSchema) throw new Error(`В базе ${config.databasePath} нет таблиц. Сначала примените миграции.`);

    console.log(`Новый администратор. База: ${config.databasePath}`);
    const name = await ask('Имя: ');
    if (!name) throw new Error('Имя не может быть пустым');
    const { email, phone } = parseLogin(await ask('E-mail или телефон для входа: '));

    const taken = db.prepare('SELECT role FROM users WHERE email = ? OR phone = ?').get(email, phone) as
      { role: string } | undefined;
    if (taken) {
      // Роль учетной записи не меняется (паспорт), поэтому клиента нельзя «повысить» до администратора.
      throw new Error(`Этот ${email ? 'e-mail' : 'телефон'} уже занят учетной записью с ролью ${taken.role}`);
    }

    const password = await ask(`Пароль (не короче ${MIN_PASSWORD_LENGTH} символов): `, true);
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Пароль короче ${MIN_PASSWORD_LENGTH} символов`);
    if ((await ask('Повторите пароль: ', true)) !== password) throw new Error('Пароли не совпадают');

    const id = db.prepare(`
      INSERT INTO users (role, name, email, phone, password_hash) VALUES ('admin', ?, ?, ?, ?)
    `).run(name, email, phone, hashPassword(password)).lastInsertRowid;
    console.log(`Администратор создан: ${name} (${email ?? phone}), id ${id}`);
  } finally {
    db.close();
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
