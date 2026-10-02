// Первый администратор на новом сервере. Без него в только что развернутом сервисе некому завести
// услуги, мастеров и расписание: роль назначается только в базе, и через API ее получить нельзя.
//
// Правила:
//   учетная запись создается, только если администраторов в базе нет вообще — повторный запуск,
//     перезапуск контейнера и обновление ничего не трогают и пароль не возвращают к исходному;
//   пароль берется из ADMIN_PASSWORD, а если его нет — придумывается случайный и печатается
//     в журнал сервера один раз, при создании. В образ и в репозиторий он не попадает;
//   роль записана строкой в INSERT: из настроек она не читается.
//
// Дальше пароль меняется в профиле (POST /api/profile/password), а другие учетные записи сотрудников
// заводит сам администратор. Команда `admin:create` (scripts/admin-create.ts) остается для случая,
// когда администратора заводят руками в терминале.
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import { type Db, transaction } from './connection.js';

/** Паспорт: у администратора надежный пароль. Столько же требует команда admin:create. */
const MIN_PASSWORD_LENGTH = 12;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type BootstrapResult =
  /** Администратор уже есть — ничего не делали. */
  | { status: 'exists' }
  /** Не задан ADMIN_EMAIL: заводить администратора не из чего. */
  | { status: 'skipped' }
  /** Настройки неверны: администратора нет и он не создан. */
  | { status: 'invalid'; message: string }
  | { status: 'created'; email: string; /** Задан пароль не из настроек — его нужно показать один раз. */ generatedPassword?: string };

export function bootstrapAdmin(db: Db, options: { email?: string; password?: string }): BootstrapResult {
  const existing = db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND deleted_at IS NULL").get();
  if (existing) return { status: 'exists' };

  const email = options.email?.trim().toLowerCase();
  if (!email) return { status: 'skipped' };
  if (!EMAIL.test(email)) return { status: 'invalid', message: `ADMIN_EMAIL=${email}: нужен адрес вида admin@example.com` };
  if (options.password !== undefined && options.password.length < MIN_PASSWORD_LENGTH) {
    return { status: 'invalid', message: `ADMIN_PASSWORD короче ${MIN_PASSWORD_LENGTH} символов` };
  }
  // Адрес мог быть занят клиентом: роль после создания не меняется, поэтому «повысить» его нельзя.
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return { status: 'invalid', message: `ADMIN_EMAIL=${email}: этот адрес уже занят другой учетной записью` };
  }

  // Случайный пароль: 16 символов из 12 случайных байт. Он печатается один раз и нигде не хранится.
  const generated = options.password === undefined ? randomBytes(12).toString('base64url') : undefined;
  const password = options.password ?? generated!;

  transaction(db, () => {
    db.prepare("INSERT INTO users (role, name, email, password_hash) VALUES ('admin', ?, ?, ?)")
      .run('Администратор студии', email, hashPassword(password));
  });
  return { status: 'created', email, ...(generated ? { generatedPassword: generated } : {}) };
}
