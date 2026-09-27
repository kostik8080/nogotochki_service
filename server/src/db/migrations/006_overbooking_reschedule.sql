-- Миграция 006. Наложение и при переносе (схема БД версии 15, спорное решение 40).
--
-- Раньше администратор мог поставить запись поверх занятого времени только при создании, а признак
-- is_overbooking после создания не менялся. Теперь признак описывает, как запись стоит сейчас:
--   * перенос администратором с наложением ставит is_overbooking = 1 — пересечение с записями разрешено;
--   * обычный перенос (клиентом или администратором) ставит is_overbooking = 0 — запись снова проверяется как обычная.
-- Чужие действующие брони наложение по-прежнему не перебивает.

-- Изменение: пересечение с другими записями не проверяется, если после изменения запись — наложение.
-- Проверка по-прежнему только тогда, когда запись занимает новое время (миграция 005).
DROP TRIGGER bookings_no_overlap_update;
CREATE TRIGGER bookings_no_overlap_update
BEFORE UPDATE OF master_id, starts_at, ends_at, busy_until, status, is_overbooking ON bookings
WHEN NEW.status IN ('active', 'completed', 'no_show')
  AND (NEW.master_id IS NOT OLD.master_id OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at
       OR NEW.busy_until IS NOT OLD.busy_until OR OLD.status NOT IN ('active', 'completed', 'no_show')
       OR NEW.is_overbooking IS NOT OLD.is_overbooking)
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

-- Признак больше не неизменный: его ставит перенос администратором с наложением.
DROP TRIGGER bookings_overbooking_immutable;

-- Кто ставит наложение при изменении: только администратор. В той же транзакции перед изменением записи
-- сервер пишет событие rescheduled (кто, откуда, куда). Если запись после изменения — наложение
-- и занимает новое время, последнее событие записи должно быть переносом именно сюда, сделанным администратором.
CREATE TRIGGER bookings_overbooking_admin_only_update
BEFORE UPDATE OF master_id, starts_at, ends_at, busy_until, is_overbooking ON bookings
WHEN NEW.is_overbooking = 1
  AND (NEW.is_overbooking IS NOT OLD.is_overbooking OR NEW.master_id IS NOT OLD.master_id
       OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at OR NEW.busy_until IS NOT OLD.busy_until)
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE NOT EXISTS (
    SELECT 1 FROM booking_events e JOIN users u ON u.id = e.actor_id
    WHERE e.id = (SELECT max(id) FROM booking_events WHERE booking_id = NEW.id)
      AND e.event_type = 'rescheduled'
      AND e.new_starts_at = NEW.starts_at
      AND e.new_master_id = NEW.master_id
      AND u.role = 'admin');
END;
