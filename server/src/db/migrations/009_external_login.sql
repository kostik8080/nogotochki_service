-- migrator: foreign_keys=off
-- Миграция 009. Вход через внешний сервис — Яндекс (docs/db-schema.md, версия 18).
--
-- 1. Пароль у клиента становится необязательным не только «пока он не зарегистрировался сам»:
--    у клиента, который входит через Яндекс, пароля нет вообще. Поле password_hash допускало NULL
--    с самого начала (миграция 001), менять его тип не нужно — нужно отличать три состояния клиента:
--      password_hash IS NOT NULL                    — обычный вход по паролю;
--      password_hash IS NULL AND provider IS NULL    — карточка, которую завел администратор по телефону
--                                                      (сценарий 16): клиент еще не регистрировался;
--      password_hash IS NULL AND provider = 'yandex' — вход через Яндекс, пароля нет и не нужно.
--    Без этого различия «Забыли пароль?» и регистрация по телефону вели бы себя неправильно.
-- 2. Появляются provider и provider_id: какой внешний сервис подтвердил человека и его номер в этом
--    сервисе. Токен Яндекса не хранится: он нужен только на время запроса профиля, а дальше сервис
--    работает со своей сессией (sessions), как при обычном входе.
-- 3. Проверки задаются на уровне строки, а в SQLite их меняют только пересозданием таблицы —
--    как в миграции 003: новая таблица, копия строк, удаление старой, переименование.
--    Пометка в первой строке выключает на это время проверку внешних ключей.
--
-- Существующие строки не меняются: provider и provider_id у них пустые, и все прежние проверки
-- действуют как раньше.

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
  -- Внешний сервис входа. NULL — вход только по паролю, как раньше.
  provider               TEXT    CHECK (provider IS NULL OR provider IN ('yandex')),
  -- Номер учетной записи в этом сервисе: он не меняется, даже если человек сменил там адрес или имя.
  provider_id            TEXT,
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
  CHECK (role <> 'client' OR password_hash IS NULL OR pd_consent_at IS NOT NULL),
  -- Внешний сервис и номер в нем появляются вместе.
  CHECK ((provider IS NULL) = (provider_id IS NULL)),
  -- Через внешний вход выдается только роль «клиент»: сотрудник входит по паролю, и учетная запись
  -- с правами администратора или мастера по кнопке «Войти через Яндекс» получиться не может.
  CHECK (provider IS NULL OR role = 'client'),
  -- Пользователя внешнего входа сервис находит по e-mail, поэтому у него адрес есть всегда;
  -- при удалении аккаунта стираются оба поля сразу (решение 20).
  CHECK (provider IS NULL OR email IS NOT NULL)
) STRICT;

INSERT INTO users_new (
  id, role, name, phone, email, password_hash, provider, provider_id, phone_verified_at, email_verified_at,
  pd_consent_at, pd_consent_version, marketing_consent_at, failed_login_attempts,
  locked_until, blocked_at, deleted_at, created_at, updated_at
)
SELECT
  id, role, name, phone, email, password_hash, NULL, NULL, phone_verified_at, email_verified_at,
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
-- 2. Одна учетная запись Яндекса — один наш пользователь
-- ---------------------------------------------------------------------

-- Несколько NULL уникальный индекс допускает: у входа по паролю поля пустые.
CREATE UNIQUE INDEX users_provider_uq ON users (provider, provider_id);
