import type { Validator, ValidatorIssue, ValidatorResult } from "../core/engine/engine";
import { RawLibError } from "../core/errors";
import type { Op } from "../core/types/query";
import type { StandardIssue, StandardSchema } from "./types";
import { isStandardSchema } from "./types";

export type EntitySchemas = Partial<Record<Op, StandardSchema<any>>>;

export type RawValConfig = Record<string, EntitySchemas>;

export type RawValOptions = {
  /** Schemas applied when an entity has no entry of its own. */
  fallback?: EntitySchemas;
};

/**
 * Build a RawQL validator from any Standard Schema implementation
 * (zod, valibot, arktype) or the built-in `v` builder.
 */
export function rawval(config: RawValConfig, options: RawValOptions = {}): Validator {
  const schemas = new Map<string, EntitySchemas>();

  for (const [entity, operations] of Object.entries(config)) {
    schemas.set(entity, assertSchemas(entity, operations));
  }

  if (options.fallback) {
    schemas.set("*", assertSchemas("fallback", options.fallback));
  }

  return {
    async validate({ op, entity, query, data }): Promise<ValidatorResult> {
      const entitySchemas = schemas.get(entity.name) ?? schemas.get("*");
      const schema = entitySchemas?.[op];
      if (!schema) return { ok: true };

      const input = op === "create" || op === "update" ? data : query;
      const result = await schema["~standard"].validate(input);

      if (result.issues) {
        return { ok: false, issues: result.issues.map(toIssue) };
      }

      if (op === "create" || op === "update") {
        return { ok: true, value: result.value };
      }

      return { ok: true };
    },
  };
}

function assertSchemas(entity: string, operations: EntitySchemas): EntitySchemas {
  for (const [op, schema] of Object.entries(operations)) {
    if (!isStandardSchema(schema)) {
      throw new RawLibError("VALIDATION_FAILED", `Invalid Standard Schema for \`${entity}.${op}\``);
    }
  }

  return operations;
}

function toIssue(issue: StandardIssue): ValidatorIssue {
  return {
    path: normalizePath(issue.path),
    message: issue.message,
    ...(issue.code ? { code: issue.code } : {}),
  };
}

function normalizePath(path: StandardIssue["path"]): string {
  if (!path) return "";

  return path
    .map((segment) =>
      typeof segment === "object" && segment !== null ? String(segment.key) : String(segment),
    )
    .join(".");
}
