// Хеширование паролей: argon2id из node:crypto (Node 24.7+), результат — строка в формате PHC:
// $argon2id$v=19$m=65536,t=3,p=4$<соль>$<хеш>. Алгоритм и параметры хранятся в самой строке,
// поэтому их можно усилить позже, а старые хеши продолжат проверяться (docs/db-schema.md, решение 36).
import { argon2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const PARAMS = { memory: 65_536, passes: 3, parallelism: 4, tagLength: 32 };

/** base64 без знаков «=» на конце, как принято в формате PHC. */
const toB64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

export function hashPassword(password: string): string {
  const nonce = randomBytes(16);
  const hash = argon2Sync('argon2id', { message: password, nonce, ...PARAMS });
  const { memory: m, passes: t, parallelism: p } = PARAMS;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${toB64(nonce)}$${toB64(hash)}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const match = stored.match(/^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/);
  if (!match) return false;
  const [, m, t, p, nonce, hash] = match as unknown as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const actual = argon2Sync('argon2id', {
    message: password,
    nonce: Buffer.from(nonce, 'base64'),
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}
