-- Миграция 008. Заявки мастера администратору (схема БД версии 17, решение заказчика 30.09.2026).
--
-- До этой версии мастер только смотрел свое расписание, а отпуск и график вносил администратор со слов
-- мастера. Теперь мастер подает заявку сам, а администратор ее одобряет или отклоняет. Записи мастер
-- по-прежнему не меняет: заявка — это просьба, а не действие.
--
-- Типы заявок:
--   vacation    — отпуск: период дат;
--   day_off     — отгул: период дат (обычно один день);
--   sick_leave  — больничный: период дат;
--   schedule    — новый недельный график с даты: дни недели и часы в payload;
--   other       — свободная просьба словами, администратор решает вручную.
--
-- Одобрение применяет заявку сразу: отпуск, отгул и больничный становятся блокировкой времени
-- (time_blocks), новый график — строками master_weekly_hours с этой даты. Записи, которые попали под
-- изменение, база не трогает: администратор видит их перед одобрением и разбирает сам.

CREATE TABLE master_requests (
  id               INTEGER PRIMARY KEY,
  -- Чье расписание меняет заявка.
  master_id        INTEGER NOT NULL REFERENCES masters (id) ON DELETE RESTRICT,
  -- Учетная запись мастера, которая подала заявку. Триггер проверяет, что это учетная запись этого же мастера.
  created_by       INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  type             TEXT    NOT NULL CHECK (type IN ('vacation', 'day_off', 'sick_leave', 'schedule', 'other')),
  status           TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  -- Период дат для отпуска, отгула и больничного (включительно); у графика и свободной заявки пусто.
  starts_on        TEXT    CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  ends_on          TEXT    CHECK (ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  -- С какой даты действует новый график; только у типа schedule.
  valid_from       TEXT    CHECK (valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  -- Дни нового графика: [{"weekday":2,"start":"10:00","end":"18:00"}]. Только у типа schedule.
  payload          TEXT    CHECK (payload IS NULL OR json_valid(payload)),
  -- Пояснение мастера. У свободной заявки обязательно: в ней вся суть просьбы.
  comment          TEXT,
  -- Кто и когда решил; у отклонения — причина, ее видит мастер.
  decided_by       INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  decided_at       TEXT    CHECK (decided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  decision_reason  TEXT,
  -- Что создано при одобрении: блокировка времени. У графика и свободной заявки пусто.
  time_block_id    INTEGER REFERENCES time_blocks (id) ON DELETE RESTRICT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- У каждого типа заявки свой набор полей: период дат, график или текст просьбы.
  CHECK (
    (type IN ('vacation', 'day_off', 'sick_leave')
       AND starts_on IS NOT NULL AND ends_on IS NOT NULL AND valid_from IS NULL AND payload IS NULL)
    OR (type = 'schedule'
       AND valid_from IS NOT NULL AND payload IS NOT NULL AND starts_on IS NULL AND ends_on IS NULL)
    OR (type = 'other'
       AND comment IS NOT NULL AND starts_on IS NULL AND ends_on IS NULL AND valid_from IS NULL AND payload IS NULL)
  ),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  -- Решение и его автор появляются вместе: заявка либо на рассмотрении, либо решена.
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL)),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL))
) STRICT;

-- Администратор открывает список с новыми заявками, мастер — свои.
CREATE INDEX master_requests_status_idx ON master_requests (status, created_at);
CREATE INDEX master_requests_master_idx ON master_requests (master_id, created_at);

-- Заявку подает мастер и только за себя: created_by должен быть учетной записью этого мастера.
-- Решает ее администратор. Роли проверяет база, а не только код (раздел 10.1).
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

-- Решенная заявка не меняется: одобренную или отклоненную нельзя переписать или подать заново.
-- Передумал мастер — отзывает заявку, пока она на рассмотрении (status = 'cancelled').
CREATE TRIGGER master_requests_decided_final BEFORE UPDATE OF status ON master_requests
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'REQUEST_ALREADY_DECIDED');
END;
