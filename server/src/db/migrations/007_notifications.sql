-- Миграция 007. Уведомления клиента в личном кабинете (схема БД версии 16).
--
-- Уведомления появляются только тогда, когда запись клиента изменил кто-то другой — администратор студии.
-- Своих действий клиент не получает: он только что сделал их сам (записался, перенес, отменил).
-- Событий три, и других пока нет:
--   booking_cancelled  — администратор отменил запись клиента;
--   booking_rescheduled — администратор перенес запись клиента на другое время или к другому мастеру;
--   booking_overbooked  — администратор поставил на время этой записи еще один визит (наложение, решение 40).
--
-- Текст пишется при создании и больше не меняется: он описывает событие так, как оно выглядело тогда
-- («Запись на четверг, 1 октября, 14:00 перенесена на пятницу, 2 октября, 11:00»). Пересчитывать его
-- по текущему состоянию записи нельзя — она уже изменилась.
--
-- Почты и внешних служб здесь нет: уведомление живет только в кабинете (паспорт, «Ограничения»).

CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  -- Получатель. Только клиент: у администратора и мастера уведомлений в сервисе нет.
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Запись, из-за которой появилось уведомление: по ней открывается карточка записи в кабинете.
  booking_id  INTEGER NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  event_type  TEXT    NOT NULL CHECK (event_type IN ('booking_cancelled', 'booking_rescheduled', 'booking_overbooked')),
  -- Готовый текст для кабинета, с конкретными датами и временем.
  text        TEXT    NOT NULL CHECK (length(trim(text)) > 0),
  -- Когда клиент прочитал уведомление; NULL — непрочитанное, они считаются для счетчика в шапке.
  read_at     TEXT    CHECK (read_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

-- Кабинет всегда спрашивает свои уведомления от новых к старым, поэтому индекс по получателю и времени.
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Получатель — всегда клиент: роль проверяет база, а не только код (раздел 10.1).
CREATE TRIGGER notifications_role_insert BEFORE INSERT ON notifications
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role <> 'client');
END;

CREATE TRIGGER notifications_role_update BEFORE UPDATE OF user_id ON notifications
BEGIN
  SELECT RAISE(ABORT, 'WRONG_USER_ROLE')
  WHERE EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role <> 'client');
END;

-- Уведомление принадлежит той записи, о которой говорит: подменить ее нельзя, иначе текст перестанет
-- соответствовать ссылке. Меняется только отметка о прочтении.
CREATE TRIGGER notifications_immutable BEFORE UPDATE OF booking_id, event_type, text, created_at ON notifications
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_IMMUTABLE');
END;
