// Проверка версии Node.js до запуска команд сервера. Подключается флагом:
//   node --import ./scripts/node-version.mjs dist/scripts/db-migrate.js
// Внутри самих команд проверять поздно: Node связывает все импорты до выполнения кода, и на старой
// версии команда упала бы на import { argon2Sync } или node:sqlite с непонятной ошибкой.
// Модуль, подключенный через --import, выполняется раньше. Требуемая версия — из engines в package.json.
// Код намеренно простой, без новых возможностей языка: он должен выполниться и на старом Node.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const range = pkg.engines && pkg.engines.node;
const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range || '');
if (!match) {
  throw new Error(`package.json: engines.node должно быть вида ">=24.7", сейчас ${JSON.stringify(range)}`);
}

const required = [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
const current = process.versions.node.split('.').map(Number);

let tooOld = false;
for (let i = 0; i < 3; i++) {
  if (current[i] > required[i]) break;
  if (current[i] < required[i]) { tooOld = true; break; }
}

if (tooOld) {
  console.error([
    `Нужен Node.js ${required.join('.')} или новее, установлен ${process.version}.`,
    `Установите последнюю версию ${required[0]}.x и запустите команду снова.`,
    `Сейчас запущен: ${process.execPath}`,
    'Подробности: docs/database.md, раздел 4.',
  ].join('\n'));
  process.exit(1);
}
