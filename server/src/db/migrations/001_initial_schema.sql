-- Миграция 001. Начальная схема базы по docs/db-schema.md, версия 10.
-- Номера разделов в комментариях — разделы этого документа.
--
-- Форматы (раздел 2), проверяются CHECK у каждого поля:
--   момент времени — 'YYYY-MM-DDTHH:MM:SS.sssZ' в UTC, поля *_at;
--   календарная дата — 'YYYY-MM-DD';
--   время по часам студии — 'HH:MM'.
-- Сначала создаются все таблицы, затем индексы, затем триггеры.

-- =====================================================================
-- Таблицы (раздел 5)
-- =====================================================================

-- 5.1. Настройки студии: ровно одна строка.
CREATE TABLE settings (
  id                            INTEGER PRIMARY KEY CHECK (id = 1),
  studio_name                   TEXT    NOT NULL,
  address                       TEXT    NOT NULL,
  phone                         TEXT    NOT NULL
    CHECK (phone GLOB '+[0-9]*' AND phone NOT GLOB '+*[^0-9]*' AND length(phone) BETWEEN 8 AND 16),
  map_url                       TEXT,
  vk_url                        TEXT,
  telegram_url                  TEXT,
  timezone                      TEXT    NOT NULL,
  slot_step_min                 INTEGER NOT NULL CHECK (slot_step_min > 0),
  booking_horizon_days          INTEGER NOT NULL CHECK (booking_horizon_days > 0),
  min_lead_min                  INTEGER NOT NULL CHECK (min_lead_min >= 0),
  client_change_deadline_hours  INTEGER NOT NULL CHECK (client_change_deadline_hours >= 0),
  slot_hold_min                 INTEGER NOT NULL CHECK (slot_hold_min BETWEEN 1 AND 60),
  is_maintenance                INTEGER NOT NULL DEFAULT 0 CHECK (is_maintenance IN (0, 1)),
  updated_at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

-- 5.2. Режим работы студии. Нет строки на день недели — студия в этот день закрыта.
CREATE TABLE studio_hours (
  weekday     INTEGER PRIMARY KEY CHECK (weekday BETWEEN 1 AND 7),
  open_time   TEXT    NOT NULL CHECK (open_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  close_time  TEXT    NOT NULL CHECK (close_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (close_time > open_time)
) STRICT;

-- 5.4. Учетные записи клиентов и администраторов.
CREATE TABLE users (
  id                     INTEGER PRIMARY KEY,
  role                   TEXT    NOT NULL CHECK (role IN ('client', 'admin')),
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
  CHECK (role <> 'admin' OR password_hash IS NOT NULL),
  CHECK (role <> 'client' OR password_hash IS NULL OR pd_consent_at IS NOT NULL)
) STRICT;

-- 5.3. Особые дни студии: важнее studio_hours, действуют на всех мастеров.
CREATE TABLE studio_day_overrides (
  work_date   TEXT    PRIMARY KEY CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  is_open     INTEGER NOT NULL CHECK (is_open IN (0, 1)),
  open_time   TEXT    CHECK (open_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  close_time  TEXT    CHECK (close_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  reason      TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  created_by  INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK ((is_open = 1 AND open_time IS NOT NULL AND close_time IS NOT NULL AND close_time > open_time)
      OR (is_open = 0 AND open_time IS NULL AND close_time IS NULL))
) STRICT;

-- 5.5. Карточка клиента, которую ведет администратор.
CREATE TABLE client_profiles (
  user_id             INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  birth_date          TEXT CHECK (birth_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  acquisition_source  TEXT,
  important_note      TEXT,
  blacklisted_at      TEXT CHECK (blacklisted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  blacklist_reason    TEXT,
  blacklisted_by      INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK ((blacklisted_at IS NULL) = (blacklist_reason IS NULL)
     AND (blacklisted_at IS NULL) = (blacklisted_by IS NULL))
) STRICT;

-- 5.9. Категории услуг.
CREATE TABLE service_categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

-- 5.10. Услуги и опции с ценами для двух уровней мастеров.
CREATE TABLE services (
  id                INTEGER PRIMARY KEY,
  category_id       INTEGER NOT NULL REFERENCES service_categories (id) ON DELETE RESTRICT,
  kind              TEXT    NOT NULL CHECK (kind IN ('main', 'addon')),
  name              TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  description       TEXT,
  cleanup_min       INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_min BETWEEN 0 AND 60),
  duration_min      INTEGER NOT NULL CHECK (duration_min > 0),
  price_master_rub  INTEGER NOT NULL CHECK (price_master_rub >= 0),
  price_top_rub     INTEGER NOT NULL,
  price_unit        TEXT,
  max_quantity      INTEGER NOT NULL DEFAULT 1 CHECK (max_quantity >= 1),
  photo_url         TEXT,
  is_featured       INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK (price_top_rub >= price_master_rub),
  CHECK (kind = 'addon' OR max_quantity = 1)
) STRICT;

-- 5.11. С какими основными услугами доступна опция. Тип услуг проверяет триггер 10.9.
CREATE TABLE service_addon_rules (
  addon_service_id  INTEGER NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  main_service_id   INTEGER NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  PRIMARY KEY (addon_service_id, main_service_id)
) STRICT;

-- 5.12. Несовместимые услуги: пара хранится одной строкой, меньший id первым.
CREATE TABLE service_incompatibilities (
  service_a_id  INTEGER NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  service_b_id  INTEGER NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  PRIMARY KEY (service_a_id, service_b_id),
  CHECK (service_a_id < service_b_id)
) STRICT;

-- 5.13. Мастера.
CREATE TABLE masters (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  level             TEXT    NOT NULL DEFAULT 'master' CHECK (level IN ('master', 'top_master')),
  specialty         TEXT,
  experience_years  INTEGER CHECK (experience_years >= 0),
  bio               TEXT,
  photo_url         TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

-- 5.14. Какие услуги выполняет мастер (включая опцию «Дизайн ногтей»).
CREATE TABLE master_services (
  master_id   INTEGER NOT NULL REFERENCES masters (id) ON DELETE RESTRICT,
  service_id  INTEGER NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  PRIMARY KEY (master_id, service_id)
) STRICT;

-- 5.15. Недельный график мастера с периодом действия. Непересечение периодов — триггер 10.6.
CREATE TABLE master_weekly_hours (
  master_id   INTEGER NOT NULL REFERENCES masters (id) ON DELETE RESTRICT,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  valid_from  TEXT    NOT NULL CHECK (valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  valid_to    TEXT    CHECK (valid_to GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  start_time  TEXT    NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time    TEXT    NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  PRIMARY KEY (master_id, weekday, valid_from),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (end_time > start_time)
) STRICT;

-- 5.16. Изменение графика мастера на конкретную дату.
CREATE TABLE master_day_overrides (
  master_id   INTEGER NOT NULL REFERENCES masters (id) ON DELETE RESTRICT,
  work_date   TEXT    NOT NULL CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  is_working  INTEGER NOT NULL CHECK (is_working IN (0, 1)),
  start_time  TEXT    CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time    TEXT    CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  created_by  INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (master_id, work_date),
  CHECK ((is_working = 1 AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
      OR (is_working = 0 AND start_time IS NULL AND end_time IS NULL))
) STRICT;

-- 5.17. Блокировки времени мастера. Их можно удалять: это график, а не история.
CREATE TABLE time_blocks (
  id          INTEGER PRIMARY KEY,
  master_id   INTEGER NOT NULL REFERENCES masters (id) ON DELETE RESTRICT,
  block_type  TEXT    NOT NULL
    CHECK (block_type IN ('lunch', 'personal', 'day_off', 'vacation', 'sick_leave', 'other')),
  starts_at   TEXT    NOT NULL
    CHECK (starts_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  ends_at     TEXT    NOT NULL
    CHECK (ends_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  comment     TEXT,
  created_by  INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK (ends_at > starts_at),
  CHECK (block_type <> 'other' OR comment IS NOT NULL)
) STRICT;

-- 5.19. Записи. Не удаляются (триггер 10.2), перенос меняет эту же строку.
CREATE TABLE bookings (
  id                      INTEGER PRIMARY KEY,
  client_id               INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  master_id               INTEGER NOT NULL REFERENCES masters (id) ON DELETE RESTRICT,
  is_any_master           INTEGER NOT NULL DEFAULT 0 CHECK (is_any_master IN (0, 1)),
  starts_at               TEXT    NOT NULL
    CHECK (starts_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  ends_at                 TEXT    NOT NULL
    CHECK (ends_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- Конец визита вместе с уборкой (раздел 5.19, решение 32).
  busy_until              TEXT    NOT NULL
    CHECK (busy_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  status                  TEXT    NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled_by_client', 'cancelled_by_studio', 'completed', 'no_show')),
  price_level             TEXT    NOT NULL CHECK (price_level IN ('master', 'top_master')),
  comment                 TEXT,
  created_by              INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  client_acknowledged_at  TEXT
    CHECK (client_acknowledged_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- Номер версии для оптимистической блокировки (раздел 9, экран A-S1).
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK (ends_at > starts_at),
  CHECK (busy_until >= ends_at)
) STRICT;

-- 5.20. Состав записи: название, цена и длительность копируются на момент записи.
CREATE TABLE booking_items (
  id              INTEGER PRIMARY KEY,
  booking_id      INTEGER NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  service_id      INTEGER NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  position        INTEGER NOT NULL CHECK (position >= 1),
  service_name    TEXT    NOT NULL,
  unit_price_rub  INTEGER NOT NULL CHECK (unit_price_rub >= 0),
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  price_rub       INTEGER NOT NULL,
  duration_min    INTEGER NOT NULL CHECK (duration_min > 0),
  CHECK (price_rub = unit_price_rub * quantity)
) STRICT;

-- 5.21. История изменений записи после создания: перенос, отмена, смена статуса.
CREATE TABLE booking_events (
  id                   INTEGER PRIMARY KEY,
  booking_id           INTEGER NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  event_type           TEXT    NOT NULL
    CHECK (event_type IN ('rescheduled', 'cancelled', 'status_changed', 'edited')),
  actor_id             INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  old_status           TEXT
    CHECK (old_status IN ('active', 'cancelled_by_client', 'cancelled_by_studio', 'completed', 'no_show')),
  new_status           TEXT
    CHECK (new_status IN ('active', 'cancelled_by_client', 'cancelled_by_studio', 'completed', 'no_show')),
  old_master_id        INTEGER REFERENCES masters (id) ON DELETE RESTRICT,
  new_master_id        INTEGER REFERENCES masters (id) ON DELETE RESTRICT,
  old_starts_at        TEXT
    CHECK (old_starts_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  new_starts_at        TEXT
    CHECK (new_starts_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  old_total_price_rub  INTEGER CHECK (old_total_price_rub >= 0),
  new_total_price_rub  INTEGER CHECK (new_total_price_rub >= 0),
  reason               TEXT,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- Проверки полноты по типу события. IS NOT NULL обязателен: сравнение с NULL CHECK пропускает.
  CHECK (event_type <> 'rescheduled' OR (old_starts_at IS NOT NULL AND new_starts_at IS NOT NULL
                                         AND old_master_id IS NOT NULL AND new_master_id IS NOT NULL)),
  CHECK (event_type <> 'cancelled' OR (old_status IS NOT NULL AND new_status IS NOT NULL AND old_status = 'active'
                                       AND new_status IN ('cancelled_by_client', 'cancelled_by_studio'))),
  CHECK (event_type <> 'status_changed' OR (old_status IS NOT NULL AND new_status IS NOT NULL
                                            AND new_status IN ('completed', 'no_show'))),
  CHECK (event_type = 'rescheduled' OR (old_master_id IS NULL AND new_master_id IS NULL
                                        AND old_starts_at IS NULL AND new_starts_at IS NULL))
) STRICT;

-- 5.18. Бронь выбранного времени на 10 минут. Временные строки, их можно удалять.
CREATE TABLE slot_holds (
  id          INTEGER PRIMARY KEY,
  owner_id    INTEGER NOT NULL UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
  master_id   INTEGER NOT NULL REFERENCES masters (id) ON DELETE RESTRICT,
  starts_at   TEXT    NOT NULL
    CHECK (starts_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  ends_at     TEXT    NOT NULL
    CHECK (ends_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  busy_until  TEXT    NOT NULL
    CHECK (busy_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- Заполнено, если бронь сделана для переноса существующей записи.
  booking_id  INTEGER REFERENCES bookings (id) ON DELETE RESTRICT,
  expires_at  TEXT    NOT NULL
    CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK (ends_at > starts_at),
  CHECK (busy_until >= ends_at),
  CHECK (expires_at > created_at)
) STRICT;

-- 5.6. Заметки администратора о клиенте (в том числе со слов мастера).
CREATE TABLE client_notes (
  id          INTEGER PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  author_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  master_id   INTEGER REFERENCES masters (id) ON DELETE RESTRICT,
  text        TEXT    NOT NULL CHECK (length(trim(text)) > 0),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

-- 5.7. Одноразовые коды и ссылки. Хранится только хеш кода.
CREATE TABLE auth_codes (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  purpose      TEXT    NOT NULL
    CHECK (purpose IN ('verify_phone', 'verify_email', 'login', 'reset_password')),
  target       TEXT    NOT NULL,
  code_hash    TEXT    NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at   TEXT    NOT NULL
    CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  consumed_at  TEXT
    CHECK (consumed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

-- 5.8. Серверные сессии. Хранится только хеш токена из cookie.
CREATE TABLE sessions (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash    TEXT    NOT NULL UNIQUE,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  last_seen_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (last_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  expires_at    TEXT    NOT NULL
    CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  revoked_at    TEXT
    CHECK (revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

-- 5.22. Фото работ: с визита (booking_item_id) или прямо в галерею (master_id).
CREATE TABLE work_photos (
  id                  INTEGER PRIMARY KEY,
  booking_item_id     INTEGER REFERENCES booking_items (id) ON DELETE RESTRICT,
  master_id           INTEGER REFERENCES masters (id) ON DELETE RESTRICT,
  service_id          INTEGER REFERENCES services (id) ON DELETE RESTRICT,
  file_path           TEXT    NOT NULL UNIQUE,
  title               TEXT,
  is_published        INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  publish_consent_at  TEXT
    CHECK (publish_consent_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  uploaded_by         INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK ((booking_item_id IS NOT NULL AND master_id IS NULL AND service_id IS NULL)
      OR (booking_item_id IS NULL AND master_id IS NOT NULL)),
  -- Фото с визита клиента публикуется только с его согласия.
  CHECK (is_published = 0 OR booking_item_id IS NULL OR publish_consent_at IS NOT NULL)
) STRICT;

-- =====================================================================
-- Уникальные частичные и составные индексы (раздел 9)
-- =====================================================================

CREATE UNIQUE INDEX booking_items_booking_service_uq  ON booking_items (booking_id, service_id);
CREATE UNIQUE INDEX booking_items_booking_position_uq ON booking_items (booking_id, position);
-- У записи не больше одной отмены.
CREATE UNIQUE INDEX booking_events_one_cancel_uq ON booking_events (booking_id) WHERE event_type = 'cancelled';
-- Вторая линия защиты от двойной записи: две действующие записи к мастеру не начинаются одновременно.
CREATE UNIQUE INDEX bookings_master_start_uq ON bookings (master_id, starts_at)
  WHERE status IN ('active', 'completed', 'no_show');

-- =====================================================================
-- Индексы для частых запросов (раздел 10.1)
-- =====================================================================

CREATE INDEX bookings_master_starts_idx         ON bookings (master_id, starts_at);
CREATE INDEX bookings_starts_idx                ON bookings (starts_at);
CREATE INDEX bookings_client_starts_idx         ON bookings (client_id, starts_at);
CREATE INDEX booking_items_service_idx          ON booking_items (service_id);
CREATE INDEX booking_events_booking_created_idx ON booking_events (booking_id, created_at);
CREATE INDEX time_blocks_master_starts_idx      ON time_blocks (master_id, starts_at);
CREATE INDEX slot_holds_master_starts_idx       ON slot_holds (master_id, starts_at);
CREATE INDEX slot_holds_expires_idx             ON slot_holds (expires_at);
CREATE INDEX master_services_service_idx        ON master_services (service_id);
CREATE INDEX work_photos_booking_item_idx       ON work_photos (booking_item_id);
CREATE INDEX work_photos_master_gallery_idx     ON work_photos (master_id, is_published, sort_order);
CREATE INDEX client_notes_client_created_idx    ON client_notes (client_id, created_at);
CREATE INDEX auth_codes_user_purpose_idx        ON auth_codes (user_id, purpose, created_at);
CREATE INDEX sessions_user_idx                  ON sessions (user_id);

-- =====================================================================
-- Триггеры (раздел 10)
-- Коды ошибок в RAISE сервер переводит в сообщения для пользователя.
-- =====================================================================

-- 10.2. Записи, их состав и история не удаляются.
CREATE TRIGGER bookings_no_delete BEFORE DELETE ON bookings
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_DELETE_FORBIDDEN');
END;

CREATE TRIGGER booking_items_no_delete BEFORE DELETE ON booking_items
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_DELETE_FORBIDDEN');
END;

CREATE TRIGGER booking_events_no_delete BEFORE DELETE ON booking_events
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_DELETE_FORBIDDEN');
END;

-- 10.3. Мастер не обслуживает двух клиентов одновременно.
-- Пересечение с учетом уборки: [starts_at, busy_until). Сравнения строгие — стык не пересечение.
-- «IS NOT NEW.id» вместо «<>»: при вставке NEW.id может быть NULL, а сравнение с NULL отбросило бы все строки.
CREATE TRIGGER bookings_no_overlap_insert BEFORE INSERT ON bookings
WHEN NEW.status IN ('active', 'completed', 'no_show')
BEGIN
  SELECT RAISE(ABORT, 'SLOT_TAKEN')
  WHERE EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.master_id = NEW.master_id
            AND b.id IS NOT NEW.id
            AND b.status IN ('active', 'completed', 'no_show')
            AND b.starts_at < NEW.busy_until AND b.busy_until > NEW.starts_at)
     OR EXISTS (
          SELECT 1 FROM slot_holds h
          WHERE h.master_id = NEW.master_id
            AND h.booking_id IS NOT NEW.id
            AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND h.starts_at < NEW.busy_until AND h.busy_until > NEW.starts_at);
END;

CREATE TRIGGER bookings_no_overlap_update
BEFORE UPDATE OF master_id, starts_at, ends_at, busy_until, status ON bookings
WHEN NEW.status IN ('active', 'completed', 'no_show')
BEGIN
  SELECT RAISE(ABORT, 'SLOT_TAKEN')
  WHERE EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.master_id = NEW.master_id
            AND b.id IS NOT NEW.id
            AND b.status IN ('active', 'completed', 'no_show')
            AND b.starts_at < NEW.busy_until AND b.busy_until > NEW.starts_at)
     OR EXISTS (
          SELECT 1 FROM slot_holds h
          WHERE h.master_id = NEW.master_id
            AND h.booking_id IS NOT NEW.id
            AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND h.starts_at < NEW.busy_until AND h.busy_until > NEW.starts_at);
END;

-- 10.4. Бронь не перекрывает записи и чужие действующие брони.
CREATE TRIGGER slot_holds_no_overlap BEFORE INSERT ON slot_holds
BEGIN
  SELECT RAISE(ABORT, 'SLOT_TAKEN')
  WHERE EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.master_id = NEW.master_id
            AND b.id IS NOT NEW.booking_id
            AND b.status IN ('active', 'completed', 'no_show')
            AND b.starts_at < NEW.busy_until AND b.busy_until > NEW.starts_at)
     OR EXISTS (
          SELECT 1 FROM slot_holds h
          WHERE h.master_id = NEW.master_id
            AND h.owner_id <> NEW.owner_id
            AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND h.starts_at < NEW.busy_until AND h.busy_until > NEW.starts_at);
END;

-- 10.5. Несовместимые услуги не объединяются в один визит.
CREATE TRIGGER booking_items_no_incompatible BEFORE INSERT ON booking_items
BEGIN
  SELECT RAISE(ABORT, 'SERVICES_INCOMPATIBLE')
  WHERE EXISTS (
    SELECT 1
    FROM booking_items bi
    JOIN service_incompatibilities si
      ON si.service_a_id = min(bi.service_id, NEW.service_id)
     AND si.service_b_id = max(bi.service_id, NEW.service_id)
    WHERE bi.booking_id = NEW.booking_id);
END;

-- 10.5. Мастер записи выполняет каждую услугу ее состава.
CREATE TRIGGER booking_items_master_can_do BEFORE INSERT ON booking_items
BEGIN
  SELECT RAISE(ABORT, 'MASTER_CANNOT_DO_SERVICE')
  WHERE EXISTS (SELECT 1 FROM bookings WHERE id = NEW.booking_id)
    AND NOT EXISTS (
      SELECT 1
      FROM bookings b
      JOIN master_services ms ON ms.master_id = b.master_id AND ms.service_id = NEW.service_id
      WHERE b.id = NEW.booking_id);
END;

-- 10.5. Перенос к другому мастеру: новый мастер выполняет все услуги записи.
CREATE TRIGGER bookings_master_can_do BEFORE UPDATE OF master_id ON bookings
WHEN NEW.master_id IS NOT OLD.master_id
BEGIN
  SELECT RAISE(ABORT, 'MASTER_CANNOT_DO_SERVICE')
  WHERE EXISTS (
    SELECT 1 FROM booking_items bi
    WHERE bi.booking_id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM master_services ms
        WHERE ms.master_id = NEW.master_id AND ms.service_id = bi.service_id));
END;

-- 10.6. Периоды недельного графика мастера на один день недели не пересекаются.
-- Пустой valid_to — бессрочно, в сравнении это '9999-12-31'.
CREATE TRIGGER master_weekly_hours_no_overlap_insert BEFORE INSERT ON master_weekly_hours
BEGIN
  SELECT RAISE(ABORT, 'SCHEDULE_PERIOD_OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM master_weekly_hours w
    WHERE w.master_id = NEW.master_id
      AND w.weekday = NEW.weekday
      AND w.valid_from <= COALESCE(NEW.valid_to, '9999-12-31')
      AND COALESCE(w.valid_to, '9999-12-31') >= NEW.valid_from);
END;

CREATE TRIGGER master_weekly_hours_no_overlap_update
BEFORE UPDATE OF master_id, weekday, valid_from, valid_to ON master_weekly_hours
BEGIN
  SELECT RAISE(ABORT, 'SCHEDULE_PERIOD_OVERLAP')
  WHERE EXISTS (
    SELECT 1 FROM master_weekly_hours w
    WHERE w.rowid <> OLD.rowid
      AND w.master_id = NEW.master_id
      AND w.weekday = NEW.weekday
      AND w.valid_from <= COALESCE(NEW.valid_to, '9999-12-31')
      AND COALESCE(w.valid_to, '9999-12-31') >= NEW.valid_from);
END;

-- 10.7. У отмененной записи есть событие отмены: сначала событие, потом смена статуса.
CREATE TRIGGER bookings_cancel_requires_event BEFORE UPDATE OF status ON bookings
WHEN NEW.status IN ('cancelled_by_client', 'cancelled_by_studio') AND NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'CANCEL_EVENT_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1 FROM booking_events e
    WHERE e.booking_id = NEW.id AND e.event_type = 'cancelled' AND e.new_status = NEW.status);
END;

-- 10.7. Запись нельзя сразу создать отмененной: событию отмены не на что ссылаться.
CREATE TRIGGER bookings_insert_not_cancelled BEFORE INSERT ON bookings
WHEN NEW.status IN ('cancelled_by_client', 'cancelled_by_studio')
BEGIN
  SELECT RAISE(ABORT, 'CANCEL_EVENT_REQUIRED');
END;

-- 10.8. Роль пользователя по ссылке. Несуществующего пользователя пропускаем:
-- его отклонит внешний ключ с понятной ошибкой.
CREATE TRIGGER users_role_immutable BEFORE UPDATE OF role ON users
WHEN NEW.role IS NOT OLD.role
BEGIN
  SELECT RAISE(ABORT, 'ROLE_IMMUTABLE');
END;

CREATE TRIGGER client_profiles_role_insert BEFORE INSERT ON client_profiles
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role <> 'client')
     OR EXISTS (SELECT 1 FROM users WHERE id = NEW.blacklisted_by AND role <> 'admin');
END;

CREATE TRIGGER client_profiles_role_update BEFORE UPDATE OF user_id, blacklisted_by ON client_profiles
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role <> 'client')
     OR EXISTS (SELECT 1 FROM users WHERE id = NEW.blacklisted_by AND role <> 'admin');
END;

CREATE TRIGGER client_notes_role_insert BEFORE INSERT ON client_notes
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.client_id AND role <> 'client')
     OR EXISTS (SELECT 1 FROM users WHERE id = NEW.author_id AND role <> 'admin');
END;

CREATE TRIGGER client_notes_role_update BEFORE UPDATE OF client_id, author_id ON client_notes
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.client_id AND role <> 'client')
     OR EXISTS (SELECT 1 FROM users WHERE id = NEW.author_id AND role <> 'admin');
END;

-- Запись создает администратор или сам клиент этой записи.
CREATE TRIGGER bookings_role_insert BEFORE INSERT ON bookings
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.client_id AND role <> 'client')
     OR EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'admin' AND id <> NEW.client_id);
END;

CREATE TRIGGER bookings_role_update BEFORE UPDATE OF client_id, created_by ON bookings
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.client_id AND role <> 'client')
     OR EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'admin' AND id <> NEW.client_id);
END;

CREATE TRIGGER studio_day_overrides_role_insert BEFORE INSERT ON studio_day_overrides
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'admin');
END;

CREATE TRIGGER studio_day_overrides_role_update BEFORE UPDATE OF created_by ON studio_day_overrides
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'admin');
END;

CREATE TRIGGER master_day_overrides_role_insert BEFORE INSERT ON master_day_overrides
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'admin');
END;

CREATE TRIGGER master_day_overrides_role_update BEFORE UPDATE OF created_by ON master_day_overrides
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'admin');
END;

CREATE TRIGGER time_blocks_role_insert BEFORE INSERT ON time_blocks
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'admin');
END;

CREATE TRIGGER time_blocks_role_update BEFORE UPDATE OF created_by ON time_blocks
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'admin');
END;

CREATE TRIGGER work_photos_role_insert BEFORE INSERT ON work_photos
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.uploaded_by AND role <> 'admin');
END;

CREATE TRIGGER work_photos_role_update BEFORE UPDATE OF uploaded_by ON work_photos
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.uploaded_by AND role <> 'admin');
END;

-- Автор изменения записи: система (NULL), администратор или клиент этой записи.
CREATE TRIGGER booking_events_role_insert BEFORE INSERT ON booking_events
WHEN NEW.actor_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = NEW.actor_id
      AND u.role <> 'admin'
      AND u.id IS NOT (SELECT client_id FROM bookings WHERE id = NEW.booking_id));
END;

CREATE TRIGGER booking_events_role_update BEFORE UPDATE OF actor_id, booking_id ON booking_events
WHEN NEW.actor_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = NEW.actor_id
      AND u.role <> 'admin'
      AND u.id IS NOT (SELECT client_id FROM bookings WHERE id = NEW.booking_id));
END;

-- Бронь на перенос, которую держит клиент, — только для его собственной записи.
-- Проверка «клиент или администратор» не нужна: других ролей нет.
CREATE TRIGGER slot_holds_role_insert BEFORE INSERT ON slot_holds
WHEN NEW.booking_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = NEW.owner_id
      AND u.role = 'client'
      AND u.id IS NOT (SELECT client_id FROM bookings WHERE id = NEW.booking_id));
END;

CREATE TRIGGER slot_holds_role_update BEFORE UPDATE OF owner_id, booking_id ON slot_holds
WHEN NEW.booking_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = NEW.owner_id
      AND u.role = 'client'
      AND u.id IS NOT (SELECT client_id FROM bookings WHERE id = NEW.booking_id));
END;

-- 10.9. Тип услуги по ссылке: опция — к основной услуге.
CREATE TRIGGER service_addon_rules_kind_insert BEFORE INSERT ON service_addon_rules
BEGIN
  SELECT RAISE(ABORT, 'WRONG_SERVICE_KIND')
  WHERE EXISTS (SELECT 1 FROM services WHERE id = NEW.addon_service_id AND kind <> 'addon')
     OR EXISTS (SELECT 1 FROM services WHERE id = NEW.main_service_id AND kind <> 'main');
END;

CREATE TRIGGER service_addon_rules_kind_update BEFORE UPDATE ON service_addon_rules
BEGIN
  SELECT RAISE(ABORT, 'WRONG_SERVICE_KIND')
  WHERE EXISTS (SELECT 1 FROM services WHERE id = NEW.addon_service_id AND kind <> 'addon')
     OR EXISTS (SELECT 1 FROM services WHERE id = NEW.main_service_id AND kind <> 'main');
END;

-- Тип услуги не меняется, если на нее уже ссылаются правила опций или записи.
CREATE TRIGGER services_kind_locked BEFORE UPDATE OF kind ON services
WHEN NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'WRONG_SERVICE_KIND')
  WHERE EXISTS (SELECT 1 FROM service_addon_rules WHERE addon_service_id = OLD.id OR main_service_id = OLD.id)
     OR EXISTS (SELECT 1 FROM booking_items WHERE service_id = OLD.id);
END;
