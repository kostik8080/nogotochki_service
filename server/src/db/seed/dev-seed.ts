// Тестовые данные для разработки: студия, услуги, мастера, график, пользователи и записи
// из паспорта (docs/pasport-produkta.md) и моковых данных прототипа (Prototype/data.js).
// Записи и блокировки считаются от сегодняшнего дня, чтобы в календаре всегда были
// и прошедшие визиты, и предстоящие. Только для разработки: в production не запускается.
//
// Скрипт повторяемый: каждая строка ищется по своему ключу (e-mail пользователя, id услуги,
// мастер + день недели графика…) и добавляется, только если ее нет. Существующие строки не меняются.
// Сценарные данные — история визитов, будущие записи, отпуск и выходной Елены — добавляются
// один раз, пока у тестовой клиентки нет записей: они привязаны к дате первого запуска,
// и повторный запуск в другой день сдвинул бы их и наложил на прежние.
import type { SQLInputValue } from 'node:sqlite';
import { hashPassword } from '../../auth/password.js';
import { insertBookingRows, writeCancellation, writeReschedule, writeStatusChange } from '../../booking/booking-service.js';
import { loadBooking } from '../../booking/existing.js';
import { addDays, isoWeekday, zonedDate, zonedTimeToUtc } from '../../lib/studio-time.js';
import { type Db, transaction } from '../connection.js';

export interface SeedOptions {
  adminPassword: string;
  masterPassword: string;
  clientPassword: string;
  /** Текущий момент; параметр нужен, чтобы тесты могли зафиксировать дату. */
  now?: Date;
}

/** Сколько строк каждой таблицы добавлено и сколько уже было. */
export interface SeedReport {
  tables: Map<string, { created: number; existing: number }>;
  /** Добавлены ли сценарные данные в этот запуск. */
  scenarioCreated: boolean;
}

const TIMEZONE = 'Europe/Moscow';
const HORIZON_DAYS = 90;

// ---------------------------------------------------------------------------
// Справочные данные
// ---------------------------------------------------------------------------

const categories = [
  { id: 1, name: 'Маникюр' },
  { id: 2, name: 'Педикюр' },
  { id: 3, name: 'Наращивание' },
  { id: 4, name: 'Брови' },
];

interface Service {
  id: number; categoryId: number; name: string; description: string;
  /** Цены — в копейках, как в базе: 1800_00 — это 1800 ₽. */
  durationMin: number; cleanupMin: number; priceMaster: number; priceTop: number;
  addon?: boolean; featured?: boolean;
}

// id совпадают с номерами услуг прототипа: s1 → 1, s2 → 2 и т. д.
const services: Service[] = [
  { id: 1, categoryId: 1, name: 'Маникюр с покрытием гель-лаком', description: 'Классический уход и стойкое покрытие', durationMin: 90, cleanupMin: 15, priceMaster: 1800_00, priceTop: 2200_00, featured: true },
  { id: 2, categoryId: 1, name: 'Маникюр без покрытия', description: 'Аппаратный или комбинированный уход', durationMin: 45, cleanupMin: 15, priceMaster: 1200_00, priceTop: 1500_00, featured: true },
  { id: 3, categoryId: 1, name: 'Дизайн ногтей', description: 'Дополнение к маникюру, маникюру и педикюру или наращиванию', durationMin: 30, cleanupMin: 0, priceMaster: 300_00, priceTop: 300_00, addon: true, featured: true },
  { id: 4, categoryId: 1, name: 'Снятие покрытия', description: 'Аккуратное снятие гель-лака', durationMin: 20, cleanupMin: 15, priceMaster: 500_00, priceTop: 600_00 },
  { id: 5, categoryId: 2, name: 'Педикюр с покрытием', description: 'Уход за стопами и стойкое покрытие', durationMin: 90, cleanupMin: 15, priceMaster: 2200_00, priceTop: 2600_00, featured: true },
  { id: 6, categoryId: 2, name: 'Педикюр без покрытия', description: 'Уход за стопами без покрытия', durationMin: 60, cleanupMin: 15, priceMaster: 1600_00, priceTop: 1900_00 },
  { id: 7, categoryId: 2, name: 'Маникюр и педикюр', description: 'Комплексный уход за руками и ногами', durationMin: 150, cleanupMin: 15, priceMaster: 3200_00, priceTop: 3800_00 },
  { id: 8, categoryId: 3, name: 'Наращивание ногтей', description: 'Форма и длина по вашему желанию', durationMin: 150, cleanupMin: 15, priceMaster: 2800_00, priceTop: 3400_00, featured: true },
  { id: 9, categoryId: 3, name: 'Коррекция наращённых ногтей', description: 'Поддержание формы между визитами', durationMin: 90, cleanupMin: 15, priceMaster: 1800_00, priceTop: 2200_00 },
  { id: 10, categoryId: 3, name: 'Снятие наращённых ногтей', description: 'Бережное снятие материала', durationMin: 30, cleanupMin: 15, priceMaster: 600_00, priceTop: 700_00 },
  { id: 11, categoryId: 4, name: 'Коррекция и окрашивание бровей', description: 'Форма и цвет, подобранные под лицо', durationMin: 40, cleanupMin: 10, priceMaster: 1200_00, priceTop: 1500_00 },
  { id: 12, categoryId: 4, name: 'Ламинирование бровей', description: 'Ухоженный вид без макияжа', durationMin: 60, cleanupMin: 10, priceMaster: 1800_00, priceTop: 2100_00, featured: true },
  { id: 13, categoryId: 4, name: 'Коррекция бровей', description: 'Только форма, без окрашивания', durationMin: 20, cleanupMin: 10, priceMaster: 700_00, priceTop: 900_00 },
  { id: 14, categoryId: 4, name: 'Окрашивание бровей хной', description: 'Естественный стойкий цвет', durationMin: 30, cleanupMin: 10, priceMaster: 900_00, priceTop: 1100_00 },
];

