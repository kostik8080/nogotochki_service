// Картинки-заглушки для тестовых данных. В базе фото работ хранится путем к файлу, а файла на диске
// у тестовых данных не было: на лендинге в «Наших работах» получались два битых изображения, и при
// ручной проверке это выглядело как поломка сайта (находки прогона, № 12).
//
// Рисовать нечего и незачем: заглушка — ровная плашка в цвете студии. Настоящие фото работ загружает
// администратор. Файл собирается здесь, без зависимостей: PNG — это подпись, заголовок IHDR,
// сжатые строки пикселей в IDAT и завершающий IEND, у каждого куска своя контрольная сумма.
import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = -1;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * PNG одного цвета размером `width` × `height`.
 * @param color цвет в формате `#RRGGBB`
 */
export function solidPng(width: number, height: number, color: string): Buffer {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // цвет без прозрачности (truecolor)

  // Каждая строка пикселей начинается с байта фильтра; 0 — «без фильтра».
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r!;
    row[2 + x * 3] = g!;
    row[3 + x * 3] = b!;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
