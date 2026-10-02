// Первый администратор на новом сервере (src/db/bootstrap-admin.ts): учетная запись создается при
// запуске, но только если администраторов в базе еще нет. Проверяется и то, что повторный запуск
// ничего не меняет: иначе обновление сервиса сбрасывало бы пароль владельца студии.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { verifyPassword } from '../src/auth/password.js';
import { bootstrapAdmin } from '../src/db/bootstrap-admin.js';
import { type Db, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrator.js';

/** Чистая база, как на новом сервере: только схема, без тестовых данных. */
function freshDb(): Db {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

const admins = (db: Db) =>
  db.prepare("SELECT id, name, email, password_hash FROM users WHERE role = 'admin'").all() as unknown as
    { id: number; name: string; email: string; password_hash: string }[];

it('на чистой базе заводит администратора и придумывает пароль, если его не задали', () => {
  const db = freshDb();
  try {
    const result = bootstrapAdmin(db, { email: 'Admin@TopBroHuman.ru' });
    assert.equal(result.status, 'created');
    assert.equal(result.status === 'created' && result.email, 'admin@topbrohuman.ru', 'адрес приводится к нижнему регистру');
    const password = result.status === 'created' ? result.generatedPassword : undefined;
    assert.ok(password && password.length >= 12, 'пароль придуман и не короче 12 символов');

    const [admin] = admins(db);
    assert.equal(admins(db).length, 1);
    assert.match(admin!.password_hash, /^\$argon2id\$/, 'в базе только хеш пароля');
    assert.ok(verifyPassword(password!, admin!.password_hash), 'показанным паролем можно войти');
  } finally {
    db.close();
  }
});

it('повторный запуск ничего не меняет: пароль владельца не сбрасывается', () => {
  const db = freshDb();
  try {
    const first = bootstrapAdmin(db, { email: 'admin@topbrohuman.ru', password: 'parol-vladelca-1' });
    assert.equal(first.status, 'created');
    assert.equal(first.status === 'created' && first.generatedPassword, undefined, 'заданный пароль не печатается');
    const before = admins(db)[0]!.password_hash;

    // Перезапуск контейнера с теми же настройками и с другим паролем в настройках.
    assert.equal(bootstrapAdmin(db, { email: 'admin@topbrohuman.ru', password: 'sovsem-drugoj-parol' }).status, 'exists');
    assert.equal(bootstrapAdmin(db, { email: 'drugoj@topbrohuman.ru' }).status, 'exists');
    assert.equal(admins(db).length, 1);
    assert.equal(admins(db)[0]!.password_hash, before, 'хеш пароля не изменился');
  } finally {
    db.close();
  }
});

it('без ADMIN_EMAIL администратор не заводится, неверные настройки не создают учетную запись', () => {
  const db = freshDb();
  try {
    assert.equal(bootstrapAdmin(db, {}).status, 'skipped');
    assert.equal(bootstrapAdmin(db, { email: '   ' }).status, 'skipped');
    assert.equal(bootstrapAdmin(db, { email: 'не-адрес' }).status, 'invalid');
    assert.equal(bootstrapAdmin(db, { email: 'admin@topbrohuman.ru', password: 'korotkij' }).status, 'invalid');
    assert.equal(admins(db).length, 0);

    // Адрес занят клиентом: роль после создания не меняется, поэтому «повысить» его нельзя.
    db.prepare("INSERT INTO users (role, name, email, password_hash, pd_consent_at, pd_consent_version) VALUES ('client', 'Клиент', 'zanyato@topbrohuman.ru', ?, '2026-10-02T00:00:00.000Z', '2026-09-01')")
      .run('$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$' + 'x'.repeat(43));
    const taken = bootstrapAdmin(db, { email: 'zanyato@topbrohuman.ru' });
    assert.equal(taken.status, 'invalid');
    assert.equal(admins(db).length, 0);
  } finally {
    db.close();
  }
});
