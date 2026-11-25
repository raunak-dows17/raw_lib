import { RawLibError, toRawLibError } from "../core/errors";
import type { Op, PipelineStep, Query, Where } from "../core/types/query";
import type { Result } from "../core/types/result";
import { clone, isPlainObject } from "../core/utils";
import type {
  AgentContext,
  AgentEntities,
  AgentEntity,
  AgentField,
  AgentPolicy,
  GuardedQuery,
  NormalizedAgentPolicy,
} from "./types";

const READ_OPS: Op[] = ["list", "get", "count", "aggregate"];
const WRITE_OPS: Op[] = ["create", "update", "delete"];
const KNOWN_OPS = new Set<Op>([...READ_OPS, ...WRITE_OPS]);
const KNOWN_STAGES = new Set([
  "$match",
  "$group",
  "$sort",
  "$limit",
  "$skip",
  "$project",
  "$lookup",
  "$unwind",
  "$addFields",
  "$count",
]);

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RawLibError("VALIDATION_FAILED", `\`policy.${name}\` must be a positive integer`);
  }
  return value;
}

function mergeFields(
  base: Record<string, string[]>,
  extra: Record<string, string[]>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const [entity, fields] of Object.entries(base)) {
    merged[entity] = [...fields];
  }
  for (const [entity, fields] of Object.entries(extra)) {
    merged[entity] = [...new Set([...(merged[entity] ?? []), ...fields])];
  }
  return merged;
}

function sensitiveFields(entities: AgentEntities): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const [entity, config] of Object.entries(entities)) {
    const fields = Object.entries(config.fields ?? {})
      .filter(([, field]) => typeof field !== "string" && field.sensitive)
      .map(([name]) => name);
    if (fields.length > 0) output[entity] = fields;
  }
  return output;
}

export function normalizePolicy(
  policy: AgentPolicy = {},
  entities: AgentEntities = {},
): NormalizedAgentPolicy {
  const allowOps = new Set<Op>(policy.allowOps ?? READ_OPS);
  for (const op of allowOps) {
    if (!KNOWN_OPS.has(op)) {
      throw new RawLibError("VALIDATION_FAILED", `Unknown operation in policy: ${op}`);
    }
  }

  const configured = Object.keys(entities);
  const allowEntities =
    policy.allowEntities === undefined
      ? configured.length > 0
        ? new Set(configured)
        : "*"
      : policy.allowEntities === "*"
        ? "*"
        : new Set(policy.allowEntities);

  const denyFields = mergeFields(policy.denyFields ?? {}, sensitiveFields(entities));
  const redactFields = policy.redactFields ?? {};

  for (const [entity, denied] of Object.entries(denyFields)) {
    const redacted = redactFields[entity] ?? [];
    const overlap = denied.filter((field) => redacted.includes(field));
    if (overlap.length > 0) {
      throw new RawLibError(
        "VALIDATION_FAILED",
        `Fields cannot be both denied and redacted: ${overlap.join(", ")}`,
      );
    }
  }

  const requireApproval = new Set<Op>(policy.requireApproval ?? WRITE_OPS);
  const maxLimit = positiveInteger(policy.maxLimit, 50, "maxLimit");
  const maxRows = positiveInteger(policy.maxRows, maxLimit, "maxRows");
  const maxPipelineStages = positiveInteger(policy.maxPipelineStages, 6, "maxPipelineStages");
  const timeoutMs = positiveInteger(policy.timeoutMs, 5_000, "timeoutMs");

  return {
    allowOps,
    allowEntities,
    denyFields,
    redactFields,
    ...(policy.tenantScope ? { tenantScope: policy.tenantScope } : {}),
    maxLimit,
    maxRows,
    maxPipelineStages,
    timeoutMs,
    requireApproval,
    budget: {
      maxToolCalls: positiveInteger(policy.budget?.maxToolCalls, 8, "budget.maxToolCalls"),
      maxTokens: positiveInteger(policy.budget?.maxTokens, 20_000, "budget.maxTokens"),
    },
  };
}

export function fieldsFor(
  map: Readonly<Record<string, readonly string[]>>,
  entity: string,
): string[] {
  return [...new Set([...(map["*"] ?? []), ...(map[entity] ?? [])])];
}

function entityAllowed(policy: NormalizedAgentPolicy, entity: string): boolean {
  return policy.allowEntities === "*" || policy.allowEntities.has(entity);
}

function fieldDenied(denied: readonly string[], field: string): boolean {
  const normalized = field.replace(/^\$/, "");
  return denied.some(
    (entry) =>
      normalized === entry ||
      normalized.startsWith(`${entry}.`) ||
      entry.startsWith(`${normalized}.`),
  );
}

