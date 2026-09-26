// Файлы фото работ (docs/db-schema.md, раздел 5.22, решение 12): изображения лежат в папке UPLOADS_DIR,
// в базе — только путь относительно нее, например photos/2026/09/7f3a1c….jpg.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const TYPES_BY_EXTENSION: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/**
 * Настоящий тип изображения по первым байтам файла. Заголовку Content-Type верить нельзя:
 * под видом картинки можно прислать HTML или скрипт, и браузер откроет его с адреса сервиса.
 */
export function detectImageType(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Сохраняет файл под случайным именем и возвращает путь для work_photos.file_path. */
export function savePhoto(uploadsDir: string, data: Buffer, type: string, now: Date): string {
  const month = now.toISOString().slice(0, 7).split('-');
  const relative = ['photos', month[0], month[1], `${randomBytes(16).toString('hex')}.${EXTENSIONS[type]}`].join('/');
  const file = resolveInside(uploadsDir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data, { flag: 'wx' });
  return relative;
}

export function readPhoto(uploadsDir: string, relative: string): { data: Buffer; type: string } | null {
  try {
    const data = readFileSync(resolveInside(uploadsDir, relative));
    return { data, type: TYPES_BY_EXTENSION[path.extname(relative).slice(1)] ?? 'application/octet-stream' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Удаляет файл; если его уже нет — не ошибка. */
export function deletePhotoFile(uploadsDir: string, relative: string): void {
  rmSync(resolveInside(uploadsDir, relative), { force: true });
}

/** Путь внутри папки загрузок: «../» в пути из базы не выведет за ее пределы. */
function resolveInside(uploadsDir: string, relative: string): string {
  const root = path.resolve(uploadsDir);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error(`Путь фото вне папки загрузок: ${relative}`);
  return file;
}
