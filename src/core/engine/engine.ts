import { type NormalizeOptions, normalizeQuery } from "../compiler/query";
import { RawLibError, toRawLibError } from "../errors";
import type { Adapter, AdapterResult } from "../types/adapter";
import type { EntityConfig, EntityRegistry, ResolvedEntity } from "../types/entity";
import type { Op, Query } from "../types/query";
import type { Result } from "../types/result";
import { assertCapabilities } from "./capabilities";
import { EntityClient } from "./entity-client";
import { mapAdapterResult } from "./result";

export type MiddlewareContext = {
  query: Query<any>;
  entity: ResolvedEntity;
  db: RawQl;
};

export type Middleware = (context: MiddlewareContext) => Promise<void> | void;

export type ValidatorIssue = {
  path: string;
  message: string;
  code?: string;
};

export type ValidatorResult =
  | { ok: true; value?: unknown }
  | { ok: false; issues: ValidatorIssue[] };

export type Validator = {
  validate(input: {
    op: Op;
    entity: ResolvedEntity;
    query: Query<any>;
    data: unknown;
  }): Promise<ValidatorResult> | ValidatorResult;
};

export type RawQlConfig = {
  adapter: Adapter;
  entities?: EntityRegistry;
  /** Preferred name for the validation hook. */
  validate?: Validator;
  /** Alias kept for early 2.0 alpha builds. */
  validator?: Validator;
  middlewares?: Middleware[];
  defaults?: NormalizeOptions;
};

export class RawQl {
  readonly adapter: Adapter;
  private readonly entities: EntityRegistry;
  private readonly validator?: Validator;
  private readonly middlewares: Middleware[];
  private readonly defaults: NormalizeOptions;

  constructor(config: RawQlConfig) {
    if (!config?.adapter) {
      throw new RawLibError("VALIDATION_FAILED", "An adapter is required");
    }

    this.adapter = config.adapter;
    this.entities = config.entities ?? {};
    this.validator = config.validate ?? config.validator;
    this.middlewares = [...(config.middlewares ?? [])];
    this.defaults = config.defaults ?? {};
  }

  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  resolveEntity(name: string): ResolvedEntity {
    if (typeof name !== "string" || name.length === 0) {
      throw new RawLibError("VALIDATION_FAILED", "`entity` must be a non-empty string");
    }

    const config: EntityConfig = this.entities[name] ?? {};

    return {
      name,
      collection: config.collection ?? name,
      idField: config.idField ?? "id",
    };
  }

  entity<T>(name: string): EntityClient<T> {
    return new EntityClient<T>(this, this.resolveEntity(name));
  }

  async execute<T = unknown>(input: Query<any>): Promise<Result<T>> {
    const startedAt = Date.now();

    try {
      if (!input || typeof input !== "object") {
        throw new RawLibError("VALIDATION_FAILED", "Query must be an object");
      }

      const entity = this.resolveEntity(input.entity);
      const query: Query<any> = { ...input };

      for (const middleware of this.middlewares) {
        await middleware({ query, entity, db: this });
      }

      if (this.validator) {
        const validation = await this.validator.validate({
          op: query.op,
          entity,
          query,
          data: query.data,
        });

        if (!validation.ok) {
          return {
            ok: false,
            error: {
              code: "VALIDATION_FAILED",
              message: "Validation failed",
              details: validation.issues,
            },
          };
        }

        if (validation.value !== undefined && (query.op === "create" || query.op === "update")) {
          query.data = validation.value as Query<any>["data"];
        }
      }

      const normalized = normalizeQuery(query, entity, this.defaults);
      assertCapabilities(normalized, this.adapter.capabilities);

      let adapterResult: AdapterResult<T>;

      try {
        adapterResult = await this.adapter.execute<T>(normalized);
      } catch (error) {
        throw toRawLibError(error, "ADAPTER_ERROR");
      }

      return mapAdapterResult<T>(adapterResult, normalized, this.adapter.name, startedAt);
    } catch (error) {
      return { ok: false, error: toRawLibError(error).toJSON() };
    }
  }

  async close(): Promise<void> {
    await this.adapter.close?.();
  }
}

export function createRawQl(config: RawQlConfig): RawQl {
  return new RawQl(config);
}
