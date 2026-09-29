// Фото работ (паспорт, функция 8 администратора; экран A-12; сценарий 13): фото к услуге завершенного
// визита или прямо в галерею, подпись, публикация в «Наших работах» и в профиле мастера.
// Фото с визита публикуется только с отметкой о согласии клиента — это же правило держит CHECK в базе.
//
// Загрузка — само изображение в теле запроса (Content-Type: image/jpeg, image/png или image/webp),
// параметры — в строке запроса. Так не нужен разбор multipart и сторонние пакеты:
//   fetch('/api/admin/photos?bookingItemId=12&title=…', { method: 'POST', body: file, headers: { 'Content-Type': file.type } })
import { hasRole } from '../auth/sessions.js';
import type { Db } from '../db/connection.js';
import { transaction } from '../db/connection.js';
import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';
import { pathId, type Result, type Router } from '../http/router.js';
import { Input } from '../http/validate.js';
import { deletePhotoFile, detectImageType, MAX_PHOTO_BYTES, PHOTO_TYPES, readPhoto, savePhoto } from '../storage/photos.js';
import { requireRole } from './guards.js';

interface PhotoRow {
  id: number;
  booking_item_id: number | null;
  booking_id: number | null;
  booking_status: string | null;
  file_path: string;
  title: string | null;
  is_published: number;
  publish_consent_at: string | null;
  sort_order: number;
  uploaded_by: number;
  created_at: string;
  master_id: number;
  master_name: string;
  service_id: number | null;
  service_name: string | null;
}

/** Фото с мастером и услугой: у фото с визита они берутся из записи (раздел 5.22), у фото галереи — из самого фото. */
const PHOTO_SELECT = `
  SELECT p.id, p.booking_item_id, bi.booking_id, b.status AS booking_status, p.file_path, p.title, p.is_published,
         p.publish_consent_at, p.sort_order, p.uploaded_by, p.created_at,
         coalesce(b.master_id, p.master_id) AS master_id, m.name AS master_name,
         coalesce(bi.service_id, p.service_id) AS service_id, coalesce(bi.service_name, s.name) AS service_name
  FROM work_photos p
  LEFT JOIN booking_items bi ON bi.id = p.booking_item_id
  LEFT JOIN bookings b ON b.id = bi.booking_id
  LEFT JOIN services s ON s.id = p.service_id
  JOIN masters m ON m.id = coalesce(b.master_id, p.master_id)`;

const fileUrl = (id: number) => `/api/photos/${id}/file`;

function adminView(p: PhotoRow) {
  return {
    id: p.id, url: fileUrl(p.id), title: p.title, isPublished: p.is_published === 1,
    publishConsentAt: p.publish_consent_at, sortOrder: p.sort_order,
    bookingId: p.booking_id, bookingItemId: p.booking_item_id,
    master: { id: p.master_id, name: p.master_name },
    service: p.service_id === null ? null : { id: p.service_id, name: p.service_name },
    createdAt: p.created_at,
  };
}

function getPhoto(db: Db, id: number): PhotoRow | undefined {
  return db.prepare(`${PHOTO_SELECT} WHERE p.id = ?`).get(id) as PhotoRow | undefined;
}

