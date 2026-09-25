-- migrator: foreign_keys=off
-- Миграция 003. Роль «мастер» (docs/db-schema.md, версия 11).
--
-- 1. В users.role добавляется 'master'. Список ролей задан ограничением CHECK, а его в SQLite можно
--    изменить только пересозданием таблицы: новая таблица, копия строк, удаление старой, переименование.
--    Пометка в первой строке говорит мигратору выключить на это время проверку внешних ключей
--    и проверить все ссылки перед фиксацией.
-- 2. Учетная запись мастера связывается с его профилем: masters.user_id.
-- 3. Триггеры: в masters.user_id — только пользователь с ролью «мастер»; бронь времени держат
--    только клиент и администратор.
--
-- Что мастер может делать в сервисе, в первой версии не определено: расписание по-прежнему ведет
-- администратор. Действовать от имени администратора или клиента мастер не может — это уже проверяют
-- триггеры ролей из миграции 001 (раздел 10.8).

-- ---------------------------------------------------------------------
-- 1. Пересоздание users
-- ---------------------------------------------------------------------

CREATE TABLE users_new (
  id                     INTEGER PRIMARY KEY,
  role                   TEXT    NOT NULL CHECK (role IN ('client', 'admin', 'master')),
  name                   TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  phone                  TEXT    UNIQUE
    CHECK (phone GLOB '+[0-9]*' AND phone NOT GLOB '+*[^0-9]*' AND length(phone) BETWEEN 8 AND 16),
  -- У колонки сравнение без учета регистра, поэтому проверка нижнего регистра явно побайтовая (COLLATE BINARY).
  email                  TEXT    UNIQUE COLLATE NOCASE
    CHECK (email = lower(email) COLLATE BINARY AND email LIKE '%_@_%'),
  -- Только хеш известного формата: открытый пароль база не примет (раздел 5.4, решение 36).
  password_hash          TEXT
    CHECK (password_hash IS NULL OR (
      (password_hash GLOB '$argon2id$*' OR password_hash GLOB '$2[aby]$*' OR password_hash GLOB 'pbkdf2-sha256$*')
      AND length(password_hash) >= 50)),
  phone_verified_at      TEXT CHECK (phone_verified_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  email_verified_at      TEXT CHECK (email_verified_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  pd_consent_at          TEXT CHECK (pd_consent_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  pd_consent_version     TEXT,
  marketing_consent_at   TEXT CHECK (marketing_consent_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  failed_login_attempts  INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until           TEXT CHECK (locked_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  blocked_at             TEXT CHECK (blocked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  deleted_at             TEXT CHECK (deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK ((pd_consent_at IS NULL) = (pd_consent_version IS NULL)),
  CHECK (deleted_at IS NOT NULL OR phone IS NOT NULL OR email IS NOT NULL),
  -- Администратор и мастер всегда входят по паролю. Клиента без пароля может завести администратор.
  CHECK (role = 'client' OR password_hash IS NOT NULL),
  CHECK (role <> 'client' OR password_hash IS NULL OR pd_consent_at IS NOT NULL)
) STRICT;

INSERT INTO users_new (
  id, role, name, phone, email, password_hash, phone_verified_at, email_verified_at,
  pd_consent_at, pd_consent_version, marketing_consent_at, failed_login_attempts,
  locked_until, blocked_at, deleted_at, created_at, updated_at
)
SELECT
  id, role, name, phone, email, password_hash, phone_verified_at, email_verified_at,
  pd_consent_at, pd_consent_version, marketing_consent_at, failed_login_attempts,
  locked_until, blocked_at, deleted_at, created_at, updated_at
FROM users;

DROP TABLE users;

-- Без legacy_alter_table переименование разбирает триггеры других таблиц, которые упоминают users,
-- и отказывается работать, пока таблицы users нет. Мигратор выключит флаг и при ошибке.
PRAGMA legacy_alter_table = ON;
ALTER TABLE users_new RENAME TO users;
PRAGMA legacy_alter_table = OFF;

-- Триггер на самой users удалился вместе со старой таблицей — создается заново (раздел 10.8).
CREATE TRIGGER users_role_immutable BEFORE UPDATE OF role ON users
WHEN NEW.role IS NOT OLD.role
BEGIN
  SELECT RAISE(ABORT, 'ROLE_IMMUTABLE');
END;

-- ---------------------------------------------------------------------
-- 2. Учетная запись мастера
-- ---------------------------------------------------------------------

-- NULL — у мастера нет учетной записи, как раньше: расписание ведет администратор.
ALTER TABLE masters ADD COLUMN user_id INTEGER REFERENCES users (id) ON DELETE RESTRICT;

-- Одна учетная запись — один мастер. Несколько NULL уникальный индекс допускает.
CREATE UNIQUE INDEX masters_user_uq ON masters (user_id);

-- ---------------------------------------------------------------------
-- 3. Роли по ссылке (раздел 10.8)
-- ---------------------------------------------------------------------

CREATE TRIGGER masters_role_insert BEFORE INSERT ON masters
WHEN NEW.user_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role <> 'master');
END;

CREATE TRIGGER masters_role_update BEFORE UPDATE OF user_id ON masters
WHEN NEW.user_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role <> 'master');
END;

-- Бронь времени держит клиент на сайте или администратор в панели записи (раздел 8), но не мастер.
CREATE TRIGGER slot_holds_owner_role_insert BEFORE INSERT ON slot_holds
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id AND role NOT IN ('client', 'admin'));
END;

CREATE TRIGGER slot_holds_owner_role_update BEFORE UPDATE OF owner_id ON slot_holds
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id AND role NOT IN ('client', 'admin'));
END;
