// Управление услугами (паспорт, функция 2 администратора; экраны A-23, A-24).
// Услуги не удаляются: на них ссылаются созданные записи. Вместо удаления — isActive: false,
// отключенная услуга пропадает из новых записей, но остается в созданных (сценарий 7).
import type { Db } from '../db/connection.js';
import { transaction } from '../db/connection.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { pathId, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { requireRole } from './guards.js';

/** Верхняя граница цены — 1 млн ₽: защита от опечатки с лишними нулями. */
const MAX_PRICE_KOP = 100_000_000;

interface ServiceRow {
  id: number;
  category_id: number;
  kind: 'main' | 'addon';
  name: string;
  description: string | null;
  cleanup_min: number;
  duration_min: number;
  price_master_kop: number;
  price_top_kop: number;
  price_unit: string | null;
  max_quantity: number;
  photo_url: string | null;
  is_featured: number;
  sort_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function serviceView(db: Db, s: ServiceRow) {
  const masterIds = (db.prepare('SELECT master_id FROM master_services WHERE service_id = ? ORDER BY master_id').all(s.id) as
    { master_id: number }[]).map((r) => r.master_id);
  const addonFor = (db.prepare('SELECT main_service_id FROM service_addon_rules WHERE addon_service_id = ? ORDER BY 1').all(s.id) as
    { main_service_id: number }[]).map((r) => r.main_service_id);
  return {
    id: s.id, categoryId: s.category_id, kind: s.kind, name: s.name, description: s.description,
    durationMin: s.duration_min, cleanupMin: s.cleanup_min,
    priceMasterKop: s.price_master_kop, priceTopKop: s.price_top_kop, priceUnit: s.price_unit,
    maxQuantity: s.max_quantity, photoUrl: s.photo_url, isFeatured: s.is_featured === 1, sortOrder: s.sort_order,
    isActive: s.is_active === 1, masterIds,
    ...(s.kind === 'addon' ? { addonForServiceIds: addonFor } : {}),
    createdAt: s.created_at, updatedAt: s.updated_at,
  };
}

const getService = (db: Db, id: number) => db.prepare('SELECT * FROM services WHERE id = ?').get(id) as unknown as ServiceRow | undefined;

/** Поля услуги из тела запроса. При создании обязательны основные поля, в PATCH все необязательны. */
function readServiceFields(input: Input, creating: boolean) {
  const req = { optional: !creating } as const;
  return {
    categoryId: input.id('categoryId', req),
    kind: creating ? input.oneOf('kind', ['main', 'addon'] as const) : undefined,
    name: input.string('name', { ...req, max: 100 }),
    description: input.string('description', { optional: true, nullable: true, max: 1000 }),
    durationMin: input.int('durationMin', { ...req, min: 1, max: 600 }),
    cleanupMin: input.int('cleanupMin', { optional: true, min: 0, max: 60 }),
    priceMasterKop: input.int('priceMasterKop', { ...req, min: 0, max: MAX_PRICE_KOP }),
    priceTopKop: input.int('priceTopKop', { ...req, min: 0, max: MAX_PRICE_KOP }),
    priceUnit: input.string('priceUnit', { optional: true, nullable: true, max: 50 }),
    maxQuantity: input.int('maxQuantity', { optional: true, min: 1, max: 100 }),
    photoUrl: input.string('photoUrl', { optional: true, nullable: true, max: 500 }),
    isFeatured: input.bool('isFeatured', { optional: true }),
    sortOrder: input.int('sortOrder', { optional: true, min: 0, max: 100_000 }),
    isActive: input.bool('isActive', { optional: true }),
    masterIds: input.ids('masterIds', { optional: true }),
    addonForServiceIds: input.ids('addonForServiceIds', { optional: true }),
  };
}

type ServiceFields = ReturnType<typeof readServiceFields>;

/** Проверки, которым нужна база: категория, мастера и основные услуги существуют, имя не занято. */
function checkReferences(db: Db, f: ServiceFields, kind: 'main' | 'addon', selfId: number | null): void {
  if (f.categoryId !== undefined && !db.prepare('SELECT 1 FROM service_categories WHERE id = ?').get(f.categoryId)) {
    throw badRequest('CATEGORY_NOT_FOUND', 'Категория не найдена', { categoryId: f.categoryId });
  }
  // COLLATE NOCASE у services.name в SQLite не различает регистр только латиницы: «Маникюр» и «маникюр»
  // для базы — разные названия. Поэтому названия сравниваются здесь, без учета регистра любых букв.
  if (f.name !== undefined) {
    const wanted = f.name.toLocaleLowerCase('ru');
    const names = db.prepare('SELECT name FROM services WHERE id IS NOT ?').all(selfId) as { name: string }[];
    if (names.some((r) => r.name.toLocaleLowerCase('ru') === wanted)) throw conflict('SERVICE_NAME_TAKEN', 'Услуга с таким названием уже есть');
  }
  if (f.masterIds?.length) {
    const found = db.prepare(`SELECT count(*) AS n FROM masters WHERE id IN (${f.masterIds.map(() => '?').join(', ')})`)
      .get(...f.masterIds) as { n: number };
    if (found.n !== f.masterIds.length) throw badRequest('MASTER_NOT_FOUND', 'Один из мастеров не найден', { masterIds: f.masterIds });
  }
  if (f.addonForServiceIds !== undefined) {
    if (kind !== 'addon') throw badRequest('WRONG_SERVICE_KIND', 'Список «к каким услугам можно добавить» бывает только у опции');
    if (f.addonForServiceIds.length) {
      const found = db.prepare(`SELECT count(*) AS n FROM services WHERE kind = 'main' AND id IN (${f.addonForServiceIds.map(() => '?').join(', ')})`)
        .get(...f.addonForServiceIds) as { n: number };
      if (found.n !== f.addonForServiceIds.length) {
        throw badRequest('WRONG_SERVICE_KIND', 'Опцию можно привязать только к существующим основным услугам', { serviceIds: f.addonForServiceIds });
      }
    }
  }
}

/** Заменяет мастеров услуги и правила опции, если они переданы. */
function saveLinks(db: Db, serviceId: number, f: ServiceFields): void {
  if (f.masterIds !== undefined) {
    db.prepare('DELETE FROM master_services WHERE service_id = ?').run(serviceId);
    const insert = db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)');
    for (const masterId of f.masterIds) insert.run(masterId, serviceId);
  }
  if (f.addonForServiceIds !== undefined) {
    db.prepare('DELETE FROM service_addon_rules WHERE addon_service_id = ?').run(serviceId);
    const insert = db.prepare('INSERT INTO service_addon_rules (addon_service_id, main_service_id) VALUES (?, ?)');
    for (const mainId of f.addonForServiceIds) insert.run(serviceId, mainId);
  }
}

