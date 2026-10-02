// Каталог студии: категории, услуги, правила опции «Дизайн ногтей», несовместимые услуги,
// мастера с их услугами и недельным графиком. Данные — из паспорта (docs/pasport-produkta.md)
// и прототипа; это тот же каталог, который виден на локальной машине.
//
// Отсюда его берут двое:
//   npm run setup:catalog (scripts/setup-catalog.ts) — заполнение каталога на сервере;
//   тестовые данные для разработки (db/seed/dev-seed.ts) — они добавляют к каталогу еще
//     учетные записи, записи клиентов, фото и блокировки, и в production не загружаются.
//
// Учетных записей, клиентов и записей здесь нет намеренно: на работающем сервере им не место.
// Заполнение повторяемое: каждая строка ищется по своему ключу и добавляется, только если ее нет;
// существующие строки не меняются — цену, которую администратор поправил в панели, команда не вернет.
import type { SQLInputValue } from 'node:sqlite';
import { addDays } from '../lib/studio-time.js';
import { type Db, transaction } from './connection.js';

export const categories = [
  { id: 1, name: 'Маникюр' },
  { id: 2, name: 'Педикюр' },
  { id: 3, name: 'Наращивание' },
  { id: 4, name: 'Брови' },
];

export interface Service {
  id: number; categoryId: number; name: string; description: string;
  /** Цены — в копейках, как в базе: 1800_00 — это 1800 ₽. */
  durationMin: number; cleanupMin: number; priceMaster: number; priceTop: number;
  addon?: boolean; featured?: boolean;
}

// id совпадают с номерами услуг прототипа: s1 → 1, s2 → 2 и т. д.
export const services: Service[] = [
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

export const DESIGN_ID = 3;
/** «Дизайн ногтей» доступен с маникюром, маникюром и педикюром или наращиванием (паспорт, функция 3). */
export const designMainServiceIds = [1, 2, 7, 8];

type Level = 'master' | 'top_master';

/** Недельный график, который действует с даты `validFrom` до начала следующего графика мастера. */
interface Schedule {
  validFrom: string;
  /** Рабочие дни по ISO: 1 — понедельник … 7 — воскресенье. */
  weekdays: number[]; start: string; end: string;
}

export interface Master {
  id: number; name: string; level: Level; specialty: string; experienceYears: number; bio: string;
  /** Графики по возрастанию даты начала. */
  schedules: Schedule[]; serviceIds: number[];
}

export const masters: Master[] = [
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

/** Сколько строк каждой таблицы добавлено и сколько уже было. */
export type CatalogReport = Map<string, { created: number; existing: number }>;

/**
 * Заполняет каталог: категории, услуги, правила опции, несовместимые услуги, мастеров с их
 * услугами и графиком. Повторный запуск ничего не меняет.
 *
 * `count` — куда сообщать о каждой строке; тестовые данные передают свой счетчик, чтобы в их
 * отчете каталог был посчитан вместе с остальным.
 */
export function seedCatalog(db: Db, options: { count?: (table: string, created: boolean) => void } = {}): CatalogReport {
  const report: CatalogReport = new Map();
  const count = (table: string, created: boolean) => {
    const stat = report.get(table) ?? { created: 0, existing: 0 };
    stat[created ? 'created' : 'existing']++;
    report.set(table, stat);
    options.count?.(table, created);
  };

  /**
   * Добавляет строку, если строки с такими же значениями полей `keys` еще нет.
   * Проверка идет запросом, а не INSERT OR IGNORE: триггеры BEFORE INSERT срабатывают до проверки
   * уникальности и отклонили бы повтор с ошибкой.
   */
  const ensure = (table: string, row: Record<string, SQLInputValue>, keys: string[]): void => {
    const where = keys.map((k) => `${k} = @${k}`).join(' AND ');
    const params = Object.fromEntries(keys.map((k) => [k, row[k]!]));
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${where}`).get(params)) {
      count(table, false);
      return;
    }
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
    count(table, true);
  };

  // Внутри уже открытой транзакции (тестовые данные) это точка сохранения, а не вторая транзакция.
  transaction(db, () => {
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
  });

  return report;
}
