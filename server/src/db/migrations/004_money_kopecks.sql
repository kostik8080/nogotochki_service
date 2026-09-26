-- Миграция 004. Деньги хранятся в копейках (схема БД версии 13, спорное решение 39).
-- Поля *_rub переименовываются в *_kop, значения умножаются на 100.
--
-- ALTER TABLE … RENAME COLUMN (SQLite 3.25+) сам переписывает имя поля в CHECK, индексах
-- и триггерах, поэтому пересоздавать таблицы не нужно. Проверки остаются прежними:
-- неотрицательная цена, цена топ-мастера не ниже цены мастера, цена строки = цена за единицу × количество.
-- UPDATE меняет оба поля одной командой, поэтому CHECK проверяет уже согласованную пару.
-- Миграция работает и на пустой базе, и на базе с данными: UPDATE без строк ничего не делает.

ALTER TABLE services RENAME COLUMN price_master_rub TO price_master_kop;
ALTER TABLE services RENAME COLUMN price_top_rub TO price_top_kop;

ALTER TABLE booking_items RENAME COLUMN unit_price_rub TO unit_price_kop;
ALTER TABLE booking_items RENAME COLUMN price_rub TO price_kop;

ALTER TABLE booking_events RENAME COLUMN old_total_price_rub TO old_total_price_kop;
ALTER TABLE booking_events RENAME COLUMN new_total_price_rub TO new_total_price_kop;

UPDATE services SET price_master_kop = price_master_kop * 100, price_top_kop = price_top_kop * 100;
UPDATE booking_items SET unit_price_kop = unit_price_kop * 100, price_kop = price_kop * 100;
UPDATE booking_events
SET old_total_price_kop = old_total_price_kop * 100, new_total_price_kop = new_total_price_kop * 100
WHERE old_total_price_kop IS NOT NULL OR new_total_price_kop IS NOT NULL;
