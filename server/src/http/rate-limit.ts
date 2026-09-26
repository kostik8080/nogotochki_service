// Ограничение частоты запросов в памяти сервера: не больше limit запросов с одного ключа
// (IP или пользователь) за окно windowMs. Паспорт требует его против подбора паролей,
// спам-регистраций и захвата времени бронями (раздел «Риски»).
// Счетчики живут в памяти одного процесса и сбрасываются при перезапуске — для одной студии этого достаточно.
import { HttpError } from './errors.js';

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Засчитать запрос. Сверх лимита — 429 с заголовком Retry-After. */
  hit(key: string, now: number): void {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > this.limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw new HttpError(429, 'TOO_MANY_REQUESTS', 'Слишком много запросов. Попробуйте чуть позже', undefined, {
        'Retry-After': String(retryAfter),
      });
    }
  }

  /** Удалить истекшие окна, чтобы память не росла. Вызывается периодической уборкой. */
  prune(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
