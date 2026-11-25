import { RawLibError } from "../core/errors";
import { clone, isPlainObject } from "../core/utils";
import type {
  InferSchema,
  InferShape,
  ParseResult,
  Schema,
  Shape,
  StandardIssue,
  StandardSchemaProps,
  ValidationIssue,
} from "./types";

export function failure(path: string, message: string, code = "invalid"): ParseResult<never> {
  return { ok: false, issues: [{ path, message, code }] };
}

export function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

export function indexPath(base: string, index: number): string {
  return `${base}[${index}]`;
}

export function parseAt<T>(schema: Schema<T>, value: unknown, path: string): ParseResult<T> {
  if (schema instanceof SchemaImpl) return schema.parseAt(value, path);
  return schema.safeParse(value);
}

function parseArray<T>(item: Schema<T>, value: unknown, path: string): ParseResult<T[]> {
  if (!Array.isArray(value)) return failure(path, "Expected an array", "invalid_type");

  const output: T[] = [];
  const issues: ValidationIssue[] = [];

  value.forEach((entry, index) => {
    const result = parseAt(item, entry, indexPath(path, index));
    if (result.ok) output.push(result.value);
    else issues.push(...result.issues);
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: output };
}

function toStandardIssue(issue: ValidationIssue): StandardIssue {
  return {
    message: issue.message,
    ...(issue.code ? { code: issue.code } : {}),
    ...(issue.path ? { path: issue.path.split(".").filter(Boolean) } : {}),
  };
}

function cloneDefault<T>(value: T): T {
  return value !== null && typeof value === "object" ? clone(value) : value;
}

export class SchemaImpl<T> implements Schema<T> {
  constructor(protected readonly parser: (value: unknown, path: string) => ParseResult<T>) {}

  parseAt(value: unknown, path: string): ParseResult<T> {
    return this.parser(value, path);
  }

  safeParse(value: unknown): ParseResult<T> {
    return this.parser(value, "");
  }

  parse(value: unknown): T {
    const result = this.safeParse(value);
    if (!result.ok) {
      throw new RawLibError("VALIDATION_FAILED", "Validation failed", result.issues);
    }
    return result.value;
  }

  get "~standard"(): StandardSchemaProps<T> {
    return {
      version: 1,
      vendor: "raw_lib",
      validate: (value) => {
        const result = this.safeParse(value);
        if (result.ok) return { value: result.value };
        return { issues: result.issues.map(toStandardIssue) };
      },
    };
  }

  optional(): Schema<T | undefined> {
    return new SchemaImpl<T | undefined>((value, path) => {
      if (value === undefined) return { ok: true, value: undefined };
      return this.parser(value, path);
    });
  }

  nullable(): Schema<T | null> {
    return new SchemaImpl<T | null>((value, path) => {
      if (value === null) return { ok: true, value: null };
      return this.parser(value, path);
    });
  }

  default(value: T): Schema<T> {
    return new SchemaImpl<T>((input, path) => {
      if (input === undefined) return { ok: true, value: cloneDefault(value) };
      return this.parser(input, path);
    });
  }

  refine(check: (value: T) => boolean | string, message?: string): Schema<T> {
    return new SchemaImpl<T>((input, path) => {
      const result = this.parser(input, path);
      if (!result.ok) return result;

      const outcome = check(result.value);
      if (outcome === true) return result;

      return failure(
        path,
        typeof outcome === "string" ? outcome : (message ?? "Invalid value"),
        "custom",
      );
    });
  }

  transform<U>(fn: (value: T) => U): Schema<U> {
    return new SchemaImpl<U>((input, path) => {
      const result = this.parser(input, path);
      if (!result.ok) return result;

      try {
        return { ok: true, value: fn(result.value) };
      } catch (error) {
        return failure(path, error instanceof Error ? error.message : String(error), "transform");
      }
    });
  }
}

function stringParser(value: unknown, path: string): ParseResult<string> {
  return typeof value === "string"
    ? { ok: true, value }
    : failure(path, "Expected a string", "invalid_type");
}

export class StringSchema extends SchemaImpl<string> {
  constructor(parser: (value: unknown, path: string) => ParseResult<string> = stringParser) {
    super(parser);
  }

  private next(check: (value: string) => string | true, code = "invalid_string"): StringSchema {
    return new StringSchema((value, path) => {
      const result = this.parser(value, path);
      if (!result.ok) return result;
      const outcome = check(result.value);
      return outcome === true ? result : failure(path, outcome, code);
    });
  }

  min(length: number, message?: string): StringSchema {
    return this.next(
      (value) =>
        value.length >= length ? true : (message ?? `Must be at least ${length} characters`),
      "too_small",
    );
  }

  max(length: number, message?: string): StringSchema {
    return this.next(
      (value) =>
        value.length <= length ? true : (message ?? `Must be at most ${length} characters`),
      "too_big",
    );
  }

  length(length: number, message?: string): StringSchema {
    return this.next(
      (value) =>
        value.length === length ? true : (message ?? `Must be exactly ${length} characters`),
      "invalid_length",
    );
  }

  nonempty(message?: string): StringSchema {
    return this.min(1, message ?? "Must not be empty");
  }

  email(message?: string): StringSchema {
    return this.next(
      (value) => EMAIL_PATTERN.test(value) || (message ?? "Must be a valid email address"),
      "invalid_email",
    );
  }

  url(message?: string): StringSchema {
    return this.next((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return message ?? "Must be a valid URL";
      }
    }, "invalid_url");
  }

  regex(pattern: RegExp, message?: string): StringSchema {
    return this.next(
      (value) =>
        new RegExp(pattern.source, pattern.flags).test(value) ||
        (message ?? `Must match ${pattern}`),
      "invalid_string",
    );
  }

  startsWith(prefix: string, message?: string): StringSchema {
    return this.next(
      (value) => (value.startsWith(prefix) ? true : (message ?? `Must start with "${prefix}"`)),
      "invalid_string",
    );
  }

  endsWith(suffix: string, message?: string): StringSchema {
    return this.next(
      (value) => (value.endsWith(suffix) ? true : (message ?? `Must end with "${suffix}"`)),
      "invalid_string",
    );
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function numberParser(value: unknown, path: string): ParseResult<number> {
  return typeof value === "number" && Number.isFinite(value)
    ? { ok: true, value }
    : failure(path, "Expected a finite number", "invalid_type");
}

export class NumberSchema extends SchemaImpl<number> {
  constructor(parser: (value: unknown, path: string) => ParseResult<number> = numberParser) {
    super(parser);
  }

  private next(check: (value: number) => string | true, code = "invalid_number"): NumberSchema {
    return new NumberSchema((value, path) => {
      const result = this.parser(value, path);
      if (!result.ok) return result;
      const outcome = check(result.value);
      return outcome === true ? result : failure(path, outcome, code);
    });
  }

  min(minimum: number, message?: string): NumberSchema {
    return this.next(
      (value) =>
        value >= minimum ? true : (message ?? `Must be greater than or equal to ${minimum}`),
      "too_small",
    );
  }

  max(maximum: number, message?: string): NumberSchema {
    return this.next(
      (value) =>
        value <= maximum ? true : (message ?? `Must be less than or equal to ${maximum}`),
      "too_big",
    );
  }

  int(message?: string): NumberSchema {
    return this.next(
      (value) => Number.isInteger(value) || (message ?? "Must be an integer"),
      "invalid_type",
    );
  }

  positive(message?: string): NumberSchema {
    return this.next((value) => value > 0 || (message ?? "Must be positive"), "too_small");
  }

  nonnegative(message?: string): NumberSchema {
    return this.next((value) => value >= 0 || (message ?? "Must be zero or greater"), "too_small");
  }
}

export class ArraySchema<T> extends SchemaImpl<T[]> {
  private readonly item: Schema<T>;

  constructor(item: Schema<T>, parser?: (value: unknown, path: string) => ParseResult<T[]>) {
    super(parser ?? ((value, path) => parseArray(item, value, path)));
    this.item = item;
  }

  private next(check: (value: T[]) => string | true, code: string): ArraySchema<T> {
    return new ArraySchema<T>(this.item, (value, path) => {
      const result = this.parser(value, path);
      if (!result.ok) return result;
      const outcome = check(result.value);
      return outcome === true ? result : failure(path, outcome, code);
    });
  }

  min(length: number, message?: string): ArraySchema<T> {
    return this.next(
      (value) =>
        value.length >= length ? true : (message ?? `Must contain at least ${length} items`),
      "too_small",
    );
  }

  max(length: number, message?: string): ArraySchema<T> {
    return this.next(
      (value) =>
        value.length <= length ? true : (message ?? `Must contain at most ${length} items`),
      "too_big",
    );
  }

  length(length: number, message?: string): ArraySchema<T> {
    return this.next(
      (value) =>
        value.length === length ? true : (message ?? `Must contain exactly ${length} items`),
      "invalid_length",
    );
  }

  nonempty(message?: string): ArraySchema<T> {
    return this.min(1, message ?? "Must contain at least one item");
  }
}

export class ObjectSchema<S extends Shape> extends SchemaImpl<InferShape<S>> {
  readonly shape: S;

  constructor(shape: S) {
    super((value, path) => {
      if (!isPlainObject(value)) return failure(path, "Expected an object", "invalid_type");

      const output: Record<string, unknown> = {};
      const issues: ValidationIssue[] = [];

      for (const [key, schema] of Object.entries(shape)) {
        const result = parseAt(schema, value[key], joinPath(path, key));
        if (!result.ok) issues.push(...result.issues);
        else if (result.value !== undefined || key in value) output[key] = result.value;
      }

      return issues.length > 0
        ? { ok: false, issues }
        : { ok: true, value: output as InferShape<S> };
    });

    this.shape = shape;
  }

  partial(): ObjectSchema<{ [K in keyof S]: Schema<InferSchema<S[K]> | undefined> }> {
    const shape = Object.fromEntries(
      Object.entries(this.shape).map(([key, schema]) => [key, schema.optional()]),
    );

    return new ObjectSchema(shape) as ObjectSchema<{
      [K in keyof S]: Schema<InferSchema<S[K]> | undefined>;
    }>;
  }

  extend<E extends Shape>(extra: E): ObjectSchema<S & E> {
    return new ObjectSchema({ ...this.shape, ...extra });
  }
}
