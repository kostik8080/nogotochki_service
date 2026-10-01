// Настройки сервера из переменных окружения. Перечень переменных — в server/.env.example.
// В production настройки проверяются при запуске: с неверными сервер не стартует.
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Папка server/ — от нее считаются относительные пути, откуда бы ни запускалась команда.
 * Ищется по package.json вверх от этого файла: код лежит в src/ при разработке и в dist/src/ после сборки.
 */
export const SERVER_ROOT = findServerRoot(import.meta.dirname);

function findServerRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`Не найден package.json сервера выше ${from}`);
  }
}

const envFile = path.join(SERVER_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** Значение переменной; пустая строка считается незаданной. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const nodeEnv = env('NODE_ENV') ?? 'development';
if (!['development', 'test', 'production'].includes(nodeEnv)) {
  throw new Error(`NODE_ENV=${nodeEnv}: допустимы development, test, production`);
}
const isProduction = nodeEnv === 'production';

const portRaw = env('PORT') ?? '3000';
const port = Number(portRaw);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT=${portRaw}: нужен номер порта от 1 до 65535`);
}

const trustProxyRaw = env('TRUST_PROXY') ?? '0';
if (!['0', '1'].includes(trustProxyRaw)) throw new Error(`TRUST_PROXY=${trustProxyRaw}: допустимы 0 и 1`);

const pdPolicyVersion = env('PD_POLICY_VERSION') ?? '2026-09-01';

const appUrl = (env('APP_URL') ?? `http://localhost:${port}`).replace(/\/+$/, '');
if (!/^https?:\/\/[^/\s]+/.test(appUrl)) throw new Error(`APP_URL=${appUrl}: нужен адрес вида https://nogotochki.ru`);

const smtpPortRaw = env('SMTP_PORT') ?? '587';
const smtpPort = Number(smtpPortRaw);
if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
  throw new Error(`SMTP_PORT=${smtpPortRaw}: нужен номер порта от 1 до 65535`);
}

// Заглушка входа через Яндекс (src/auth/yandex.ts). По умолчанию выключена, в production запрещена.
const yandexStubRaw = env('YANDEX_LOGIN_STUB') ?? '0';
if (!['0', '1'].includes(yandexStubRaw)) throw new Error(`YANDEX_LOGIN_STUB=${yandexStubRaw}: допустимы 0 и 1`);
const yandexLoginStub = yandexStubRaw === '1';
const yandexStubEmail = (env('YANDEX_STUB_EMAIL') ?? 'yandex-test@example.com').toLowerCase();
const yandexStubName = env('YANDEX_STUB_NAME') ?? 'Яна Тестовая';
// Адрес заглушки попадает в users.email, а база принимает только адрес в нижнем регистре с «@».
if (yandexLoginStub && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(yandexStubEmail)) {
  throw new Error(`YANDEX_STUB_EMAIL=${yandexStubEmail}: нужен адрес вида name@example.com`);
}

const backupKeepRaw = env('BACKUP_KEEP') ?? '14';
const backupKeep = Number(backupKeepRaw);
if (!Number.isInteger(backupKeep) || backupKeep < 1) {
  throw new Error(`BACKUP_KEEP=${backupKeepRaw}: нужно целое число от 1 — сколько последних копий хранить`);
}

