import { isPlainObject } from "../core/utils";
import {
  ArraySchema,
  failure,
  joinPath,
  NumberSchema,
  ObjectSchema,
  parseAt,
  SchemaImpl,
  StringSchema,
} from "./schema";
import type { InferSchema, ParseResult, Schema, Shape, ValidationIssue } from "./types";

type Primitive = string | number | boolean;

export const v = {
  string(): StringSchema {
    return new StringSchema();
  },

  number(): NumberSchema {
    return new NumberSchema();
  },

  boolean(): Schema<boolean> {
    return new SchemaImpl<boolean>((value, path) =>
      typeof value === "boolean"
        ? { ok: true, value }
        : failure(path, "Expected a boolean", "invalid_type"),
    );
  },

  literal<const T extends Primitive>(expected: T): Schema<T> {
    return new SchemaImpl<T>((value, path) =>
      value === expected
        ? { ok: true, value: expected }
        : failure(path, `Expected ${String(expected)}`, "invalid_literal"),
    );
  },

  enum<const T extends readonly Primitive[]>(values: T): Schema<T[number]> {
    return new SchemaImpl<T[number]>((value, path) =>
      values.includes(value as T[number])
        ? { ok: true, value: value as T[number] }
        : failure(path, `Expected one of: ${values.join(", ")}`, "invalid_enum_value"),
    );
  },

  array<S extends Schema<any>>(item: S): ArraySchema<InferSchema<S>> {
    return new ArraySchema<InferSchema<S>>(item as Schema<InferSchema<S>>);
  },

  object<S extends Shape>(shape: S): ObjectSchema<S> {
    return new ObjectSchema(shape);
  },

  record<S extends Schema<any>>(value: S): Schema<Record<string, InferSchema<S>>> {
    return new SchemaImpl<Record<string, InferSchema<S>>>((input, path) => {
      if (!isPlainObject(input)) return failure(path, "Expected an object", "invalid_type");

      const output: Record<string, InferSchema<S>> = {};
      const issues: ValidationIssue[] = [];

      for (const [key, item] of Object.entries(input)) {
        const result = parseAt(value, item, joinPath(path, key)) as ParseResult<InferSchema<S>>;
        if (result.ok) output[key] = result.value;
        else issues.push(...result.issues);
      }

      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: output };
    });
  },

  union<S extends readonly Schema<any>[]>(schemas: S): Schema<InferSchema<S[number]>> {
    return new SchemaImpl<InferSchema<S[number]>>((value, path) => {
      for (const schema of schemas) {
        const result = parseAt(schema, value, path);
        if (result.ok) return result as ParseResult<InferSchema<S[number]>>;
      }

      return failure(path, "Value does not match any union member", "invalid_union");
    });
  },

  date(): Schema<Date> {
    return new SchemaImpl<Date>((value, path) => {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime())
          ? failure(path, "Expected a valid date", "invalid_date")
          : { ok: true, value };
      }

      if (typeof value === "string" || typeof value === "number") {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return { ok: true, value: date };
      }

      return failure(path, "Expected a valid date", "invalid_date");
    });
  },

  any(): Schema<any> {
    return new SchemaImpl<any>((value) => ({ ok: true, value }));
  },

  unknown(): Schema<unknown> {
    return new SchemaImpl<unknown>((value) => ({ ok: true, value }));
  },

  optional<S extends Schema<any>>(schema: S): Schema<InferSchema<S> | undefined> {
    return schema.optional();
  },

  nullable<S extends Schema<any>>(schema: S): Schema<InferSchema<S> | null> {
    return schema.nullable();
  },
};

export type V = typeof v;