/** Правила, связывающие поля: цена топ-мастера не ниже цены мастера, количество больше 1 — только у опции. */
function checkCombination(input: Input, v: { kind: string; priceMasterKop: number; priceTopKop: number; maxQuantity: number }): void {
  if (v.priceTopKop < v.priceMasterKop) input.fail('priceTopKop', 'Цена у топ-мастера не может быть ниже цены у мастера');
  if (v.kind === 'main' && v.maxQuantity !== 1) input.fail('maxQuantity', 'Количество больше 1 бывает только у опции');
}

export function adminServiceRoutes(router: Router): void {
  router.get('/api/admin/services', (ctx): Result => {
    requireRole(ctx, 'admin');
    const categories = ctx.db.prepare('SELECT id, name, sort_order, is_active FROM service_categories ORDER BY sort_order, id').all() as
      { id: number; name: string; sort_order: number; is_active: number }[];
    const services = ctx.db.prepare('SELECT * FROM services ORDER BY category_id, sort_order, id').all() as unknown as ServiceRow[];
    const pairs = ctx.db.prepare('SELECT service_a_id, service_b_id, reason FROM service_incompatibilities ORDER BY 1, 2').all() as
      { service_a_id: number; service_b_id: number; reason: string }[];
    return {
      status: 200,
      body: {
        categories: categories.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sort_order, isActive: c.is_active === 1 })),
        services: services.map((s) => serviceView(ctx.db, s)),
        incompatibilities: pairs.map((p) => ({ serviceIds: [p.service_a_id, p.service_b_id], reason: p.reason })),
      },
    };
  });

  router.post('/api/admin/services', (ctx): Result => {
    requireRole(ctx, 'admin');
    const input = Input.body(ctx.body);
    const f = readServiceFields(input, true);
    if (input.valid) {
      checkCombination(input, { kind: f.kind!, priceMasterKop: f.priceMasterKop!, priceTopKop: f.priceTopKop!, maxQuantity: f.maxQuantity ?? 1 });
    }
    input.done();

    const now = ctx.now.toISOString();
    const id = transaction(ctx.db, () => {
      checkReferences(ctx.db, f, f.kind!, null);
      const id = Number(ctx.db.prepare(`
        INSERT INTO services (category_id, kind, name, description, cleanup_min, duration_min, price_master_kop, price_top_kop,
                              price_unit, max_quantity, photo_url, is_featured, sort_order, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(f.categoryId!, f.kind!, f.name!, f.description ?? null, f.cleanupMin ?? 0, f.durationMin!, f.priceMasterKop!,
        f.priceTopKop!, f.priceUnit ?? null, f.maxQuantity ?? 1, f.photoUrl ?? null, f.isFeatured ? 1 : 0, f.sortOrder ?? 0,
        f.isActive === false ? 0 : 1, now, now).lastInsertRowid);
      saveLinks(ctx.db, id, f);
      return id;
    });
    return { status: 201, body: { service: serviceView(ctx.db, getService(ctx.db, id)!) } };
  });

  // Изменение услуги. Передаются только меняемые поля; masterIds и addonForServiceIds заменяют список целиком.
  // Цены созданных записей не меняются: они скопированы в запись (сценарий 7).
  router.patch('/api/admin/services/:id', (ctx): Result => {
    requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const f = readServiceFields(input, false);
    input.done();

    const now = ctx.now.toISOString();
    transaction(ctx.db, () => {
      const current = getService(ctx.db, id);
      if (!current) throw notFound('Услуга не найдена');
      // Правила, связывающие поля, проверяются по итоговым значениям: новым, а где их нет — текущим.
      const check = Input.body({});
      checkCombination(check, {
        kind: current.kind,
        priceMasterKop: f.priceMasterKop ?? current.price_master_kop,
        priceTopKop: f.priceTopKop ?? current.price_top_kop,
        maxQuantity: f.maxQuantity ?? current.max_quantity,
      });
      check.done();
      checkReferences(ctx.db, f, current.kind, id);

      const set: Record<string, string | number | null> = {};
      const put = (column: string, value: string | number | null | undefined) => {
        if (value !== undefined) set[column] = value;
      };
      put('category_id', f.categoryId);
      put('name', f.name);
      put('description', f.description);
      put('duration_min', f.durationMin);
      put('cleanup_min', f.cleanupMin);
      put('price_master_kop', f.priceMasterKop);
      put('price_top_kop', f.priceTopKop);
      put('price_unit', f.priceUnit);
      put('max_quantity', f.maxQuantity);
      put('photo_url', f.photoUrl);
      put('is_featured', f.isFeatured === undefined ? undefined : f.isFeatured ? 1 : 0);
      put('sort_order', f.sortOrder);
      put('is_active', f.isActive === undefined ? undefined : f.isActive ? 1 : 0);
      const columns = Object.keys(set);
      if (columns.length > 0) {
        ctx.db.prepare(`UPDATE services SET ${columns.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
          .run({ ...set, updated_at: now, id });
      }
      saveLinks(ctx.db, id, f);
    });
    return { status: 200, body: { service: serviceView(ctx.db, getService(ctx.db, id)!) } };
  });

  // Несовместимые услуги (паспорт, функция 2): пара хранится одной строкой, меньший номер первым (раздел 5.12).
  router.post('/api/admin/service-incompatibilities', (ctx): Result => {
    requireRole(ctx, 'admin');
    const input = Input.body(ctx.body);
    const serviceIds = input.ids('serviceIds', { max: 2 });
    const reason = input.string('reason', { max: 500 });
    if (serviceIds && serviceIds.length !== 2) input.fail('serviceIds', 'Нужны номера двух разных услуг');
    input.done();

    const [a, b] = [Math.min(...serviceIds), Math.max(...serviceIds)];
    transaction(ctx.db, () => {
      const found = ctx.db.prepare('SELECT count(*) AS n FROM services WHERE id IN (?, ?)').get(a, b) as { n: number };
      if (found.n !== 2) throw badRequest('SERVICE_NOT_FOUND', 'Услуга не найдена', { serviceIds: [a, b] });
      if (ctx.db.prepare('SELECT 1 FROM service_incompatibilities WHERE service_a_id = ? AND service_b_id = ?').get(a, b)) {
        throw conflict('ALREADY_EXISTS', 'Эти услуги уже отмечены как несовместимые');
      }
      ctx.db.prepare('INSERT INTO service_incompatibilities (service_a_id, service_b_id, reason) VALUES (?, ?, ?)').run(a, b, reason);
    });
    return { status: 201, body: { incompatibility: { serviceIds: [a, b], reason } } };
  });

  router.delete('/api/admin/service-incompatibilities/:a/:b', (ctx): Result => {
    requireRole(ctx, 'admin');
    const [x, y] = [pathId(ctx, 'a'), pathId(ctx, 'b')];
    const deleted = ctx.db.prepare('DELETE FROM service_incompatibilities WHERE service_a_id = ? AND service_b_id = ?')
      .run(Math.min(x, y), Math.max(x, y)).changes;
    if (deleted === 0) throw notFound('Такой пары несовместимых услуг нет');
    return { status: 204 };
  });
}