export const config = {
  nodeEnv,
  isProduction,
  databasePath: path.resolve(SERVER_ROOT, env('DATABASE_PATH') ?? 'data/nogotochki.db'),
  /** Порт HTTP-сервера API. */
  port,
  /**
   * Сервер стоит за прокси (nginx, панель хостинга): IP клиента берется из X-Forwarded-For.
   * Без прокси заголовок подделывается клиентом, поэтому по умолчанию выключено.
   */
  trustProxy: trustProxyRaw === '1',
  /** Редакция политики обработки персональных данных, на которую клиент соглашается при регистрации. */
  pdPolicyVersion,
  /** Публичный адрес сервиса без «/» на конце: из него строятся ссылки в письмах. */
  appUrl,
  /**
   * Папка интерфейса web/. Из нее сервер берет страницы раздела администратора /admin и страницу «Этот раздел
   * только для администраторов»: их отдает сервер, потому что доступ к ним решает сессия (src/web/admin-pages.ts).
   */
  webDir: path.resolve(SERVER_ROOT, env('WEB_DIR') ?? '../web'),
  /** Папка фото работ. В базе хранится путь относительно нее (work_photos.file_path). */
  uploadsDir: path.resolve(SERVER_ROOT, env('UPLOADS_DIR') ?? 'uploads'),
  /** Почта для одноразовых кодов и ссылок. Без SMTP_HOST письма печатаются в консоль (только не в production). */
  smtp: {
    host: env('SMTP_HOST'),
    port: smtpPort,
    user: env('SMTP_USER'),
    password: env('SMTP_PASSWORD'),
    from: env('MAIL_FROM'),
  },
  backup: {
    dir: path.resolve(SERVER_ROOT, env('BACKUP_DIR') ?? 'backups'),
    keep: backupKeep,
  },
  /**
   * Вход через Яндекс. Приложение в Яндексе еще не зарегистрировано: сервис не опубликован, и постоянного
   * адреса, на который Яндекс вернет человека, у него нет. Пока вместо обращения к Яндексу работает
   * заглушка: она подставляет адрес и имя из этих настроек. Временное решение только для разработки —
   * в production сервер с ней не запускается (checkProductionConfig).
   */
  yandex: {
    loginStub: yandexLoginStub,
    stubEmail: yandexStubEmail,
    stubName: yandexStubName,
  },
  seed: {
    adminPassword: env('SEED_ADMIN_PASSWORD'),
    masterPassword: env('SEED_MASTER_PASSWORD'),
    clientPassword: env('SEED_CLIENT_PASSWORD'),
  },
};

if (isProduction) checkProductionConfig();

function checkProductionConfig(): void {
  const errors: string[] = [];

  // База и резервные копии — на постоянном диске: папку с кодом заменяют при каждом обновлении.
  checkPersistentPath('DATABASE_PATH', '/var/lib/nogotochki/nogotochki.db', errors);
  checkPersistentPath('BACKUP_DIR', '/var/backups/nogotochki', errors);
  // Фото работ — тоже на постоянном диске: загруженные файлы не должны пропасть при обновлении.
  checkPersistentPath('UPLOADS_DIR', '/var/lib/nogotochki/uploads', errors);
  if (config.backup.dir === path.dirname(config.databasePath)) {
    errors.push('BACKUP_DIR совпадает с папкой базы: храните копии в отдельной папке');
  }

  // Заглушка входа через Яндекс пускает в аккаунт по одной кнопке, без всякой проверки человека:
  // на сервере, доступном из интернета, это открытая дверь в чужой кабинет.
  if (config.yandex.loginStub) {
    errors.push('YANDEX_LOGIN_STUB=1 — заглушка входа через Яндекс: она пускает в аккаунт без проверки человека и нужна только для разработки. Уберите ее из окружения production');
  }

  if (config.seed.adminPassword || config.seed.masterPassword || config.seed.clientPassword) {
    errors.push('SEED_ADMIN_PASSWORD, SEED_MASTER_PASSWORD и SEED_CLIENT_PASSWORD нужны только для тестовых данных — уберите их из окружения production');
  }

  if (errors.length > 0) {
    throw new Error(`Настройки production неверны:\n  - ${errors.join('\n  - ')}`);
  }
}

function checkPersistentPath(name: string, example: string, errors: string[]): void {
  const value = env(name);
  if (!value) {
    errors.push(`${name} не задан: в production путь указывается явно, например ${example}`);
  } else if (!path.isAbsolute(value)) {
    errors.push(`${name}=${value}: нужен абсолютный путь, например ${example}`);
  } else if (isInside(SERVER_ROOT, value)) {
    errors.push(`${name}=${value}: путь внутри папки с кодом (${SERVER_ROOT}), вынесите его на постоянный диск`);
  }
}

/** Лежит ли путь внутри папки. Путь на другом диске Windows path.relative возвращает абсолютным. */
function isInside(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
