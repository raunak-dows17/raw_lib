import { RawLibError } from "../errors";
import type { ResolvedEntity } from "../types/entity";
import type { Page, PipelineStep, Query, Sort, Where } from "../types/query";
import type { Result } from "../types/result";
import type { RawQl } from "./engine";

export type ListInput<T> = {
  where?: Where<T>;
  sort?: Sort;
  select?: (keyof T & string)[];
  page?: Page;
};

export type GetInput<T> =
  | { id: unknown; select?: (keyof T & string)[] }
  | { where: Where<T>; select?: (keyof T & string)[] };

export type CreateInput<T> = {
  data: Partial<T> | Partial<T>[];
};

export type UpdateInput<T> = {
  data: Partial<T>;
  id?: unknown;
  where?: Where<T>;
};

export type DeleteInput<T> = { id: unknown } | { where: Where<T> };

export type CountInput<T> = {
  where?: Where<T>;
};

export type AggregateInput = {
  pipeline: PipelineStep[];
};

export class EntityClient<T> {
  constructor(
    private readonly db: RawQl,
    private readonly entity: ResolvedEntity,
  ) {}

  list(input: ListInput<T> = {}): Promise<Result<T[]>> {
    return this.db.execute<T[]>({
      op: "list",
      entity: this.entity.name,
      where: input.where,
      sort: input.sort,
      select: input.select,
      page: input.page,
    });
  }

  get(input: GetInput<T>): Promise<Result<T | null>> {
    return this.db.execute<T | null>({
      op: "get",
      entity: this.entity.name,
      where: this.toWhere(input),
      select: input.select,
    });
  }

  create(input: CreateInput<T>): Promise<Result<T | T[]>> {
    return this.db.execute<T | T[]>({
      op: "create",
      entity: this.entity.name,
      data: input.data,
    });
  }

  update(input: UpdateInput<T>): Promise<Result<{ id: string | null }>> {
    return this.db.execute<{ id: string | null }>({
      op: "update",
      entity: this.entity.name,
      where: this.toWhere(input),
      data: input.data,
    });
  }

  delete(input: DeleteInput<T>): Promise<Result<{ id: string | null }>> {
    return this.db.execute<{ id: string | null }>({
      op: "delete",
      entity: this.entity.name,
      where: this.toWhere(input),
    });
  }

  count(input: CountInput<T> = {}): Promise<Result<number>> {
    return this.db.execute<number>({
      op: "count",
      entity: this.entity.name,
      where: input.where,
    });
  }

  aggregate<U = unknown>(input: AggregateInput): Promise<Result<U[]>> {
    return this.db.execute<U[]>({
      op: "aggregate",
      entity: this.entity.name,
      pipeline: input.pipeline,
    });
  }

  private toWhere(input: { id?: unknown; where?: Where<T> }): Where<T> {
    if (input.id !== undefined) {
      return { [this.entity.idField]: input.id } as Where<T>;
    }
    if (!input.where) {
      throw new RawLibError("VALIDATION_FAILED", "Either `id` or `where` is required");
    }
    return input.where;
  }
}

export type EntityQuery<T> = Query<T>;
