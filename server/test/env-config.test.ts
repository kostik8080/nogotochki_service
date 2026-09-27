// Сторож правила «все окружение — через один файл» (требование 5: секреты только в .env,
// в репозитории — только .env.example).
//
// Проверяется три вещи, каждую из которых легко сломать незаметно:
//   1. process.env читается только в src/config.ts (и в тестовом хелпере — см. ниже).
//      Прямое обращение в обработчике обошло бы проверку значений при старте и не попало бы
//      в .env.example, то есть на новом сервере переменную просто забыли бы задать.
//   2. Каждая переменная, которую читает config.ts, описана в .env.example.
//   3. В .env.example нет переменных, которых никто не читает, — кроме TEST_*.
//
// Исключение TEST_*: пароли тестовых учетных записей читает test/helpers/api.ts, а не config.ts,
// и значения заполнены прямо в .env.example, чтобы npm test работал сразу после git clone.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SERVER_ROOT } from '../src/config.js';

/** Где process.env читать можно. Пути — от папки server/, с косой чертой в любую сторону. */
const ALLOWED_ENV_READERS = ['src/config.ts', 'test/helpers/api.ts'];
/** Переменные .env.example, которые читает не config.ts, а тесты. */
const TEST_ONLY_VARS = ['TEST_ADMIN_PASSWORD', 'TEST_MASTER_PASSWORD', 'TEST_CLIENT_PASSWORD'];

const CODE_DIRS = ['src', 'scripts', 'test'];
const CODE_EXTENSIONS = ['.ts', '.mjs', '.js'];

function codeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (CODE_EXTENSIONS.includes(path.extname(entry))) found.push(full);
    }
  };
  for (const dir of CODE_DIRS) walk(path.join(SERVER_ROOT, dir));
  return found;
}

const relative = (file: string) => path.relative(SERVER_ROOT, file).split(path.sep).join('/');
const read = (file: string) => readFileSync(file, 'utf8');

/**
 * Сам сторож: он называет `process.env` в тексте проверок, но не читает окружение.
 * Путь берется из import.meta, а не строкой, — иначе переименование файла тихо сняло бы исключение
 * (а список ALLOWED_ENV_READERS остался бы, и правило продолжило бы работать для остальных).
 */
const SELF = relative(import.meta.filename);

describe('переменные окружения', () => {
  it('process.env читается только в config.ts и в тестовом хелпере', () => {
    const files = codeFiles();
    assert.ok(files.length > 20, `найдено всего ${files.length} файлов — обход папок не работает`);

    const offenders = files
      .filter((file) => read(file).includes('process.env'))
      .map(relative)
      .filter((name) => name !== SELF && !ALLOWED_ENV_READERS.includes(name));

    assert.deepEqual(offenders, [],
      'прямое обращение к process.env: значение не будет проверено при старте и не попадет в .env.example. '
      + 'Добавьте переменную в src/config.ts и в .env.example, а здесь читайте config');
  });

  it('состав .env.example совпадает с тем, что читает код', () => {
    const configVars = [...read(path.join(SERVER_ROOT, 'src/config.ts')).matchAll(/\benv\('([A-Z_][A-Z0-9_]*)'\)/g)]
      .map((m) => m[1]!);
    const exampleVars = [...read(path.join(SERVER_ROOT, '.env.example')).matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)]
      .map((m) => m[1]!);

    assert.ok(configVars.length > 10, `в config.ts найдено ${configVars.length} переменных — регулярное выражение устарело`);

    const unique = (list: string[]) => [...new Set(list)].sort();
    const missing = unique(configVars).filter((name) => !exampleVars.includes(name));
    const extra = unique(exampleVars).filter((name) => !configVars.includes(name) && !TEST_ONLY_VARS.includes(name));

    assert.deepEqual(missing, [], 'код читает переменную, которой нет в .env.example: после git clone ее забудут задать');
    assert.deepEqual(extra, [],
      'в .env.example есть переменная, которой никто не читает: либо опечатка в имени, либо мертвая настройка. '
      + `Если ее читают тесты, добавьте имя в TEST_ONLY_VARS в ${relative(path.join(SERVER_ROOT, 'test/env-config.test.ts'))}`);
  });

  it('в .env.example нет заполненных секретов, кроме паролей для тестов', () => {
    const filled = [...read(path.join(SERVER_ROOT, '.env.example')).matchAll(/^([A-Z_][A-Z0-9_]*)=(.+)$/gm)]
      .map((m) => m[1]!)
      .filter((name) => !TEST_ONLY_VARS.includes(name));

    assert.deepEqual(filled, [],
      'в шаблоне .env.example заполнено значение: пароли, ключи и адреса задаются в .env, который не попадает в git');
  });
});
