import { normalizeQuery } from "../core/compiler/query";
import { requiredCapabilities } from "../core/engine/capabilities";
import type { RawQl } from "../core/engine/engine";
import { RawLibError, toRawLibError } from "../core/errors";
import type { Query } from "../core/types/query";
import type { Result } from "../core/types/result";
import { isPlainObject } from "../core/utils";
import { capRows, describeEntityFields, guardQuery, redactRows, rowCount } from "./policy";
import type {
  AgentContext,
  AgentEntities,
  AgentToolCall,
  AgentToolDefinition,
  ApprovalCallback,
  EntityDescription,
  NormalizedAgentPolicy,
  ToolExecution,
} from "./types";

export type AgentToolkitConfig = {
  db: RawQl;
  policy: NormalizedAgentPolicy;
  entities?: AgentEntities;
  approve?: ApprovalCallback;
};

export type ToolExecutionOptions = {
  runId: string;
  context: AgentContext;
};

export type AgentToolkit = {
  definitions: AgentToolDefinition[];
  execute(call: AgentToolCall, options: ToolExecutionOptions): Promise<ToolExecution>;
};

const querySchema = {
  type: "object",
  description: "A typed raw_lib query. Read-only by default.",
  additionalProperties: false,
  properties: {
    op: {
      type: "string",
      enum: ["list", "get", "count", "aggregate", "create", "update", "delete"],
    },
    entity: { type: "string" },
    where: { type: "object" },
    data: { type: ["object", "array"] },
    sort: { type: ["object", "array"] },
    select: { type: "array", items: { type: "string" } },
    page: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer" }, offset: { type: "integer" } },
    },
    pipeline: { type: "array", items: { type: "object" } },
  },
  required: ["op", "entity"],
};

