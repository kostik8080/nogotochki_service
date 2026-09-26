-- Миграция 005. Осознанное наложение записи администратором (схема БД версии 14, спорное решение 40).
--
-- bookings.is_overbooking = 1 — администратор сознательно поставил запись поверх другой записи того же мастера.
-- Такую запись триггер пропускает при вставке, но дальше она участвует в проверках как обычная:
-- занимает время для новых записей и броней, а ее собственный перенос проверяется на пересечения.
-- Действующие брони клиентов наложение не перебивает: клиент, который держит время, должен записаться.

ALTER TABLE bookings ADD COLUMN is_overbooking INTEGER NOT NULL DEFAULT 0 CHECK (is_overbooking IN (0, 1));

-- Вторая линия защиты — уникальный индекс по времени начала. Наложение может начинаться в ту же минуту,
-- что и занятая запись, поэтому индекс его не учитывает; пересечения с ним ловит триггер.
DROP INDEX bookings_master_start_uq;
CREATE UNIQUE INDEX bookings_master_start_uq ON bookings (master_id, starts_at)
  WHERE status IN ('active', 'completed', 'no_show') AND is_overbooking = 0;

-- Вставка: пересечение с записями не проверяется только у самой записи-наложения.
-- Пересечение с чужой действующей бронью проверяется всегда.
DROP TRIGGER bookings_no_overlap_insert;
CREATE TRIGGER bookings_no_overlap_insert BEFORE INSERT ON bookings
WHEN NEW.status IN ('active', 'completed', 'no_show')
BEGIN
  SELECT RAISE(ABORT, 'SLOT_TAKEN')
  WHERE (NEW.is_overbooking = 0 AND EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.master_id = NEW.master_id
            AND b.id IS NOT NEW.id
            AND b.status IN ('active', 'completed', 'no_show')
            AND b.starts_at < NEW.busy_until AND b.busy_until > NEW.starts_at))
     OR EXISTS (
          SELECT 1 FROM slot_holds h
          WHERE h.master_id = NEW.master_id
            AND h.booking_id IS NOT NEW.id
            AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND h.starts_at < NEW.busy_until AND h.busy_until > NEW.starts_at);
END;

-- Изменение: проверяется, когда запись занимает новое время — перенос, смена мастера, возврат отмененной
-- записи в работу. Смена статуса между «Активна», «Завершена» и «Клиент не пришел» время не меняет
-- и не проверяется: иначе запись-наложение и та, поверх которой она стоит, не могли бы получить итог визита.
-- Признак наложения здесь не учитывается: перенесенная запись проверяется как обычная.
DROP TRIGGER bookings_no_overlap_update;
CREATE TRIGGER bookings_no_overlap_update
BEFORE UPDATE OF master_id, starts_at, ends_at, busy_until, status ON bookings
WHEN NEW.status IN ('active', 'completed', 'no_show')
  AND (NEW.master_id IS NOT OLD.master_id OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at
       OR NEW.busy_until IS NOT OLD.busy_until OR OLD.status NOT IN ('active', 'completed', 'no_show'))
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

-- Признак наложения ставит только администратор (раздел 10.8). Клиент, создающий запись сам на себя,
-- наложение сделать не может, даже если сервер по ошибке передаст признак.
CREATE TRIGGER bookings_overbooking_admin_only BEFORE INSERT ON bookings
WHEN NEW.is_overbooking = 1
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by AND role = 'admin');
END;

-- Признак — факт создания записи, как created_by: после вставки он не меняется.
CREATE TRIGGER bookings_overbooking_immutable BEFORE UPDATE OF is_overbooking ON bookings
WHEN NEW.is_overbooking IS NOT OLD.is_overbooking
BEGIN
  SELECT RAISE(ABORT, 'OVERBOOKING_IMMUTABLE');
END;