function checkField(policy: NormalizedAgentPolicy, entity: string, field: string): string | null {
  if (fieldDenied(fieldsFor(policy.denyFields, entity), field)) {
    return `Field \`${field}\` is not allowed`;
  }
  return null;
}

function checkWhere(
  where: unknown,
  policy: NormalizedAgentPolicy,
  entity: string,
  path: string,
): string | null {
  if (where === undefined) return null;
  if (!isPlainObject(where)) return `${path} must be an object`;

  for (const [key, value] of Object.entries(where)) {
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(value)) return `${path}.${key} must be an array`;
      for (const [index, clause] of value.entries()) {
        const issue = checkWhere(clause, policy, entity, `${path}.${key}[${index}]`);
        if (issue) return issue;
      }
      continue;
    }

    if (key === "$not") {
      const issue = checkWhere(value, policy, entity, `${path}.$not`);
      if (issue) return issue;
      continue;
    }

    if (key.startsWith("$")) {
      return `${path}.${key} is not a supported filter`;
    }

    const issue = checkField(policy, entity, key);
    if (issue) return issue;

    if (isPlainObject(value)) {
      for (const operator of Object.keys(value)) {
        if (
          ![
            "eq",
            "ne",
            "gt",
            "gte",
            "lt",
            "lte",
            "in",
            "nin",
            "contains",
            "startsWith",
            "endsWith",
            "exists",
            "isNull",
          ].includes(operator)
        ) {
          return `${path}.${key}.${operator} is not a supported operator`;
        }
      }
    }
  }

  return null;
}

function checkSort(sort: unknown, policy: NormalizedAgentPolicy, entity: string): string | null {
  if (sort === undefined) return null;

  if (Array.isArray(sort)) {
    for (const entry of sort) {
      if (!isPlainObject(entry) || typeof entry.field !== "string") {
        return "sort entries must be `{ field, direction }` objects";
      }
      if (entry.direction !== "asc" && entry.direction !== "desc") {
        return "sort direction must be `asc` or `desc`";
      }
      const issue = checkField(policy, entity, entry.field);
      if (issue) return issue;
    }
    return null;
  }

  if (!isPlainObject(sort)) return "sort must be an object or array";

  for (const [field, direction] of Object.entries(sort)) {
    if (direction !== "asc" && direction !== "desc") {
      return "sort direction must be `asc` or `desc`";
    }
    const issue = checkField(policy, entity, field);
    if (issue) return issue;
  }

  return null;
}

function checkSelect(
  select: unknown,
  policy: NormalizedAgentPolicy,
  entity: string,
): string | null {
  if (select === undefined) return null;
  if (!Array.isArray(select) || select.some((field) => typeof field !== "string")) {
    return "select must be an array of field names";
  }

  for (const field of select) {
    const issue = checkField(policy, entity, field);
    if (issue) return issue;
  }
  return null;
}

function unwindPath(unwind: unknown): string | null {
  if (typeof unwind === "string") return unwind;
  if (isPlainObject(unwind) && typeof unwind.path === "string") return unwind.path;
  return null;
}

