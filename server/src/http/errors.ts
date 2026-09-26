// Ошибки API. Обработчик бросает HttpError, а app.ts превращает ее в ответ JSON
// { "error": { "code", "message", "details"? } } с нужным кодом HTTP.
// code — постоянный английский код для интерфейса, message — текст для человека.

export interface FieldError {
  field: string;
  message: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Дополнительные заголовки ответа, например Retry-After. */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Нужно войти в аккаунт', code = 'UNAUTHORIZED') => new HttpError(401, code, message);
export const forbidden = (message = 'Недостаточно прав', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (message = 'Не найдено', code = 'NOT_FOUND') => new HttpError(404, code, message);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);

/**
 * Коды, которыми база отклоняет изменение (RAISE в триггерах, docs/db-schema.md, раздел 10).
 * node:sqlite кладет код в error.message, error.code у всех ошибок SQLite одинаковый (docs/database.md, раздел 3).
 * Сервер проверяет эти правила сам до записи, поэтому ответ от триггера означает гонку
 * с другим запросом или изменение данных между проверкой и записью — это конфликт (409).
 */
const TRIGGER_ERRORS: Record<string, string> = {
  SLOT_TAKEN: 'Это время только что заняли. Выберите другое',
  SERVICES_INCOMPATIBLE: 'Эти услуги нельзя объединить в один визит',
  MASTER_CANNOT_DO_SERVICE: 'Мастер не выполняет одну из услуг визита',
  SCHEDULE_PERIOD_OVERLAP: 'Периоды графика мастера пересекаются',
  WRONG_SERVICE_KIND: 'Тип услуги не подходит: опция или основная услуга перепутаны, либо на услугу уже ссылаются записи',
  WRONG_USER_ROLE: 'Пользователь с этой ролью не может выполнить действие',
  CANCEL_EVENT_REQUIRED: 'Отмена записи без события отмены',
  BOOKING_DELETE_FORBIDDEN: 'Записи не удаляются',
  ROLE_IMMUTABLE: 'Роль пользователя не меняется',
};

/** Переводит ошибку SQLite в HttpError, если это известное правило базы; иначе возвращает null. */
export function fromDatabaseError(error: unknown): HttpError | null {
  if (!(error instanceof Error) || (error as { code?: string }).code !== 'ERR_SQLITE_ERROR') return null;
  for (const [code, message] of Object.entries(TRIGGER_ERRORS)) {
    if (error.message.includes(code)) return conflict(code, message);
  }
  if (/UNIQUE constraint failed/.test(error.message)) {
    return conflict('ALREADY_EXISTS', 'Такое значение уже есть', { constraint: error.message.replace(/^.*UNIQUE constraint failed:\s*/, '') });
  }
  return null;
}

/** Код ошибки триггера, если это она. Нужен, чтобы дополнить ответ, например альтернативными слотами. */
export function databaseErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || (error as { code?: string }).code !== 'ERR_SQLITE_ERROR') return null;
  return Object.keys(TRIGGER_ERRORS).find((code) => error.message.includes(code)) ?? null;
}