export function photoRoutes(router: Router): void {
  // Галерея «Наши работы» и работы мастера (PUB-01, PUB-05): только опубликованные фото.
  router.get('/api/gallery', (ctx): Result => {
    const input = Input.query(ctx.query);
    const masterId = input.id('masterId', { optional: true });
    const limit = input.int('limit', { optional: true, min: 1, max: 200 }) ?? 60;
    input.done();
    const rows = ctx.db.prepare(`${PHOTO_SELECT}
      WHERE p.is_published = 1 AND m.is_active = 1 AND (@master IS NULL OR m.id = @master)
      ORDER BY p.sort_order, p.created_at DESC, p.id DESC LIMIT @limit
    `).all({ master: masterId ?? null, limit }) as unknown as PhotoRow[];
    return {
      status: 200,
      body: {
        photos: rows.map((p) => ({
          id: p.id, url: fileUrl(p.id), title: p.title,
          master: { id: p.master_id, name: p.master_name },
          service: p.service_id === null ? null : { id: p.service_id, name: p.service_name },
        })),
      },
    };
  });

  // Файл фото. Опубликованное видят все, неопубликованное — только администратор: снимок с визита
  // связан с конкретным клиентом. Для остальных такого фото «нет» (404), чтобы не выдавать номера.
  router.get('/api/photos/:id/file', (ctx): Result => {
    const photo = getPhoto(ctx.db, pathId(ctx));
    const isAdmin = ctx.user !== null && hasRole(ctx.user, 'admin');
    if (!photo || (!photo.is_published && !isAdmin)) throw notFound('Фото не найдено');
    const file = readPhoto(ctx.services.uploadsDir, photo.file_path);
    if (!file) throw notFound('Файл фото не найден');
    return { status: 200, file: { ...file, cache: photo.is_published ? 'public' : 'private' } };
  });

  router.get('/api/admin/photos', (ctx): Result => {
    requireRole(ctx, 'admin');
    const input = Input.query(ctx.query);
    const bookingId = input.id('bookingId', { optional: true });
    const clientId = input.id('clientId', { optional: true });
    const masterId = input.id('masterId', { optional: true });
    const published = input.bool('published', { optional: true });
    input.done();
    const rows = ctx.db.prepare(`${PHOTO_SELECT}
      WHERE (@booking IS NULL OR bi.booking_id = @booking) AND (@client IS NULL OR b.client_id = @client)
        AND (@master IS NULL OR m.id = @master) AND (@published IS NULL OR p.is_published = @published)
      ORDER BY p.created_at DESC, p.id DESC
    `).all({
      booking: bookingId ?? null, client: clientId ?? null, master: masterId ?? null,
      published: published === undefined ? null : published ? 1 : 0,
    }) as unknown as PhotoRow[];
    return { status: 200, body: { photos: rows.map(adminView) } };
  });

  // Загрузка: ?bookingItemId=… — фото услуги завершенного визита; ?masterId=…&serviceId=… — прямо в галерею.
  router.post('/api/admin/photos', (ctx): Result => {
    const user = requireRole(ctx, 'admin');
    const input = Input.query(ctx.query);
    const bookingItemId = input.id('bookingItemId', { optional: true });
    const masterId = input.id('masterId', { optional: true });
    const serviceId = input.id('serviceId', { optional: true });
    const title = input.string('title', { optional: true, max: 200 }) ?? null;
    if ((bookingItemId === undefined) === (masterId === undefined)) input.fail('bookingItemId', 'Укажите либо услугу визита (bookingItemId), либо мастера (masterId)');
    if (bookingItemId !== undefined && serviceId !== undefined) input.fail('serviceId', 'У фото с визита услуга берется из записи');
    input.done();

    const data = ctx.rawBody!.data;
    const type = detectImageType(data);
    if (!type) throw new HttpError(415, 'NOT_AN_IMAGE', 'Файл не похож на изображение JPEG, PNG или WebP');

    // Проверки до записи файла: не оставлять на диске файлы без строки в базе.
    if (bookingItemId !== undefined) {
      const item = ctx.db.prepare(`
        SELECT b.status FROM booking_items bi JOIN bookings b ON b.id = bi.booking_id WHERE bi.id = ?
      `).get(bookingItemId) as { status: string } | undefined;
      if (!item) throw badRequest('BOOKING_ITEM_NOT_FOUND', 'Услуга визита не найдена', { bookingItemId });
      if (item.status !== 'completed') throw conflict('VISIT_NOT_COMPLETED', 'Фото добавляются к завершенному визиту');
    } else {
      if (!ctx.db.prepare('SELECT 1 FROM masters WHERE id = ?').get(masterId!)) throw badRequest('MASTER_NOT_FOUND', 'Мастер не найден', { masterId });
      if (serviceId !== undefined && !ctx.db.prepare('SELECT 1 FROM services WHERE id = ?').get(serviceId)) {
        throw badRequest('SERVICE_NOT_FOUND', 'Услуга не найдена', { serviceId });
      }
    }

    const filePath = savePhoto(ctx.services.uploadsDir, data, type, ctx.now);
    try {
      const id = transaction(ctx.db, () => {
        const { next } = ctx.db.prepare('SELECT coalesce(max(sort_order), 0) + 1 AS next FROM work_photos').get() as { next: number };
        return Number(ctx.db.prepare(`
          INSERT INTO work_photos (booking_item_id, master_id, service_id, file_path, title, sort_order, uploaded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(bookingItemId ?? null, masterId ?? null, serviceId ?? null, filePath, title, next, user.id, ctx.now.toISOString()).lastInsertRowid);
      });
      return { status: 201, body: { photo: adminView(getPhoto(ctx.db, id)!) } };
    } catch (error) {
      deletePhotoFile(ctx.services.uploadsDir, filePath);
      throw error;
    }
  }, { types: PHOTO_TYPES, maxBytes: MAX_PHOTO_BYTES });

  // Подпись, согласие клиента, публикация и порядок в галерее. Без согласия фото с визита не публикуется;
  // отзыв согласия снимает фото с публикации.
  router.patch('/api/admin/photos/:id', (ctx): Result => {
    requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const input = Input.body(ctx.body);
    const title = input.string('title', { optional: true, nullable: true, max: 200 });
    const isPublished = input.bool('isPublished', { optional: true });
    const publishConsent = input.bool('publishConsent', { optional: true });
    const sortOrder = input.int('sortOrder', { optional: true, min: 0, max: 1_000_000 });
    input.done();

    const now = ctx.now.toISOString();
    transaction(ctx.db, () => {
      const photo = getPhoto(ctx.db, id);
      if (!photo) throw notFound('Фото не найдено');
      if (publishConsent !== undefined && photo.booking_item_id === null) {
        throw badRequest('CONSENT_NOT_APPLICABLE', 'Согласие клиента отмечается только у фото с визита');
      }
      const consentAt = publishConsent === undefined ? photo.publish_consent_at : publishConsent ? (photo.publish_consent_at ?? now) : null;
      let published = isPublished === undefined ? photo.is_published === 1 : isPublished;
      if (publishConsent === false) published = false;
      if (published && photo.booking_item_id !== null && consentAt === null) {
        throw conflict('CONSENT_REQUIRED', 'Фото с визита можно опубликовать только с согласия клиента');
      }
      ctx.db.prepare(`
        UPDATE work_photos SET title = ?, is_published = ?, publish_consent_at = ?, sort_order = ? WHERE id = ?
      `).run(title === undefined ? photo.title : title, published ? 1 : 0, consentAt, sortOrder ?? photo.sort_order, id);
    });
    return { status: 200, body: { photo: adminView(getPhoto(ctx.db, id)!) } };
  });

  // Фото можно удалить вместе с файлом: это не история записей (раздел 5.22).
  router.delete('/api/admin/photos/:id', (ctx): Result => {
    requireRole(ctx, 'admin');
    const id = pathId(ctx);
    const photo = ctx.db.prepare('SELECT file_path FROM work_photos WHERE id = ?').get(id) as { file_path: string } | undefined;
    if (!photo) throw notFound('Фото не найдено');
    ctx.db.prepare('DELETE FROM work_photos WHERE id = ?').run(id);
    deletePhotoFile(ctx.services.uploadsDir, photo.file_path);
    return { status: 204 };
  });
}