function checkPipeline(
  pipeline: unknown,
  policy: NormalizedAgentPolicy,
  entity: string,
): string | null {
  if (pipeline === undefined) return null;
  if (!Array.isArray(pipeline)) return "pipeline must be an array";

  let stages = 0;
  const inspect = (steps: unknown[], path: string): string | null => {
    for (const [index, step] of steps.entries()) {
      if (!isPlainObject(step)) return `${path}[${index}] must be an object`;
      const keys = Object.keys(step);
      if (keys.length !== 1) return `${path}[${index}] must contain exactly one stage`;
      const stage = keys[0] as string;
      if (!KNOWN_STAGES.has(stage)) return `${path}[${index}] uses unsupported stage ${stage}`;
      stages++;
      const value = step[stage];

      if (stage === "$match") {
        const issue = checkWhere(value, policy, entity, `${path}[${index}].$match`);
        if (issue) return issue;
      } else if (stage === "$project") {
        if (!isPlainObject(value)) return `${path}[${index}].$project must be an object`;
        for (const [field, flag] of Object.entries(value)) {
          if (flag !== 0 && flag !== 1) {
            return `${path}[${index}].$project.${field} must be 0 or 1`;
          }
          const issue = checkField(policy, entity, field);
          if (issue) return issue;
        }
      } else if (stage === "$group") {
        if (!isPlainObject(value)) return `${path}[${index}].$group must be an object`;
        const by = value.by;
        if (typeof by !== "string" && !isPlainObject(by)) {
          return `${path}[${index}].$group.by is invalid`;
        }
        const fields = typeof by === "string" ? [by] : Object.values(by);
        for (const field of fields) {
          if (typeof field !== "string") return `${path}[${index}].$group.by is invalid`;
          const issue = checkField(policy, entity, field);
          if (issue) return issue;
        }
        if (value.fields !== undefined && !isPlainObject(value.fields)) {
          return `${path}[${index}].$group.fields must be an object`;
        }
        for (const [name, agg] of Object.entries(value.fields ?? {})) {
          if (!isPlainObject(agg)) return `${path}[${index}].$group.fields.${name} is invalid`;
          if (
            !["count", "sum", "avg", "min", "max"].includes(String(agg.op)) ||
            (agg.op !== "count" && typeof agg.field !== "string")
          ) {
            return `${path}[${index}].$group.fields.${name} is invalid`;
          }
          if (typeof agg.field === "string") {
            const issue = checkField(policy, entity, agg.field);
            if (issue) return issue;
          }
        }
      } else if (stage === "$sort") {
        const issue = checkSort(value, policy, entity);
        if (issue) return issue;
      } else if (stage === "$limit" || stage === "$skip") {
        if (!Number.isInteger(value) || (value as number) < 0) {
          return `${path}[${index}].${stage} must be a non-negative integer`;
        }
      } else if (stage === "$unwind") {
        const path = unwindPath(value);
        if (!path) return `${path}[${index}].$unwind is invalid`;
        const issue = checkField(policy, entity, path);
        if (issue) return issue;
      } else if (stage === "$addFields") {
        if (!isPlainObject(value)) return `${path}[${index}].$addFields must be an object`;
        for (const field of Object.keys(value)) {
          const issue = checkField(policy, entity, field);
          if (issue) return issue;
        }
      } else if (stage === "$count") {
        if (typeof value !== "string" || value.length === 0) {
          return `${path}[${index}].$count must be a non-empty string`;
        }
      } else if (stage === "$lookup") {
        if (!isPlainObject(value)) return `${path}[${index}].$lookup must be an object`;
        if (typeof value.from !== "string" || !entityAllowed(policy, value.from)) {
          return `Entity \`${String(value.from)}\` is not allowed`;
        }
        for (const field of [value.localField, value.foreignField, value.as]) {
          if (typeof field !== "string" || field.length === 0) {
            return `${path}[${index}].$lookup is invalid`;
          }
        }
        for (const field of [value.localField, value.as]) {
          const issue = checkField(policy, entity, field as string);
          if (issue) return issue;
        }
        if (value.pipeline !== undefined) {
          const issue = inspect(value.pipeline as unknown[], `${path}[${index}].$lookup.pipeline`);
          if (issue) return issue;
        }
      }
    }
    return null;
  };

  const issue = inspect(pipeline as unknown[], "pipeline");
  if (issue) return issue;
  if (stages > policy.maxPipelineStages) {
    return `Pipeline has ${stages} stages; maximum is ${policy.maxPipelineStages}`;
  }
  return null;
}

function applyTenant(where: Where<any> | undefined, tenant: Where<any>): Where<any> {
  return where ? { $and: [tenant, where] } : tenant;
}

