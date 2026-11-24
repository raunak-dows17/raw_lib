import { RawLibError } from "../errors";
import type { ResolvedEntity } from "../types/entity";
import type { NormalizedQuery } from "../types/normalized";
import type { Op, Query } from "../types/query";
import { compilePipeline } from "./pipeline";
import { compileSort } from "./sort";
import { compileWhere } from "./where";

export type NormalizeOptions = {
  defaultLimit?: number;
  maxLimit?: number;
};

const OPS = new Set<Op>(["list", "get", "create", "update", "delete", "count", "aggregate"]);

export function normalizeQuery<T>(
  query: Query<T>,
  entity: ResolvedEntity,
  options: NormalizeOptions = {},
): NormalizedQuery {
  assertQueryShape(query);

  const defaultLimit = options.defaultLimit ?? 20;
  const maxLimit = options.maxLimit ?? 1000;

  const page =
    query.op === "list"
      ? normalizePage(query.page ?? {}, defaultLimit, maxLimit)
      : query.page
        ? normalizePage(query.page, defaultLimit, maxLimit)
        : undefined;

  return {
    op: query.op,
    entity,
    where: compileWhere(query.where),
    data: query.data,
    sort: compileSort(query.sort),
    select: query.select ? [...query.select] : undefined,
    page,
    pipeline: compilePipeline(query.pipeline),
  };
}

export function assertQueryShape(query: Query<any>): void {
  if (!query || typeof query !== "object") {
    throw new RawLibError("VALIDATION_FAILED", "Query must be an object");
  }

  if (!OPS.has(query.op)) {
    throw new RawLibError("VALIDATION_FAILED", `Unsupported operation: ${String(query.op)}`);
  }

  if (typeof query.entity !== "string" || query.entity.length === 0) {
    throw new RawLibError("VALIDATION_FAILED", "`entity` must be a non-empty string");
  }

  if (query.op === "create" || query.op === "update") {
    if (query.data === undefined) {
      throw new RawLibError("VALIDATION_FAILED", `\`${query.op}\` requires \`data\``);
    }
    if (query.op === "update" && Array.isArray(query.data)) {
      throw new RawLibError("VALIDATION_FAILED", "`update` accepts a single data object");
    }
  }

  if (query.op === "aggregate") {
    if (!Array.isArray(query.pipeline) || query.pipeline.length === 0) {
      throw new RawLibError("VALIDATION_FAILED", "`aggregate` requires a non-empty `pipeline`");
    }
    if (query.where || query.sort || query.select || query.page) {
      throw new RawLibError(
        "VALIDATION_FAILED",
        "`aggregate` does not accept `where`, `sort`, `select`, or `page`; use pipeline stages",
      );
    }
  } else if (query.pipeline !== undefined) {
    throw new RawLibError("VALIDATION_FAILED", "`pipeline` is only valid for `aggregate`");
  }

  if (query.op === "get" || query.op === "update" || query.op === "delete") {
    if (!query.where || Object.keys(query.where).length === 0) {
      throw new RawLibError(
        "VALIDATION_FAILED",
        `\`${query.op}\` requires a non-empty \`where\` clause`,
      );
    }
  }

  if ((query.op === "list" || query.op === "count") && query.data !== undefined) {
    throw new RawLibError("VALIDATION_FAILED", `\`${query.op}\` does not accept \`data\``);
  }
}

function normalizePage(
  page: { limit?: number; offset?: number },
  defaultLimit: number,
  maxLimit: number,
): { limit: number; offset: number } {
  const limit = page.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RawLibError("VALIDATION_FAILED", "`page.limit` must be a positive integer");
  }
  if (limit > maxLimit) {
    throw new RawLibError("VALIDATION_FAILED", `\`page.limit\` cannot exceed ${maxLimit}`);
  }

  const offset = page.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RawLibError("VALIDATION_FAILED", "`page.offset` must be a non-negative integer");
  }

  return { limit, offset };
}
