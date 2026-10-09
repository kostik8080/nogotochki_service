-- migrator: foreign_keys=off
-- Миграция 010. Свое фото у мастера и у клиента (docs/db-schema.md, версия 19).
--
-- 1. Фото мастера попадает на сайт только через одобрение администратора — решение заказчика
--    08.10.2026. Отдельного механизма согласования заводить не стали: у мастера уже есть заявки
--    (раздел 5.24) с одобрением, отказом с причиной, отзывом и счетчиком новых у администратора.
--    Поэтому появляется шестой тип заявки — 'photo'. Путь к загруженному файлу лежит в `payload`
--    (`{"path":"photos/2026/10/….jpg"}`), как у графика там лежат дни недели: отдельная колонка
--    ради одного типа не нужна, а json_valid проверяет базу так же.
--    Тип и набор полей заданы проверками уровня строки, а их в SQLite меняют только пересозданием
--    таблицы — как в миграциях 003 и 009: новая таблица, копия строк, удаление старой, переименование.
--    Пометка в первой строке выключает на это время проверку внешних ключей.
-- 2. `masters.photo_path` — одобренное фото мастера, путь внутри UPLOADS_DIR, как у фото работ
--    (раздел 5.22). Прежнее `masters.photo_url` остается: это ссылка на картинку снаружи, которую
--    вписывает администратор. Файл важнее ссылки — что из них показывать, решает сервис.
-- 3. `client_profiles.photo_path` — фото клиента. Его видят сам клиент, администратор и мастер,
--    у которого есть запись этого клиента (решение заказчика 08.10.2026). При удалении аккаунта
--    строка карточки обезличивается, а файл удаляется — этого требует 152-ФЗ и сценарий 17.
--
-- Существующие строки не меняются: у заявок прежних типов проверки работают как раньше,
-- а новые колонки пустые — это значит «фото нет», как и было до миграции.

-- ---------------------------------------------------------------------
-- 1. Пересоздание master_requests ради типа 'photo'
-- ---------------------------------------------------------------------

CREATE TABLE master_requests_new (
  id               INTEGER PRIMARY KEY,
  -- Чье расписание меняет заявка.
  master_id        INTEGER NOT NULL REFERENCES masters (id) ON DELETE RESTRICT,
  -- Учетная запись мастера, которая подала заявку. Триггер проверяет, что это он сам.
  created_by       INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  type             TEXT    NOT NULL CHECK (type IN ('vacation', 'day_off', 'sick_leave', 'schedule', 'other', 'photo')),
  status           TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  -- Период дат для отпуска, отгула и больничного (включительно).
  starts_on        TEXT    CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  ends_on          TEXT    CHECK (ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  -- С какой даты действует новый график; только у типа schedule.
  valid_from       TEXT    CHECK (valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  -- Дни нового графика: [{"weekday":2,"start":"10:00","end":"18:00"}]. У заявки на фото — путь к файлу.
  payload          TEXT    CHECK (payload IS NULL OR json_valid(payload)),
  -- Пояснение мастера. У свободной заявки обязательно: в нем вся суть просьбы.
  comment          TEXT,
  -- Кто и когда решил; у отклонения — причина, ее видит мастер.
  decided_by       INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  decided_at       TEXT    CHECK (decided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  decision_reason  TEXT,
  -- Что создано при одобрении: блокировка времени. У графика, свободной заявки и фото пусто.
  time_block_id    INTEGER REFERENCES time_blocks (id) ON DELETE RESTRICT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- У каждого типа заявки свой набор полей: период дат, график, текст просьбы или путь к файлу фото.
  CHECK (
    (type IN ('vacation', 'day_off', 'sick_leave')
       AND starts_on IS NOT NULL AND ends_on IS NOT NULL AND valid_from IS NULL AND payload IS NULL)
    OR (type = 'schedule'
       AND valid_from IS NOT NULL AND payload IS NOT NULL AND starts_on IS NULL AND ends_on IS NULL)
    OR (type = 'other'
       AND comment IS NOT NULL AND starts_on IS NULL AND ends_on IS NULL AND valid_from IS NULL AND payload IS NULL)
    OR (type = 'photo'
       AND payload IS NOT NULL AND starts_on IS NULL AND ends_on IS NULL AND valid_from IS NULL)
  ),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  -- Решение и его автор появляются вместе: заявка либо на рассмотрении, либо решена.
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL)),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL))
) STRICT;

INSERT INTO master_requests_new (id, master_id, created_by, type, status, starts_on, ends_on, valid_from,
                                 payload, comment, decided_by, decided_at, decision_reason, time_block_id, created_at)
SELECT id, master_id, created_by, type, status, starts_on, ends_on, valid_from,
       payload, comment, decided_by, decided_at, decision_reason, time_block_id, created_at
FROM master_requests;

DROP TABLE master_requests;
ALTER TABLE master_requests_new RENAME TO master_requests;

-- Индексы и триггеры исчезли вместе со старой таблицей — создаем заново в том же виде.
CREATE INDEX master_requests_status_idx ON master_requests (status, created_at);
CREATE INDEX master_requests_master_idx ON master_requests (master_id, created_at);

CREATE TRIGGER master_requests_role_insert BEFORE INSERT ON master_requests
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'master')
     OR NOT EXISTS (SELECT 1 FROM masters WHERE id = NEW.master_id AND user_id = NEW.created_by)
     OR EXISTS (SELECT 1 FROM users WHERE id = NEW.decided_by AND role <> 'admin');
END;

CREATE TRIGGER master_requests_role_update BEFORE UPDATE OF created_by, master_id, decided_by ON master_requests
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role <> 'master')
     OR NOT EXISTS (SELECT 1 FROM masters WHERE id = NEW.master_id AND user_id = NEW.created_by)
     OR EXISTS (SELECT 1 FROM users WHERE id = NEW.decided_by AND role <> 'admin');
END;

CREATE TRIGGER master_requests_decided_final BEFORE UPDATE OF status ON master_requests
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'REQUEST_ALREADY_DECIDED');
END;

-- ---------------------------------------------------------------------
-- 2. Фото мастера и фото клиента
-- ---------------------------------------------------------------------

ALTER TABLE masters ADD COLUMN photo_path TEXT;

ALTER TABLE client_profiles ADD COLUMN photo_path TEXT;
