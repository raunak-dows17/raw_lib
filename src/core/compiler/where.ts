import { RawLibError } from "../errors";
import type { CompiledWhere } from "../types/normalized";
import type { Where } from "../types/query";
import { isPlainObject } from "../utils";

const COMPARISON_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);
const ARRAY_OPS = new Set(["in", "nin"]);
const TEXT_OPS = new Set(["contains", "startsWith", "endsWith"]);
const PRESENCE_OPS = new Set(["exists", "isNull"]);
const OPERATOR_KEYS = new Set([...COMPARISON_OPS, ...ARRAY_OPS, ...TEXT_OPS, ...PRESENCE_OPS]);

export function compileWhere<T>(where?: Where<T>): CompiledWhere | undefined {
  if (where === undefined || where === null) return undefined;
  if (!isPlainObject(where)) {
    throw new RawLibError("VALIDATION_FAILED", "`where` must be an object");
  }

  const clauses: CompiledWhere[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;

    if (key === "$and" || key === "$or") {
      if (!Array.isArray(value)) {
        throw new RawLibError("VALIDATION_FAILED", `\`${key}\` must be an array`);
      }
      const nested = value
        .map((item) => compileWhere(item as Where<T>))
        .filter((item): item is CompiledWhere => item !== undefined);
      if (nested.length > 0) {
        clauses.push({ kind: key === "$and" ? "and" : "or", clauses: nested });
      }
      continue;
    }

    if (key === "$not") {
      const nested = compileWhere(value as Where<T>);
      if (nested) clauses.push({ kind: "not", clause: nested });
      continue;
    }

    if (key.startsWith("$")) {
      throw new RawLibError("VALIDATION_FAILED", `Unsupported logical operator: ${key}`);
    }

    clauses.push(...compileField(key, value));
  }

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { kind: "and", clauses };
}

function compileField(field: string, value: unknown): CompiledWhere[] {
  if (value === null) {
    return [{ kind: "presence", field, op: "isNull", value: true }];
  }

  if (isOperatorObject(value)) {
    return Object.entries(value).map(([operator, operand]) =>
      compileOperator(field, operator, operand),
    );
  }

  return [{ kind: "comparison", field, op: "eq", value }];
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => OPERATOR_KEYS.has(key));
}

function compileOperator(field: string, operator: string, operand: unknown): CompiledWhere {
  if (COMPARISON_OPS.has(operator)) {
    return {
      kind: "comparison",
      field,
      op: operator as "eq" | "ne" | "gt" | "gte" | "lt" | "lte",
      value: operand,
    };
  }

  if (ARRAY_OPS.has(operator)) {
    if (!Array.isArray(operand)) {
      throw new RawLibError(
        "VALIDATION_FAILED",
        `Operator \`${operator}\` on \`${field}\` requires an array`,
      );
    }
    return { kind: "array", field, op: operator as "in" | "nin", value: operand };
  }

  if (TEXT_OPS.has(operator)) {
    if (typeof operand !== "string") {
      throw new RawLibError(
        "VALIDATION_FAILED",
        `Operator \`${operator}\` on \`${field}\` requires a string`,
      );
    }
    return {
      kind: "text",
      field,
      op: operator as "contains" | "startsWith" | "endsWith",
      value: operand,
    };
  }

  if (PRESENCE_OPS.has(operator)) {
    if (typeof operand !== "boolean") {
      throw new RawLibError(
        "VALIDATION_FAILED",
        `Operator \`${operator}\` on \`${field}\` requires a boolean`,
      );
    }
    return { kind: "presence", field, op: operator as "exists" | "isNull", value: operand };
  }

  throw new RawLibError("VALIDATION_FAILED", `Unsupported operator: ${operator}`);
}
