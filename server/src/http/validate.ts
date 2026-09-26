// Проверка входных данных до обращения к базе. Input читает поля тела запроса или строки запроса,
// приводит их к нужному типу и копит ошибки; done() бросает 400 со списком всех ошибок сразу.
// Неизвестные поля — тоже ошибка: опечатка в имени поля не должна молча игнорироваться.
//
//   const input = Input.body(body);
//   const name = input.string('name', { max: 100 });
//   const phone = input.phone('phone', { optional: true });
//   input.done();
//
// Пока done() не вызван, значение поля с ошибкой не определено — пользоваться им нельзя.
import { HttpError, type FieldError } from './errors.js';

interface Opts {
  /** Поле можно не передавать: результат undefined. */
  optional?: boolean;
  /** Поле можно передать как null — например, чтобы очистить значение в PATCH. */
  nullable?: boolean;
}

type Out<T, O extends Opts> =
  | T
  | (O extends { optional: true } ? undefined : never)
  | (O extends { nullable: true } ? null : never);

export type Parsed<T> = { value: T } | { error: string };

const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Input {
  private readonly errors: FieldError[];
  private readonly used = new Set<string>();

  private constructor(
    private readonly data: Record<string, unknown>,
    /** В строке запроса все значения — строки, числа и логические значения разбираются из текста. */
    private readonly fromQuery: boolean,
    private readonly prefix = '',
    errors?: FieldError[],
  ) {
    this.errors = errors ?? [];
  }

  static body(raw: unknown): Input {
    if (raw === undefined) raw = {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new HttpError(400, 'INVALID_BODY', 'Тело запроса должно быть объектом JSON');
    }
    return new Input(raw as Record<string, unknown>, false);
  }

  static query(params: URLSearchParams): Input {
    return new Input(Object.fromEntries(params), true);
  }

  /** Передано ли поле вообще (для PATCH: «не менять» и «очистить» — разные вещи). */
  has(key: string): boolean {
    return this.data[key] !== undefined;
  }

  /** Добавить ошибку, найденную уже после разбора полей (например, «нужен телефон или e-mail»). */
  fail(field: string, message: string): void {
    this.errors.push({ field: this.prefix + field, message });
  }

  get valid(): boolean {
    return this.errors.length === 0;
  }

  /** Бросает 400 со всеми найденными ошибками. Вызывается после чтения всех полей. */
  done(): void {
    this.checkUnknown();
    if (this.errors.length > 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Проверьте введенные данные', { fields: this.errors });
    }
  }

  /** Поле с собственным разбором: parse возвращает { value } или { error }. */
  field<T, const O extends Opts = {}>(key: string, opts: O | undefined, parse: (raw: unknown) => Parsed<T>): Out<T, O> {
    this.used.add(key);
    const raw = this.data[key];
    if (raw === undefined || (this.fromQuery && raw === '')) {
      if (!opts?.optional) this.fail(key, 'Обязательное поле');
      return undefined as Out<T, O>;
    }
    if (raw === null) {
      if (!opts?.nullable) this.fail(key, 'Поле не может быть пустым');
      return null as Out<T, O>;
    }
    const result = parse(raw);
    if ('error' in result) {
      this.fail(key, result.error);
      return undefined as Out<T, O>;
    }
    return result.value as Out<T, O>;
  }

  string<const O extends Opts = {}>(key: string, opts?: O & { min?: number; max?: number }): Out<string, O> {
    const min = opts?.min ?? 1;
    const max = opts?.max ?? 1000;
    return this.field<string, O>(key, opts, (raw) => {
      if (typeof raw !== 'string') return { error: 'Нужна строка' };
      const value = raw.trim();
      if (value.length < min) return { error: min === 1 ? 'Поле не может быть пустым' : `Не короче ${min} символов` };
      if (value.length > max) return { error: `Не длиннее ${max} символов` };
      return { value };
    });
  }

  int<const O extends Opts = {}>(key: string, opts?: O & { min?: number; max?: number }): Out<number, O> {
    const min = opts?.min ?? 0;
    const max = opts?.max ?? Number.MAX_SAFE_INTEGER;
    return this.field<number, O>(key, opts, (raw) => {
      const value = this.fromQuery && typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw;
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return { error: 'Нужно целое число' };
      if (value < min || value > max) return { error: max === Number.MAX_SAFE_INTEGER ? `Не меньше ${min}` : `От ${min} до ${max}` };
      return { value };
    });
  }

  /** Идентификатор строки: целое число от 1. */
  id<const O extends Opts = {}>(key: string, opts?: O): Out<number, O> {
    return this.int(key, { ...opts, min: 1 } as O & { min: number });
  }

  bool<const O extends Opts = {}>(key: string, opts?: O): Out<boolean, O> {
    return this.field<boolean, O>(key, opts, (raw) => {
      if (typeof raw === 'boolean') return { value: raw };
      if (this.fromQuery && (raw === 'true' || raw === 'false')) return { value: raw === 'true' };
      return { error: 'Нужно true или false' };
    });
  }

  oneOf<T extends string, const O extends Opts = {}>(key: string, values: readonly T[], opts?: O): Out<T, O> {
    return this.field<T, O>(key, opts, (raw) =>
      typeof raw === 'string' && (values as readonly string[]).includes(raw)
        ? { value: raw as T }
        : { error: `Допустимые значения: ${values.join(', ')}` });
  }

  /**
   * Момент времени строго в UTC: ISO 8601 с буквой Z, например 2026-09-24T07:00:00.000Z.
   * Смещение пояса (+03:00) не принимается: API работает только с UTC (docs/db-schema.md, раздел 2.1).
   * Возвращается в формате базы — с миллисекундами.
   */
  instant<const O extends Opts = {}>(key: string, opts?: O): Out<string, O> {
    return this.field<string, O>(key, opts, (raw) => {
      const m = typeof raw === 'string' ? UTC_INSTANT.exec(raw) : null;
      if (!m) return { error: 'Нужен момент времени в UTC, например 2026-09-24T07:00:00.000Z' };
      const [, y, mo, d, h, mi, s = '0', ms = '0'] = m as unknown as string[];
      const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, '0')));
      const value = new Date(time);
      // Date.UTC молча переносит 31 февраля на 3 марта — такая дата ошибочна.
      if (value.getUTCDate() !== Number(d) || value.getUTCHours() !== Number(h)) return { error: 'Такой даты или времени нет' };
      return { value: value.toISOString() };
    });
  }

  /** Дата по календарю студии: YYYY-MM-DD (раздел 2.2). */
  date<const O extends Opts = {}>(key: string, opts?: O): Out<string, O> {
    return this.field<string, O>(key, opts, (raw) => {
      const m = typeof raw === 'string' ? DATE.exec(raw) : null;
      if (!m) return { error: 'Нужна дата в формате ГГГГ-ММ-ДД' };
      const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (date.toISOString().slice(0, 10) !== raw) return { error: 'Такой даты нет' };
      return { value: raw as string };
    });
  }

  /** Время по часам студии: HH:MM (раздел 2.3). */
  time<const O extends Opts = {}>(key: string, opts?: O): Out<string, O> {
    return this.field<string, O>(key, opts, (raw) =>
      typeof raw === 'string' && TIME.test(raw) ? { value: raw } : { error: 'Нужно время в формате ЧЧ:ММ' });
  }

  /**
   * Телефон в формате E.164, как в базе: +79112223344. Пробелы, скобки и дефисы убираются,
   * российский номер с 8 в начале превращается в +7.
   */
  phone<const O extends Opts = {}>(key: string, opts?: O): Out<string, O> {
    return this.field<string, O>(key, opts, (raw) => {
      const value = typeof raw === 'string' ? normalizePhone(raw) : null;
      return value ? { value } : { error: 'Нужен телефон в международном формате, например +79112223344' };
    });
  }

  /** E-mail хранится в нижнем регистре (раздел 5.4). */
  email<const O extends Opts = {}>(key: string, opts?: O): Out<string, O> {
    return this.field<string, O>(key, opts, (raw) => {
      if (typeof raw !== 'string') return { error: 'Нужна строка' };
      const value = raw.trim().toLowerCase();
      if (value.length > 254 || !EMAIL.test(value)) return { error: 'Нужен адрес электронной почты, например name@example.com' };
      return { value };
    });
  }

  /** Пароль не обрезается: пробелы по краям — часть пароля. */
  password(key: string): string {
    return this.field<string, {}>(key, undefined, (raw) => {
      if (typeof raw !== 'string') return { error: 'Нужна строка' };
      if (raw.length < 8) return { error: 'Пароль не короче 8 символов' };
      if (raw.length > 128) return { error: 'Пароль не длиннее 128 символов' };
      return { value: raw };
    });
  }

  /** Вложенный объект; его поля разбирает функция item, ошибки попадают в общий список. */
  object<T, const O extends Opts = {}>(key: string, item: (input: Input) => T, opts?: O): Out<T, O> {
    return this.field<T, O>(key, opts, (raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'Нужен объект' };
      const child = new Input(raw as Record<string, unknown>, false, `${this.prefix}${key}.`, this.errors);
      const value = item(child);
      child.checkUnknown();
      return { value };
    });
  }

  /** Массив объектов; каждый элемент разбирается функцией item, ошибки попадают в общий список. */
  objects<T, const O extends Opts = {}>(key: string, item: (input: Input) => T, opts?: O & { min?: number; max?: number }): Out<T[], O> {
    return this.field<T[], O>(key, opts, (raw) => {
      if (!Array.isArray(raw)) return { error: 'Нужен массив' };
      if (raw.length < (opts?.min ?? 0)) return { error: `Не меньше ${opts?.min} элементов` };
      if (raw.length > (opts?.max ?? 100)) return { error: `Не больше ${opts?.max ?? 100} элементов` };
      const values = raw.map((element, i) => {
        const path = `${this.prefix}${key}[${i}].`;
        if (typeof element !== 'object' || element === null || Array.isArray(element)) {
          this.errors.push({ field: path.slice(0, -1), message: 'Нужен объект' });
          return undefined as T;
        }
        const child = new Input(element as Record<string, unknown>, false, path, this.errors);
        const value = item(child);
        child.checkUnknown();
        return value;
      });
      return { value: values };
    });
  }

  /** Массив идентификаторов. В строке запроса — через запятую: ?serviceIds=1,2,3. */
  ids<const O extends Opts = {}>(key: string, opts?: O & { max?: number }): Out<number[], O> {
    return this.field<number[], O>(key, opts, (raw) => {
      const list = this.fromQuery && typeof raw === 'string' ? raw.split(',').map((s) => (/^\d+$/.test(s.trim()) ? Number(s) : NaN)) : raw;
      if (!Array.isArray(list) || !list.every((v) => Number.isSafeInteger(v) && v >= 1)) {
        return { error: this.fromQuery ? 'Нужен список номеров через запятую' : 'Нужен массив номеров' };
      }
      if (list.length > (opts?.max ?? 100)) return { error: `Не больше ${opts?.max ?? 100} элементов` };
      if (new Set(list).size !== list.length) return { error: 'Номера повторяются' };
      return { value: list as number[] };
    });
  }

  private checkUnknown(): void {
    for (const key of Object.keys(this.data)) {
      if (!this.used.has(key) && this.data[key] !== undefined) this.fail(key, 'Неизвестное поле');
    }
  }
}

/** Телефон в E.164 или null: пробелы, скобки и дефисы убираются, 8XXXXXXXXXX превращается в +7XXXXXXXXXX. */
export function normalizePhone(raw: string): string | null {
  let value = raw.replace(/[\s()-]/g, '');
  if (/^8\d{10}$/.test(value)) value = '+7' + value.slice(1);
  return /^\+\d{7,15}$/.test(value) ? value : null;
}