const DESIGN_ID = 3;
/** «Дизайн ногтей» доступен с маникюром, маникюром и педикюром или наращиванием (паспорт, функция 3). */
const designMainServiceIds = [1, 2, 7, 8];

type Level = 'master' | 'top_master';

/** Недельный график, который действует с даты `validFrom` до начала следующего графика мастера. */
interface Schedule {
  validFrom: string;
  /** Рабочие дни по ISO: 1 — понедельник … 7 — воскресенье. */
  weekdays: number[]; start: string; end: string;
}

interface Master {
  id: number; name: string; level: Level; specialty: string; experienceYears: number; bio: string;
  /** Графики по возрастанию даты начала. */
  schedules: Schedule[]; serviceIds: number[];
}

const masters: Master[] = [
  {
    id: 1, name: 'Анна Ковалева', level: 'master', specialty: 'Маникюр и педикюр', experienceYears: 7,
    bio: 'Более 6 лет в маникюре, аккуратная работа с покрытием и формой',
    schedules: [
      { validFrom: '2024-01-01', weekdays: [2, 3, 4, 5], start: '10:00', end: '18:00' },
      // Сценарий 14: с 1 октября Анна работает ср–сб. Сентябрьские дни считаются по старому графику.
      { validFrom: '2026-10-01', weekdays: [3, 4, 5, 6], start: '10:00', end: '18:00' },
    ],
    // Сценарий 2: наращивание с дизайном выполняет только Анна.
    serviceIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  {
    id: 2, name: 'Марина Орлова', level: 'master', specialty: 'Мастер по бровям', experienceYears: 4,
    bio: 'Подбирает форму бровей индивидуально под черты лица',
    schedules: [{ validFrom: '2024-01-01', weekdays: [3, 4, 5, 6], start: '11:00', end: '20:00' }],
    serviceIds: [11, 12, 13, 14],
  },
  {
    id: 3, name: 'Елена Смирнова', level: 'master', specialty: 'Универсальный мастер', experienceYears: 5,
    bio: 'Работает и с ногтями, и с бровями — удобно для комплексного визита',
    schedules: [{ validFrom: '2024-01-01', weekdays: [2, 4, 6], start: '10:00', end: '19:00' }],
    // Наращивание делает, дизайн — нет.
    serviceIds: [1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  },
];

const studioDays = [
  { date: '2026-09-29', isOpen: 0, open: null, close: null, reason: 'Санитарный день' },
  { date: '2026-12-31', isOpen: 1, open: '10:00', close: '16:00', reason: 'Предпраздничный день' },
  { date: '2027-01-01', isOpen: 0, open: null, close: null, reason: 'Новогодние праздники' },
  { date: '2027-03-08', isOpen: 1, open: '10:00', close: '18:00', reason: 'Международный женский день — дополнительный рабочий день' },
];
const closedStudioDates = new Set(studioDays.filter((d) => !d.isOpen).map((d) => d.date));

// ---------------------------------------------------------------------------
// Дата и время студии. В базе — UTC (раздел 2), а график задан по часам студии.
// ---------------------------------------------------------------------------

const studioTime = (date: string, time: string) => new Date(zonedTimeToUtc(date, time, TIMEZONE));
const studioDate = (instant: Date) => zonedDate(instant.getTime(), TIMEZONE);

/** Ближайшая дата с этим днем недели через `minDays` дней или позже (назад — при отрицательном `step`). */
function findWeekday(from: string, weekday: number, minDays: number, step: 1 | -1 = 1): string {
  let date = addDays(from, minDays);
  while (isoWeekday(date) !== weekday || closedStudioDates.has(date)) date = addDays(date, step);
  return date;
}

const iso = (d: Date) => d.toISOString();
const addMinutes = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

// ---------------------------------------------------------------------------
// Заполнение
// ---------------------------------------------------------------------------

export function seedDevData(db: Db, options: SeedOptions): SeedReport {
  const now = options.now ?? new Date();
  const today = studioDate(now);
  const report: SeedReport = { tables: new Map(), scenarioCreated: false };

  const count = (table: string, created: boolean) => {
    const stat = report.tables.get(table) ?? { created: 0, existing: 0 };
    stat[created ? 'created' : 'existing']++;
    report.tables.set(table, stat);
  };

  // Пустое значение передается как null: node:sqlite не принимает undefined.
  const insert = (table: string, row: Record<string, SQLInputValue>): number => {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`;
    const id = Number(db.prepare(sql).run(row).lastInsertRowid);
    count(table, true);
    return id;
  };

  /**
   * Добавляет строку, если строки с такими же значениями полей `keys` еще нет; возвращает rowid
   * (у таблиц с INTEGER PRIMARY KEY это id). Проверка идет запросом, а не INSERT OR IGNORE:
   * триггеры BEFORE INSERT срабатывают до проверки уникальности и отклонили бы повтор с ошибкой.
   */
  const ensure = (table: string, row: Record<string, SQLInputValue>, keys: string[]): number => {
    const where = keys.map((k) => `${k} = @${k}`).join(' AND ');
    const params = Object.fromEntries(keys.map((k) => [k, row[k]!]));
    const found = db.prepare(`SELECT rowid AS id FROM ${table} WHERE ${where}`).get(params) as { id: number } | undefined;
    if (found) {
      count(table, false);
      return Number(found.id);
    }
    return insert(table, row);
  };

  /** Пользователь по e-mail или телефону. Строка (и хеш пароля) собирается, только если пользователя нет. */
  const ensureUser = (key: 'email' | 'phone', value: string, row: () => Record<string, SQLInputValue>): number => {
    const found = db.prepare(`SELECT id FROM users WHERE ${key} = ?`).get(value) as { id: number } | undefined;
    if (found) {
      count('users', false);
      return found.id;
    }
    return insert('users', { [key]: value, ...row() });
  };

  transaction(db, () => {
    // --- Студия ---
    // Настройки и режим работы создает миграция 002. Здесь — ссылка на карту и выключение
    // режима технических работ, чтобы сервисом можно было пользоваться при разработке.
    const settingsUpdated = db.prepare(`
      UPDATE settings SET map_url = ?, is_maintenance = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 1
    `).run('https://yandex.ru/maps/?text=' + encodeURIComponent('Москва, ул. Цветочная, 12')).changes;
    if (settingsUpdated !== 1) throw new Error('Нет строки настроек студии: примените миграции (npm run db:migrate)');

    // --- Пользователи: по одному на каждую роль и клиентка без учетной записи ---
    // Пароль хешируется так же, как при настоящей регистрации (argon2id), и только для нового пользователя.
    const consentAt = iso(addMinutes(now, -60 * 24 * 90));
    const adminId = ensureUser('email', 'admin@example.com', () => ({
      role: 'admin', name: 'Администратор студии',
      password_hash: hashPassword(options.adminPassword), email_verified_at: consentAt,
    }));
    // Учетная запись мастера Анны Ковалевой (роль «мастер», миграция 003).
    const annaUserId = ensureUser('email', 'anna@example.com', () => ({
      role: 'master', name: 'Анна Ковалева',
      password_hash: hashPassword(options.masterPassword), email_verified_at: consentAt,
    }));
    // Тестовая клиентка прототипа: зарегистрировалась сама, дала согласие на обработку данных.
    const mariaId = ensureUser('email', 'maria@example.com', () => ({
      role: 'client', name: 'Мария Кузнецова', phone: '+79112223344',
      password_hash: hashPassword(options.clientPassword), phone_verified_at: consentAt,
      pd_consent_at: consentAt, pd_consent_version: '2026-09-01', created_at: consentAt,
    }));
    // Сценарий 16: клиентку записал администратор по телефону, учетной записи и пароля у нее нет.
    const olgaId = ensureUser('phone', '+79035556677', () => ({ role: 'client', name: 'Ольга Белова' }));

    ensure('client_profiles', {
      user_id: mariaId, birth_date: '1994-05-12', acquisition_source: 'Инстаграм студии',
      // Без медицинских сведений: для них нужно отдельное согласие (решение 22).
      important_note: 'Предпочитает короткую форму ногтей',
    }, ['user_id']);

    for (const d of studioDays) {
      ensure('studio_day_overrides', {
        work_date: d.date, is_open: d.isOpen, open_time: d.open, close_time: d.close, reason: d.reason, created_by: adminId,
      }, ['work_date']);
    }

    // --- Каталог ---
    categories.forEach((c, i) => ensure('service_categories', { id: c.id, name: c.name, sort_order: i + 1 }, ['id']));
    services.forEach((s, i) => ensure('services', {
      id: s.id, category_id: s.categoryId, kind: s.addon ? 'addon' : 'main', name: s.name, description: s.description,
      duration_min: s.durationMin, cleanup_min: s.cleanupMin, price_master_kop: s.priceMaster, price_top_kop: s.priceTop,
      price_unit: s.addon ? 'за 2 ногтя' : null, max_quantity: s.addon ? 5 : 1,
      is_featured: s.featured ? 1 : 0, sort_order: i + 1,
    }, ['id']));
    for (const mainId of designMainServiceIds) {
      ensure('service_addon_rules', { addon_service_id: DESIGN_ID, main_service_id: mainId }, ['addon_service_id', 'main_service_id']);
    }
    ensure('service_incompatibilities', {
      service_a_id: 1, service_b_id: 8,
      reason: 'Маникюр с покрытием и наращивание ногтей выполняются на одних и тех же ногтях — выберите одну из услуг.',
    }, ['service_a_id', 'service_b_id']);

    // --- Мастера и график ---
    masters.forEach((m, i) => {
      ensure('masters', {
        id: m.id, name: m.name, level: m.level, specialty: m.specialty,
        experience_years: m.experienceYears, bio: m.bio, sort_order: i + 1,
      }, ['id']);
      for (const serviceId of m.serviceIds) {
        ensure('master_services', { master_id: m.id, service_id: serviceId }, ['master_id', 'service_id']);
      }
      // Прежний график закрывается днем накануне нового: периоды не пересекаются (триггер 10.6).
      m.schedules.forEach((schedule, j) => {
        const next = m.schedules[j + 1];
        for (const weekday of schedule.weekdays) {
          ensure('master_weekly_hours', {
            master_id: m.id, weekday, valid_from: schedule.validFrom, valid_to: next ? addDays(next.validFrom, -1) : null,
            start_time: schedule.start, end_time: schedule.end,
          }, ['master_id', 'weekday', 'valid_from']);
        }
      });
    });
    // Профиль Анны связывается с ее учетной записью, если связи еще нет.
    db.prepare('UPDATE masters SET user_id = ? WHERE id = 1 AND user_id IS NULL').run(annaUserId);

    // Заметка со слов мастера: вносит администратор, мастер указывается отдельно.
    ensure('client_notes', { client_id: mariaId, author_id: adminId, master_id: 1, text: 'Любит нюдовые оттенки' }, ['client_id', 'text']);
    // Фото в галерею без визита. Файлов на диске нет, в базе только пути.
    ensure('work_photos', {
      master_id: 1, service_id: 1, file_path: 'photos/seed/nude-manicure.jpg',
      title: 'Нюдовый маникюр', is_published: 1, sort_order: 2, uploaded_by: adminId,
    }, ['file_path']);

    // --- Регулярные блокировки (сценарии 1 и 3) на горизонт записи ---
    // Ключ — мастер, тип и начало: повторный запуск в другой день дополнит новые даты, не повторяя старые.
    const block = (masterId: number, type: string, startsAt: Date, endsAt: Date, comment: string | null = null) =>
      ensure('time_blocks', {
        master_id: masterId, block_type: type, starts_at: iso(startsAt), ends_at: iso(endsAt), comment, created_by: adminId,
      }, ['master_id', 'block_type', 'starts_at']);
    for (let i = 0; i < HORIZON_DAYS; i++) {
      const date = addDays(today, i);
      if (isoWeekday(date) === 4) block(1, 'lunch', studioTime(date, '13:00'), studioTime(date, '14:00'), 'Обед');
      if (isoWeekday(date) === 5) block(2, 'personal', studioTime(date, '15:00'), studioTime(date, '17:00'), 'Личное время');
    }

    // --- Сценарные данные: только в первый запуск ---
    if (db.prepare('SELECT 1 FROM bookings WHERE client_id = ?').get(mariaId)) return;
    report.scenarioCreated = true;

    // Елена выходит в ближайшую среду, хотя по графику работает вт, чт, сб (как в прототипе).
    insert('master_day_overrides', {
      master_id: 3, work_date: findWeekday(today, 3, 1), is_working: 1, start_time: '12:00', end_time: '19:00', created_by: adminId,
    });
    // Сценарии 3 и 8: выходной Елены в ближайшую субботу и отпуск на неделю.
    const elenaDayOff = findWeekday(today, 6, 0);
    insert('time_blocks', {
      master_id: 3, block_type: 'day_off', starts_at: iso(studioTime(elenaDayOff, '00:00')),
      ends_at: iso(studioTime(addDays(elenaDayOff, 1), '00:00')), comment: null, created_by: adminId,
    });
    insert('time_blocks', {
      master_id: 3, block_type: 'vacation', starts_at: iso(studioTime(addDays(today, 10), '00:00')),
      ends_at: iso(studioTime(addDays(today, 17), '00:00')), comment: 'Отпуск', created_by: adminId,
    });

    const serviceById = new Map(services.map((s) => [s.id, s]));
    const masterById = new Map(masters.map((m) => [m.id, m]));

    interface BookingSeed {
      clientId: number; masterId: number; date: string; time: string;
      items: { serviceId: number; quantity?: number }[];
      createdBy?: number; isAnyMaster?: boolean; comment?: string;
      /** Чем закончилась запись. Отмена хранится событием в журнале (раздел 5.21). */
      outcome?: { status: 'completed' | 'no_show' }
        | { status: 'cancelled_by_client' | 'cancelled_by_studio'; actorId: number; reason: string };
    }

    const addBooking = (b: BookingSeed): { bookingId: number; itemIds: number[] } => {
      const master = masterById.get(b.masterId)!;
      const startsAt = studioTime(b.date, b.time);
      const lines = b.items.map((item) => ({ ...item, service: serviceById.get(item.serviceId)! }));
      const durationMin = lines.reduce((sum, l) => sum + l.service.durationMin, 0);
      const cleanupMin = Math.max(...lines.map((l) => l.service.cleanupMin));
      const endsAt = addMinutes(startsAt, durationMin);
      const createdAt = iso(addMinutes(startsAt, -60 * 24 * 7) < now ? addMinutes(startsAt, -60 * 24 * 7) : now);

      // Строки пишут те же функции, что и API (booking/booking-service.ts). Правила API — бронь, 2 часа
      // до визита, правило 24 часов — тестовым данным не подходят: им нужна история в прошлом.
      // Запись создается действующей, итог визита фиксируется потом — так же, как в работе сервиса.
      const bookingId = insertBookingRows(db, {
        clientId: b.clientId, masterId: b.masterId, priceLevel: master.level, startsAt: iso(startsAt), cleanupMin,
        lines: lines.map((l) => ({
          serviceId: l.service.id, name: l.service.name, quantity: l.quantity ?? 1, durationMin: l.service.durationMin,
          unitPriceKop: master.level === 'top_master' ? l.service.priceTop : l.service.priceMaster,
        })),
        isAnyMaster: b.isAnyMaster, comment: b.comment ?? null, createdBy: b.createdBy ?? b.clientId, createdAt,
      });
      count('bookings', true);
      const itemIds = (db.prepare('SELECT id FROM booking_items WHERE booking_id = ? ORDER BY position').all(bookingId) as { id: number }[])
        .map((r) => { count('booking_items', true); return r.id; });

      const o = b.outcome;
      if (o) {
        if ('actorId' in o) {
          writeCancellation(db, {
            bookingId, version: 1, status: o.status, actorId: o.actorId, reason: o.reason, at: iso(addMinutes(startsAt, -60 * 24 * 2)),
          });
        } else {
          writeStatusChange(db, {
            bookingId, version: 1, oldStatus: 'active', status: o.status, actorId: adminId, reason: null, at: iso(endsAt),
          });
        }
        count('booking_events', true);
      }
      return { bookingId, itemIds };
    };

    // Прошедшие визиты Марии.
    addBooking({
      clientId: mariaId, masterId: 3, date: findWeekday(today, 4, -6, -1), time: '11:00',
      items: [{ serviceId: 7 }], outcome: { status: 'completed' },
    });
    const lamination = addBooking({
      clientId: mariaId, masterId: 2, date: findWeekday(today, 3, -21, -1), time: '12:00',
      items: [{ serviceId: 12 }], outcome: { status: 'completed' },
    });
    addBooking({
      clientId: mariaId, masterId: 2, date: findWeekday(today, 5, -49, -1), time: '11:00',
      items: [{ serviceId: 13 }], outcome: { status: 'no_show' },
    });
    addBooking({
      clientId: mariaId, masterId: 3, date: findWeekday(today, 2, -12, -1), time: '15:00',
      items: [{ serviceId: 2 }],
      outcome: { status: 'cancelled_by_client', actorId: mariaId, reason: 'Изменились планы' },
    });
    addBooking({
      clientId: mariaId, masterId: 1, date: findWeekday(today, 3, -30, -1), time: '14:00',
      items: [{ serviceId: 5 }],
      outcome: { status: 'cancelled_by_studio', actorId: adminId, reason: 'Мастер заболела' },
    });

    // Предстоящие визиты. Сценарий 1: маникюр у Анны, клиентка выбрала «Любой свободный мастер».
    const manicureDate = findWeekday(today, 3, 2);
    const manicure = addBooking({
      clientId: mariaId, masterId: 1, date: manicureDate, time: '12:00', isAnyMaster: true,
      items: [{ serviceId: 1 }], comment: 'Пожалуйста, покороче форму',
    });
    // Сценарий 5: клиентка сама перенесла эту запись с 12:00 на 10:00 — настоящим переносом, с событием в истории.
    writeReschedule(db, loadBooking(db, manicure.bookingId)!, {
      masterId: 1, level: 'master', startsAt: iso(studioTime(manicureDate, '10:00')), actorId: mariaId, reason: 'Удобнее утром', at: iso(now),
    });
    count('booking_events', true);

    // Сценарий 2: наращивание с дизайном на четыре ногтя: 2800 + 2 × 300 = 3400 ₽ (340 000 копеек), 180 минут.
    addBooking({
      clientId: mariaId, masterId: 1, date: findWeekday(today, 5, 2), time: '11:00',
      items: [{ serviceId: 8 }, { serviceId: DESIGN_ID, quantity: 2 }],
    });
    // Сценарий 16: администратор записал Ольгу по звонку.
    addBooking({
      clientId: olgaId, masterId: 1, date: findWeekday(today, 4, 2), time: '10:00', createdBy: adminId,
      items: [{ serviceId: 2 }],
    });

    // Фото с визита (сценарий 13), клиентка разрешила публикацию.
    insert('work_photos', {
      booking_item_id: lamination.itemIds[0]!, file_path: 'photos/seed/brows-lamination.jpg',
      title: 'Ламинирование бровей', is_published: 1, publish_consent_at: iso(now), sort_order: 1, uploaded_by: adminId,
    });
  });
  return report;
}
