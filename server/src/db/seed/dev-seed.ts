// Тестовые данные для разработки: студия, услуги, мастера, график, клиенты и записи
// из паспорта (docs/pasport-produkta.md) и моковых данных прототипа (Prototype/data.js).
// Записи и блокировки считаются от сегодняшнего дня, чтобы в календаре всегда были
// и прошедшие визиты, и предстоящие. Только для разработки: в production не запускается.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Db } from '../connection.js';

export interface SeedOptions {
  adminPassword: string;
  clientPassword: string;
  /** Текущий момент; параметр нужен, чтобы тесты могли зафиксировать дату. */
  now?: Date;
}

const TIMEZONE = 'Europe/Moscow';
const HORIZON_DAYS = 90;
const ADMIN_ID = 1;
const MARIA_ID = 2;
const OLGA_ID = 3;

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
  durationMin: number; cleanupMin: number; priceMaster: number; priceTop: number;
  addon?: boolean; featured?: boolean;
}

// id совпадают с номерами услуг прототипа: s1 → 1, s2 → 2 и т. д.
const services: Service[] = [
  { id: 1, categoryId: 1, name: 'Маникюр с покрытием гель-лаком', description: 'Классический уход и стойкое покрытие', durationMin: 90, cleanupMin: 15, priceMaster: 1800, priceTop: 2200, featured: true },
  { id: 2, categoryId: 1, name: 'Маникюр без покрытия', description: 'Аппаратный или комбинированный уход', durationMin: 45, cleanupMin: 15, priceMaster: 1200, priceTop: 1500, featured: true },
  { id: 3, categoryId: 1, name: 'Дизайн ногтей', description: 'Дополнение к маникюру, маникюру и педикюру или наращиванию', durationMin: 30, cleanupMin: 0, priceMaster: 300, priceTop: 300, addon: true, featured: true },
  { id: 4, categoryId: 1, name: 'Снятие покрытия', description: 'Аккуратное снятие гель-лака', durationMin: 20, cleanupMin: 15, priceMaster: 500, priceTop: 600 },
  { id: 5, categoryId: 2, name: 'Педикюр с покрытием', description: 'Уход за стопами и стойкое покрытие', durationMin: 90, cleanupMin: 15, priceMaster: 2200, priceTop: 2600, featured: true },
  { id: 6, categoryId: 2, name: 'Педикюр без покрытия', description: 'Уход за стопами без покрытия', durationMin: 60, cleanupMin: 15, priceMaster: 1600, priceTop: 1900 },
  { id: 7, categoryId: 2, name: 'Маникюр и педикюр', description: 'Комплексный уход за руками и ногами', durationMin: 150, cleanupMin: 15, priceMaster: 3200, priceTop: 3800 },
  { id: 8, categoryId: 3, name: 'Наращивание ногтей', description: 'Форма и длина по вашему желанию', durationMin: 150, cleanupMin: 15, priceMaster: 2800, priceTop: 3400, featured: true },
  { id: 9, categoryId: 3, name: 'Коррекция наращённых ногтей', description: 'Поддержание формы между визитами', durationMin: 90, cleanupMin: 15, priceMaster: 1800, priceTop: 2200 },
  { id: 10, categoryId: 3, name: 'Снятие наращённых ногтей', description: 'Бережное снятие материала', durationMin: 30, cleanupMin: 15, priceMaster: 600, priceTop: 700 },
  { id: 11, categoryId: 4, name: 'Коррекция и окрашивание бровей', description: 'Форма и цвет, подобранные под лицо', durationMin: 40, cleanupMin: 10, priceMaster: 1200, priceTop: 1500 },
  { id: 12, categoryId: 4, name: 'Ламинирование бровей', description: 'Ухоженный вид без макияжа', durationMin: 60, cleanupMin: 10, priceMaster: 1800, priceTop: 2100, featured: true },
  { id: 13, categoryId: 4, name: 'Коррекция бровей', description: 'Только форма, без окрашивания', durationMin: 20, cleanupMin: 10, priceMaster: 700, priceTop: 900 },
  { id: 14, categoryId: 4, name: 'Окрашивание бровей хной', description: 'Естественный стойкий цвет', durationMin: 30, cleanupMin: 10, priceMaster: 900, priceTop: 1100 },
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

/** Смещение часового пояса от UTC в миллисекундах в указанный момент. */
function tzOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallClockAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wallClockAsUtc - Math.floor(instant / 1000) * 1000;
}