export async function guardQuery(
  input: unknown,
  policy: NormalizedAgentPolicy,
  context: AgentContext = {},
): Promise<Result<GuardedQuery>> {
  try {
    if (!isPlainObject(input)) {
      throw new RawLibError("VALIDATION_FAILED", "Query must be an object");
    }

    const query = clone(input) as Query<any>;
    const decisions: string[] = [];

    if (typeof query.op !== "string" || !KNOWN_OPS.has(query.op)) {
      throw new RawLibError("VALIDATION_FAILED", "Query has an unknown operation");
    }

    if (!policy.allowOps.has(query.op)) {
      throw new RawLibError("FORBIDDEN", `Operation \`${query.op}\` is not allowed`);
    }

    if (typeof query.entity !== "string" || query.entity.length === 0) {
      throw new RawLibError("VALIDATION_FAILED", "Query must include an entity");
    }

    if (!entityAllowed(policy, query.entity)) {
      throw new RawLibError("FORBIDDEN", `Entity \`${query.entity}\` is not allowed`);
    }

    const whereIssue = checkWhere(query.where, policy, query.entity, "where");
    if (whereIssue) throw new RawLibError("FORBIDDEN", whereIssue);

    const sortIssue = checkSort(query.sort, policy, query.entity);
    if (sortIssue) throw new RawLibError("FORBIDDEN", sortIssue);

    const selectIssue = checkSelect(query.select, policy, query.entity);
    if (selectIssue) throw new RawLibError("FORBIDDEN", selectIssue);

    const pipelineIssue = checkPipeline(query.pipeline, policy, query.entity);
    if (pipelineIssue) throw new RawLibError("FORBIDDEN", pipelineIssue);

    if (query.data !== undefined) {
      const rows = Array.isArray(query.data) ? query.data : [query.data];
      for (const row of rows) {
        if (!isPlainObject(row)) {
          throw new RawLibError("VALIDATION_FAILED", "Write data must be an object");
        }
        for (const field of Object.keys(row)) {
          const issue = checkField(policy, query.entity, field);
          if (issue) throw new RawLibError("FORBIDDEN", issue);
        }
      }
    }

    if (query.op === "list") {
      const limit = query.page?.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new RawLibError("VALIDATION_FAILED", "Page limit must be a positive integer");
      }

      const capped = Math.min(limit ?? policy.maxLimit, policy.maxLimit);
      if (limit !== undefined && limit > capped) {
        decisions.push(`Clamped limit from ${limit} to ${capped}`);
      }
      query.page = { ...(query.page ?? {}), limit: capped };

      if (query.page.offset !== undefined) {
        if (!Number.isInteger(query.page.offset) || query.page.offset < 0) {
          throw new RawLibError("VALIDATION_FAILED", "Page offset must be a non-negative integer");
        }
      }
    }

    if (policy.tenantScope) {
      const tenant = await policy.tenantScope(context);
      if (!isPlainObject(tenant)) {
        throw new RawLibError("INTERNAL_ERROR", "`tenantScope` must return a where object");
      }

      if (tenant && Object.keys(tenant).length > 0) {
        if (query.op === "aggregate") {
          query.pipeline = [{ $match: tenant }, ...(query.pipeline ?? [])];
          decisions.push("Injected tenant scope into the pipeline");
        } else {
          query.where = applyTenant(query.where, tenant);
          decisions.push("Injected tenant scope into the filter");
        }
      }
    }

    return {
      ok: true,
      data: {
        query,
        decisions,
        redactFields: fieldsFor(policy.redactFields, query.entity),
        requiresApproval: policy.requireApproval.has(query.op),
      },
    };
  } catch (error) {
    return { ok: false, error: toRawLibError(error).toJSON() };
  }
}

export function redactRows<T>(value: T, fields: readonly string[]): T {
  if (fields.length === 0 || value === null || value === undefined) return value;
  const copy = clone(value);
  return redactValue(copy, fields) as T;
}

function redactValue(value: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, fields));
  }
  if (!isPlainObject(value)) return value;

  for (const path of fields) {
    redactPath(value, path.split("."));
  }
  return value;
}

function redactPath(target: Record<string, unknown>, parts: string[]): void {
  const [head, ...rest] = parts;
  if (!head || !(head in target)) return;

  const current = target[head];
  if (rest.length === 0) {
    target[head] = "[redacted]";
    return;
  }

  if (Array.isArray(current)) {
    for (const entry of current) {
      if (isPlainObject(entry)) redactPath(entry, rest);
    }
    return;
  }
  if (isPlainObject(current)) redactPath(current, rest);
}

export function rowCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (value === null || value === undefined) return 0;
  return 1;
}

export function capRows<T>(value: T, maxRows: number): { value: T; truncated: boolean } {
  if (Array.isArray(value) && value.length > maxRows) {
    return { value: value.slice(0, maxRows) as T, truncated: true };
  }
  return { value, truncated: false };
}

export function describeEntityFields(
  config: AgentEntity | undefined,
  sample: Record<string, unknown> | undefined,
  policy: NormalizedAgentPolicy,
  entity: string,
): Record<string, AgentField> {
  const fields: Record<string, AgentField> = {};
  const denied = fieldsFor(policy.denyFields, entity);

  for (const [name, field] of Object.entries(config?.fields ?? {})) {
    if (fieldDenied(denied, name)) continue;
    fields[name] = typeof field === "string" ? { type: field } : { ...field };
  }

  if (Object.keys(fields).length === 0) {
    for (const [name, value] of Object.entries(sample ?? config?.sample ?? {})) {
      if (name === "_id" || fieldDenied(denied, name)) continue;
      fields[name] = { type: inferType(value) };
    }
  }

  return fields;
}

function inferType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  return typeof value;
}

export function pipelineStageCount(steps: PipelineStep[] | undefined): number {
  if (!steps) return 0;
  let count = 0;
  for (const step of steps) {
    count++;
    if ("$lookup" in step && step.$lookup.pipeline) {
      count += pipelineStageCount(step.$lookup.pipeline);
    }
  }
  return count;
}