export function defineAgentTools(config: AgentToolkitConfig): AgentToolkit {
  const { db, policy } = config;
  const entities = config.entities ?? {};

  const definitions: AgentToolDefinition[] = [
    {
      name: "describe_entity",
      description:
        "Describe an entity: fields, relations, and the operations you may use. Call this before querying an unfamiliar entity.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { entity: { type: "string" } },
        required: ["entity"],
      },
    },
    {
      name: "query",
      description:
        "Run a typed raw_lib query. Use it for list, get, count, or approved writes. Prefer explicit select lists.",
      parameters: querySchema,
    },
    {
      name: "aggregate",
      description:
        "Run a typed aggregation pipeline (`$match`, `$group`, `$sort`, `$limit`, `$skip`, `$project`, `$lookup`, `$unwind`, `$addFields`, `$count`).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity: { type: "string" },
          pipeline: { type: "array", items: { type: "object" } },
        },
        required: ["entity", "pipeline"],
      },
    },
    {
      name: "explain",
      description:
        "Compile a query without executing it. Returns the normalized plan and required adapter capabilities.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: querySchema },
        required: ["query"],
      },
    },
  ];

  async function describe(entity: string): Promise<Result<EntityDescription>> {
    const name = entity.trim();
    if (!name) {
      return {
        ok: false,
        error: new RawLibError("VALIDATION_FAILED", "`entity` must not be empty").toJSON(),
      };
    }

    if (policy.allowEntities !== "*" && !policy.allowEntities.has(name)) {
      return {
        ok: false,
        error: new RawLibError("FORBIDDEN", `Entity \`${name}\` is not allowed`).toJSON(),
      };
    }

    const config = entities[name];
    let sample = config?.sample;

    if (!config?.fields && !sample) {
      const result = await db.execute<Record<string, unknown>[]>(
        { op: "list", entity: name, page: { limit: 1 } },
        { validate: false },
      );
      if (result.ok) sample = result.data[0];
    }

    const fields = describeEntityFields(config, sample, policy, name);
    const relations: EntityDescription["relations"] = {};
    for (const [field, relation] of Object.entries(config?.relations ?? {})) {
      if (policy.allowEntities !== "*" && !policy.allowEntities.has(relation.entity)) continue;
      relations[field] = relation;
    }

    return {
      ok: true,
      data: {
        entity: name,
        ...(config?.description ? { description: config.description } : {}),
        fields,
        relations,
        allowedOps: [...policy.allowOps],
      },
    };
  }

  async function runQuery(
    query: unknown,
    options: ToolExecutionOptions,
    startedAt: number,
  ): Promise<ToolExecution> {
    const guarded = await guardQuery(query, policy, options.context);
    if (!guarded.ok) {
      return {
        result: { ok: false, error: guarded.error },
        payload: { ok: false, error: guarded.error },
        decisions: [],
        invalid: guarded.error.code === "VALIDATION_FAILED",
        rows: 0,
        tookMs: Date.now() - startedAt,
      };
    }

    const proposedQuery = isPlainObject(query) ? (query as Query<any>) : undefined;
    const decisions = [...guarded.data.decisions];

    if (guarded.data.requiresApproval) {
      const request = {
        runId: options.runId,
        op: guarded.data.query.op,
        entity: guarded.data.query.entity,
        query: guarded.data.query,
        context: options.context,
      };

      const approved = config.approve ? await config.approve(request) : false;
      if (!approved) {
        const error = new RawLibError(
          "FORBIDDEN",
          `Operation \`${guarded.data.query.op}\` requires human approval`,
        ).toJSON();
        return {
          result: { ok: false, error },
          payload: { ok: false, error },
          proposedQuery,
          guardedQuery: guarded.data.query,
          decisions,
          invalid: false,
          rows: 0,
          tookMs: Date.now() - startedAt,
        };
      }
      decisions.push(`Approved \`${guarded.data.query.op}\` on \`${guarded.data.query.entity}\``);
    }

    const execution = await withTimeout(db.execute<unknown>(guarded.data.query), policy.timeoutMs);

    if (!execution.ok) {
      return {
        result: execution,
        payload: { ok: false, error: execution.error },
        proposedQuery,
        guardedQuery: guarded.data.query,
        decisions,
        invalid: false,
        rows: 0,
        tookMs: Date.now() - startedAt,
      };
    }

    const capped = capRows(execution.data, policy.maxRows);
    if (capped.truncated) decisions.push(`Truncated rows to ${policy.maxRows}`);
    const redacted = redactForQuery(
      capped.value,
      guarded.data.query,
      guarded.data.redactFields,
      policy,
    );

    return {
      result: execution,
      payload: {
        ok: true,
        data: redacted,
        ...(execution.meta ? { meta: execution.meta } : {}),
      },
      data: redacted,
      proposedQuery,
      guardedQuery: guarded.data.query,
      decisions,
      invalid: false,
      rows: rowCount(redacted),
      tookMs: Date.now() - startedAt,
    };
  }

  async function execute(
    call: AgentToolCall,
    options: ToolExecutionOptions,
  ): Promise<ToolExecution> {
    const startedAt = Date.now();
    const parsed = parseArguments(call.arguments);

    if (!parsed.ok) {
      return {
        result: { ok: false, error: parsed.error },
        payload: { ok: false, error: parsed.error },
        decisions: [],
        invalid: true,
        rows: 0,
        tookMs: Date.now() - startedAt,
      };
    }

    const args = parsed.data;

    try {
      switch (call.name) {
        case "describe_entity": {
          if (typeof args.entity !== "string") {
            throw new RawLibError("VALIDATION_FAILED", "`entity` must be a string");
          }
          const result = await describe(args.entity);
          return {
            result,
            payload: result,
            decisions: [],
            invalid: !result.ok && result.error.code === "VALIDATION_FAILED",
            rows: 0,
            tookMs: Date.now() - startedAt,
          };
        }

        case "query": {
          if (!isPlainObject(args.query)) {
            throw new RawLibError("VALIDATION_FAILED", "`query` must be an object");
          }
          return await runQuery(args.query, options, startedAt);
        }

        case "aggregate": {
          if (typeof args.entity !== "string" || !Array.isArray(args.pipeline)) {
            throw new RawLibError(
              "VALIDATION_FAILED",
              "`aggregate` requires an entity and a pipeline array",
            );
          }
          const query: Query<any> = {
            op: "aggregate",
            entity: args.entity,
            pipeline: args.pipeline as Query<any>["pipeline"],
          };
          return await runQuery(query, options, startedAt);
        }

        case "explain": {
          if (!isPlainObject(args.query)) {
            throw new RawLibError("VALIDATION_FAILED", "`query` must be an object");
          }
          const guarded = await guardQuery(args.query, policy, options.context);
          if (!guarded.ok) {
            return {
              result: { ok: false, error: guarded.error },
              payload: { ok: false, error: guarded.error },
              decisions: [],
              invalid: guarded.error.code === "VALIDATION_FAILED",
              rows: 0,
              tookMs: Date.now() - startedAt,
            };
          }

          const entity = db.resolveEntity(guarded.data.query.entity);
          const normalized = normalizeQuery(guarded.data.query, entity);
          const capabilities = [...requiredCapabilities(normalized)];
          const result: Result<unknown> = {
            ok: true,
            data: { plan: normalized, capabilities },
          };

          return {
            result,
            payload: result,
            proposedQuery: guarded.data.query,
            guardedQuery: guarded.data.query,
            decisions: guarded.data.decisions,
            invalid: false,
            rows: 0,
            tookMs: Date.now() - startedAt,
          };
        }

        default:
          throw new RawLibError("VALIDATION_FAILED", `Unknown tool: ${call.name}`);
      }
    } catch (error) {
      const shape = toRawLibError(error).toJSON();
      return {
        result: { ok: false, error: shape },
        payload: { ok: false, error: shape },
        decisions: [],
        invalid: shape.code === "VALIDATION_FAILED",
        rows: 0,
        tookMs: Date.now() - startedAt,
      };
    }
  }

  return { definitions, execute };
}

function parseArguments(value: Record<string, unknown> | string): Result<Record<string, unknown>> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          error: new RawLibError("VALIDATION_FAILED", "Tool arguments must be an object").toJSON(),
        };
      }
      return { ok: true, data: parsed };
    } catch {
      return {
        ok: false,
        error: new RawLibError("VALIDATION_FAILED", "Tool arguments are not valid JSON").toJSON(),
      };
    }
  }

  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: new RawLibError("VALIDATION_FAILED", "Tool arguments must be an object").toJSON(),
    };
  }
  return { ok: true, data: value };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new RawLibError("TIMEOUT", `Tool call exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function redactForQuery(
  value: unknown,
  query: Query<any>,
  redactFields: readonly string[],
  policy: NormalizedAgentPolicy,
): unknown {
  const fields = [...redactFields];
  const lookups: { as: string; entity: string }[] = [];

  for (const step of query.pipeline ?? []) {
    if ("$lookup" in step) {
      lookups.push({ as: step.$lookup.as, entity: step.$lookup.from });
    }
  }

  let output = redactRows(value, fields);

  for (const lookup of lookups) {
    const target = [...new Set([...(policy.redactFields[lookup.entity] ?? [])])];
    if (target.length === 0) continue;
    output = redactLookup(output, lookup.as, target);
  }

  return output;
}

function redactLookup(value: unknown, as: string, fields: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactLookup(entry, as, fields));
  }
  if (!isPlainObject(value)) return value;

  const copy = { ...value };
  if (Array.isArray(copy[as])) {
    copy[as] = redactRows(copy[as], fields);
  }
  return copy;
}