/** Дата 'YYYY-MM-DD' и время 'HH:MM' по часам студии → момент в UTC. */
function studioTime(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wallClock = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(wallClock - tzOffsetMs(wallClock - tzOffsetMs(wallClock)));
}

/** Календарная дата студии в указанный момент. */
function studioDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(instant);
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** День недели по ISO: 1 — понедельник … 7 — воскресенье. */
function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

/** Ближайшая дата с этим днем недели через `minDays` дней или позже (назад — при отрицательном `step`). */
function findWeekday(from: string, weekday: number, minDays: number, step: 1 | -1 = 1): string {
  let date = addDays(from, minDays);
  while (isoWeekday(date) !== weekday || closedStudioDates.has(date)) date = addDays(date, step);
  return date;
}

const iso = (d: Date) => d.toISOString();
const addMinutes = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

/** Хеш пароля в формате прототипа. Сервер при входе сможет перевести его на argon2id (решение 36). */
function hashPassword(password: string): string {
  const iterations = 600_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Заполнение
// ---------------------------------------------------------------------------

export function seedDevData(db: Db, options: SeedOptions): void {
  const now = options.now ?? new Date();
  const today = studioDate(now);

  const usersCount = db.prepare('SELECT count(*) FROM users').pluck().get() as number;
  if (usersCount > 0) {
    throw new Error('В базе уже есть данные. Чтобы пересоздать базу с тестовыми данными: npm run db:reset');
  }

  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`;
    return Number(db.prepare(sql).run(row).lastInsertRowid);
  };

  db.transaction(() => {
    // --- Студия ---
    insert('settings', {
      id: 1, studio_name: 'Ноготочки', address: 'Москва, ул. Цветочная, 12', phone: '+79991234567',
      map_url: 'https://yandex.ru/maps/?text=' + encodeURIComponent('Москва, ул. Цветочная, 12'),
      timezone: TIMEZONE, slot_step_min: 30, booking_horizon_days: HORIZON_DAYS, min_lead_min: 120,
      client_change_deadline_hours: 24, slot_hold_min: 10,
    });
    for (let weekday = 2; weekday <= 6; weekday++) {
      insert('studio_hours', { weekday, open_time: '10:00', close_time: '20:00' });
    }

    // --- Пользователи ---
    const consentAt = iso(addMinutes(now, -60 * 24 * 90));
    insert('users', {
      id: ADMIN_ID, role: 'admin', name: 'Администратор студии', email: 'admin@example.com',
      password_hash: hashPassword(options.adminPassword), email_verified_at: consentAt,
    });
    // Тестовая клиентка прототипа: зарегистрировалась сама, дала согласие на обработку данных.
    insert('users', {
      id: MARIA_ID, role: 'client', name: 'Мария Кузнецова', phone: '+79112223344', email: 'maria@example.com',
      password_hash: hashPassword(options.clientPassword), phone_verified_at: consentAt,
      pd_consent_at: consentAt, pd_consent_version: '2026-09-01', created_at: consentAt,
    });
    // Сценарий 16: клиентку записал администратор по телефону, учетной записи и пароля у нее нет.
    insert('users', { id: OLGA_ID, role: 'client', name: 'Ольга Белова', phone: '+79035556677' });

    insert('client_profiles', {
      user_id: MARIA_ID, birth_date: '1994-05-12', acquisition_source: 'Инстаграм студии',
      // Без медицинских сведений: для них нужно отдельное согласие (решение 22).
      important_note: 'Предпочитает короткую форму ногтей',
    });

    for (const d of studioDays) {
      insert('studio_day_overrides', {
        work_date: d.date, is_open: d.isOpen, open_time: d.open, close_time: d.close, reason: d.reason, created_by: ADMIN_ID,
      });
    }

    // --- Каталог ---
    categories.forEach((c, i) => insert('service_categories', { id: c.id, name: c.name, sort_order: i + 1 }));
    services.forEach((s, i) => insert('services', {
      id: s.id, category_id: s.categoryId, kind: s.addon ? 'addon' : 'main', name: s.name, description: s.description,
      duration_min: s.durationMin, cleanup_min: s.cleanupMin, price_master_rub: s.priceMaster, price_top_rub: s.priceTop,
      price_unit: s.addon ? 'за 2 ногтя' : null, max_quantity: s.addon ? 5 : 1,
      is_featured: s.featured ? 1 : 0, sort_order: i + 1,
    }));
    for (const mainId of designMainServiceIds) {
      insert('service_addon_rules', { addon_service_id: DESIGN_ID, main_service_id: mainId });
    }
    insert('service_incompatibilities', {
      service_a_id: 1, service_b_id: 8,
      reason: 'Маникюр с покрытием и наращивание ногтей выполняются на одних и тех же ногтях — выберите одну из услуг.',
    });

    // --- Мастера и график ---
    masters.forEach((m, i) => {
      insert('masters', {
        id: m.id, name: m.name, level: m.level, specialty: m.specialty,
        experience_years: m.experienceYears, bio: m.bio, sort_order: i + 1,
      });
      for (const serviceId of m.serviceIds) insert('master_services', { master_id: m.id, service_id: serviceId });
      // Прежний график закрывается днем накануне нового: периоды не пересекаются (триггер 10.6).
      m.schedules.forEach((schedule, j) => {
        const next = m.schedules[j + 1];
        for (const weekday of schedule.weekdays) {
          insert('master_weekly_hours', {
            master_id: m.id, weekday, valid_from: schedule.validFrom, valid_to: next ? addDays(next.validFrom, -1) : null,
            start_time: schedule.start, end_time: schedule.end,
          });
        }
      });
    });

    // Заметка со слов мастера: у мастеров нет учетных записей, вносит администратор.
    insert('client_notes', { client_id: MARIA_ID, author_id: ADMIN_ID, master_id: 1, text: 'Любит нюдовые оттенки' });

    // Елена выходит в ближайшую среду, хотя по графику работает вт, чт, сб (как в прототипе).
    insert('master_day_overrides', {
      master_id: 3, work_date: findWeekday(today, 3, 1), is_working: 1, start_time: '12:00', end_time: '19:00', created_by: ADMIN_ID,
    });

    // --- Блокировки (сценарии 1, 3, 8) ---
    const block = (masterId: number, type: string, startsAt: Date, endsAt: Date, comment: string | null = null) =>
      insert('time_blocks', {
        master_id: masterId, block_type: type, starts_at: iso(startsAt), ends_at: iso(endsAt), comment, created_by: ADMIN_ID,
      });
    for (let i = 0; i < HORIZON_DAYS; i++) {
      const date = addDays(today, i);
      if (isoWeekday(date) === 4) block(1, 'lunch', studioTime(date, '13:00'), studioTime(date, '14:00'), 'Обед');
      if (isoWeekday(date) === 5) block(2, 'personal', studioTime(date, '15:00'), studioTime(date, '17:00'), 'Личное время');
    }
    const elenaDayOff = findWeekday(today, 6, 0);
    block(3, 'day_off', studioTime(elenaDayOff, '00:00'), studioTime(addDays(elenaDayOff, 1), '00:00'));
    block(3, 'vacation', studioTime(addDays(today, 10), '00:00'), studioTime(addDays(today, 17), '00:00'), 'Отпуск');

    // --- Записи ---
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

      // Запись создается действующей, итог визита фиксируется потом — так же, как в работе сервиса.
      const bookingId = insert('bookings', {
        client_id: b.clientId, master_id: b.masterId, is_any_master: b.isAnyMaster ? 1 : 0,
        starts_at: iso(startsAt), ends_at: iso(endsAt), busy_until: iso(addMinutes(endsAt, cleanupMin)),
        price_level: master.level, comment: b.comment ?? null, created_by: b.createdBy ?? b.clientId,
        created_at: createdAt, updated_at: createdAt,
      });
      const itemIds = lines.map((l, i) => {
        const unit = master.level === 'top_master' ? l.service.priceTop : l.service.priceMaster;
        const quantity = l.quantity ?? 1;
        return insert('booking_items', {
          booking_id: bookingId, service_id: l.service.id, position: i + 1, service_name: l.service.name,
          unit_price_rub: unit, quantity, price_rub: unit * quantity, duration_min: l.service.durationMin,
        });
      });

      const o = b.outcome;
      if (o) {
        let at: string;
        if ('actorId' in o) {
          // Сначала событие отмены, потом статус — иначе триггер 10.7 отклонит смену статуса.
          at = iso(addMinutes(startsAt, -60 * 24 * 2));
          insert('booking_events', {
            booking_id: bookingId, event_type: 'cancelled', actor_id: o.actorId,
            old_status: 'active', new_status: o.status, reason: o.reason, created_at: at,
          });
        } else {
          at = iso(endsAt);
          insert('booking_events', {
            booking_id: bookingId, event_type: 'status_changed', actor_id: ADMIN_ID,
            old_status: 'active', new_status: o.status, created_at: at,
          });
        }
        db.prepare('UPDATE bookings SET status = ?, version = version + 1, updated_at = ? WHERE id = ?')
          .run(o.status, at, bookingId);
      }
      return { bookingId, itemIds };
    };

    // Прошедшие визиты Марии.
    addBooking({
      clientId: MARIA_ID, masterId: 3, date: findWeekday(today, 4, -6, -1), time: '11:00',
      items: [{ serviceId: 7 }], outcome: { status: 'completed' },
    });
    const lamination = addBooking({
      clientId: MARIA_ID, masterId: 2, date: findWeekday(today, 3, -21, -1), time: '12:00',
      items: [{ serviceId: 12 }], outcome: { status: 'completed' },
    });
    addBooking({
      clientId: MARIA_ID, masterId: 2, date: findWeekday(today, 5, -49, -1), time: '11:00',
      items: [{ serviceId: 13 }], outcome: { status: 'no_show' },
    });
    addBooking({
      clientId: MARIA_ID, masterId: 3, date: findWeekday(today, 2, -12, -1), time: '15:00',
      items: [{ serviceId: 2 }],
      outcome: { status: 'cancelled_by_client', actorId: MARIA_ID, reason: 'Изменились планы' },
    });
    addBooking({
      clientId: MARIA_ID, masterId: 1, date: findWeekday(today, 3, -30, -1), time: '14:00',
      items: [{ serviceId: 5 }],
      outcome: { status: 'cancelled_by_studio', actorId: ADMIN_ID, reason: 'Мастер заболела' },
    });

    // Предстоящие визиты. Сценарий 1: маникюр у Анны, клиентка выбрала «Любой свободный мастер».
    const manicureDate = findWeekday(today, 3, 2);
    const manicure = addBooking({
      clientId: MARIA_ID, masterId: 1, date: manicureDate, time: '10:00', isAnyMaster: true,
      items: [{ serviceId: 1 }], comment: 'Пожалуйста, покороче форму',
    });
    // Сценарий 5: клиентка сама перенесла эту запись с 12:00 на 10:00.
    insert('booking_events', {
      booking_id: manicure.bookingId, event_type: 'rescheduled', actor_id: MARIA_ID,
      old_master_id: 1, new_master_id: 1,
      old_starts_at: iso(studioTime(manicureDate, '12:00')), new_starts_at: iso(studioTime(manicureDate, '10:00')),
      reason: 'Удобнее утром',
    });
    db.prepare('UPDATE bookings SET version = version + 1 WHERE id = ?').run(manicure.bookingId);

    // Сценарий 2: наращивание с дизайном на четыре ногтя: 2800 + 2 × 300 = 3400 ₽, 180 минут.
    addBooking({
      clientId: MARIA_ID, masterId: 1, date: findWeekday(today, 5, 2), time: '11:00',
      items: [{ serviceId: 8 }, { serviceId: DESIGN_ID, quantity: 2 }],
    });
    // Сценарий 16: администратор записал Ольгу по звонку.
    addBooking({
      clientId: OLGA_ID, masterId: 1, date: findWeekday(today, 4, 2), time: '10:00', createdBy: ADMIN_ID,
      items: [{ serviceId: 2 }],
    });

    // --- Фото работ (сценарий 13). Файлов на диске нет, в базе только пути. ---
    insert('work_photos', {
      booking_item_id: lamination.itemIds[0], file_path: 'photos/seed/brows-lamination.jpg',
      title: 'Ламинирование бровей', is_published: 1, publish_consent_at: iso(now), sort_order: 1, uploaded_by: ADMIN_ID,
    });
    insert('work_photos', {
      master_id: 1, service_id: 1, file_path: 'photos/seed/nude-manicure.jpg',
      title: 'Нюдовый маникюр', is_published: 1, sort_order: 2, uploaded_by: ADMIN_ID,
    });
  }).immediate();
}
