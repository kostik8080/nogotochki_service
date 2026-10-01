// Запуск всего сервиса одной командой: сервер API и клиентский интерфейс в одном окне терминала.
//
//   node tools/dev.mjs            # API (3000) и интерфейс web/ (8090)
//   node tools/dev.mjs --draft    # и тестовый интерфейс web-draft/ (5173)
//
// Это не сборщик и не менеджер процессов: скрипт запускает ровно те же команды, что описаны
// в README, и показывает их вывод с пометкой, чей он. Ctrl+C останавливает все сразу.
// Зависимостей нет — как и у остального кода проекта.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withDraft = process.argv.includes('--draft');

/** Что запускаем. Команды — те же, что в README, чтобы их можно было выполнить и руками. */
const services = [
  { name: 'api', title: 'сервер API', command: 'npm start', cwd: path.join(ROOT, 'server'), port: 3000 },
  { name: 'web', title: 'интерфейс', command: 'node tools/web-dev-server.mjs', cwd: ROOT, port: 8090,
    open: 'http://127.0.0.1:8090' },
  ...(withDraft
    ? [{ name: 'draft', title: 'тестовый интерфейс', command: 'npm run dev', cwd: path.join(ROOT, 'web-draft'), port: 5173,
        open: 'http://127.0.0.1:5173' }]
    : []),
];

/**
 * Свободен ли порт — проверяется попыткой соединиться, а не занять его: на Windows адрес 127.0.0.1
 * удается занять и тогда, когда сервис уже слушает тот же порт на всех адресах.
 * Занятый порт — обычная ситуация: сервис уже запущен в другом окне.
 */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = connect({ host: '127.0.0.1', port, timeout: 1000 });
    const done = (free) => { probe.destroy(); resolve(free); };
    probe.once('connect', () => done(false));
    probe.once('error', () => done(true));
    probe.once('timeout', () => done(true));
  });
}

const busy = [];
for (const service of services) {
  if (!(await portFree(service.port))) busy.push(service);
}
if (busy.length > 0) {
  for (const service of busy) {
    console.error(`Порт ${service.port} занят — ${service.title} уже запущен в другом окне. Закройте его (Ctrl+C) и повторите.`);
  }
  process.exit(1);
}

const children = [];
let stopping = false;

/** Вывод дочернего процесса построчно с пометкой, чей он. */
function pipe(stream, name) {
  let rest = '';
  stream.on('data', (chunk) => {
    const lines = (rest + chunk.toString('utf8')).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) console.log(`[${name}] ${line}`);
  });
}

for (const service of services) {
  // shell: true — на Windows npm это npm.cmd, и без оболочки его не запустить.
  const child = spawn(service.command, { cwd: service.cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push({ ...service, child });
  pipe(child.stdout, service.name);
  pipe(child.stderr, service.name);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    // На Windows у снятого процесса код бывает вида 4294967295 — такой наружу не выводим.
    const reason = signal ? `сигнал ${signal}` : code === 0 ? 'штатно' : code > 0 && code < 256 ? `код ${code}` : 'с ошибкой';
    console.error(`\n[${service.name}] ${service.title} остановился (${reason}). Останавливаю остальное.`);
    stopAll(code === 0 ? 0 : 1);
  });
}

/** Остановить все и выйти. На Windows дочерние процессы npm живут своим деревом — их снимает taskkill. */
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGINT');
  }
  // Немного времени на то, чтобы процессы закрылись и освободили порты.
  setTimeout(() => process.exit(code), 500);
}

// Ctrl+C — это SIGINT; SIGBREAK приходит на Ctrl+Break и на taskkill без /F, SIGTERM — при закрытии окна.
for (const signal of ['SIGINT', 'SIGBREAK', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    console.log('\nОстанавливаю…');
    stopAll(0);
  });
}

console.log(`Запускаю: ${services.map((s) => `${s.title} (${s.port})`).join(', ')}`);
for (const service of services) {
  if (service.open) console.log(`Откройте ${service.open}${service.name === 'web' ? ' — клиентский интерфейс' : ''}`);
}
console.log('Ctrl+C — остановить все.\n');
