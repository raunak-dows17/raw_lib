import { randomUUID } from "node:crypto";
import { RawLibError } from "../errors";
import type { Adapter, AdapterResult } from "../types/adapter";
import type { Capability } from "../types/capability";
import type {
  CompiledWhere,
  NormalizedPipelineStep,
  NormalizedQuery,
  NormalizedSort,
} from "../types/normalized";
import type { Agg, GroupSpec, UnwindSpec } from "../types/query";
import {
  clone,
  compareValues,
  deletePath,
  getPath,
  isPlainObject,
  setPath,
  valuesEqual,
} from "../utils";

export type MemorySeed = Record<string, Record<string, unknown>[]>;

export type MemoryAdapterOptions = {
  seed?: MemorySeed;
};

const CAPABILITIES: Capability[] = [
  "filter.logical",
  "filter.comparison",
  "filter.array",
  "filter.text",
  "filter.presence",
  "sort",
  "select",
  "page.offset",
  "pipeline.match",
  "pipeline.group",
  "pipeline.sort",
  "pipeline.limit",
  "pipeline.skip",
  "pipeline.project",
  "pipeline.lookup",
  "pipeline.unwind",
  "pipeline.addFields",
  "pipeline.count",
  "atomic.update",
];

export class MemoryAdapter implements Adapter {
  readonly name = "memory";
  readonly capabilities = new Set<Capability>(CAPABILITIES);

  private readonly store = new Map<string, Record<string, unknown>[]>();

  constructor(options: MemoryAdapterOptions = {}) {
    if (options.seed) this.seed(options.seed);
  }

  seed(data: MemorySeed): void {
    for (const [entity, rows] of Object.entries(data)) {
      const existing = this.store.get(entity) ?? [];
      const seeded = rows.map((input) => {
        const row = clone(input);
        if (row.id === undefined && row._id === undefined) {
          row.id = randomUUID();
        }
        return row;
      });
      this.store.set(entity, [...existing, ...seeded]);
    }
  }

  async execute<T>(query: NormalizedQuery): Promise<AdapterResult<T>> {
    switch (query.op) {
      case "list":
        return this.list<T>(query);
      case "get":
        return this.get<T>(query);
      case "create":
        return this.create<T>(query);
      case "update":
        return this.update<T>(query);
      case "delete":
        return this.delete<T>(query);
      case "count":
        return this.count<T>(query);
      case "aggregate":
        return this.aggregate<T>(query);
    }
  }

  private rows(entity: string): Record<string, unknown>[] {
    let rows = this.store.get(entity);
    if (!rows) {
      rows = [];
      this.store.set(entity, rows);
    }
    return rows;
  }

  private async list<T>(query: NormalizedQuery): Promise<AdapterResult<T>> {
    const filtered = this.rows(query.entity.name).filter((row) => matches(row, query.where));
    const sorted = applySort(filtered, query.sort);
    const paged = applyPage(sorted, query.page);
    const items = paged.map((row) => applySelect(row, query.select));

    return { kind: "items", items: items as T[], total: filtered.length };
  }

  private async get<T>(query: NormalizedQuery): Promise<AdapterResult<T>> {
    const row = this.rows(query.entity.name).find((candidate) => matches(candidate, query.where));

    return {
      kind: "item",
      item: row ? (applySelect(row, query.select) as T) : null,
    };
  }

  private async create<T>(query: NormalizedQuery): Promise<AdapterResult<T>> {
    const data = query.data;

    if (data === undefined) {
      throw new RawLibError("VALIDATION_FAILED", "`create` requires `data`");
    }

    const idField = query.entity.idField;
    const input = Array.isArray(data) ? data : [data];

    const created = input.map((item) => {
      if (!isPlainObject(item)) {
        throw new RawLibError(
          "VALIDATION_FAILED",
          "`create` data must be an object or an array of objects",
        );
      }

      const row = clone(item) as Record<string, unknown>;

      if (row[idField] === undefined || row[idField] === null || row[idField] === "") {
        row[idField] = randomUUID();
      }

      this.rows(query.entity.name).push(row);
      return clone(row);
    });

    if (Array.isArray(data)) {
      return { kind: "items", items: created as T[] };
    }

    return { kind: "item", item: created[0] as T };
  }

  private async update<T>(query: NormalizedQuery): Promise<AdapterResult<T>> {
    const rows = this.rows(query.entity.name);
    const indices: number[] = [];

    rows.forEach((row, index) => {
      if (matches(row, query.where)) indices.push(index);
    });

    if (indices.length === 0) {
      return { kind: "ack", matched: 0 };
    }

    if (!isPlainObject(query.data)) {
      throw new RawLibError("VALIDATION_FAILED", "`update` data must be an object");
    }

    const patch = clone(query.data) as Record<string, unknown>;
    delete patch[query.entity.idField];

    for (const index of indices) {
      rows[index] = { ...rows[index], ...patch };
    }

    const first = rows[indices[0] as number] as Record<string, unknown>;
    const id = first[query.entity.idField];

    return {
      kind: "ack",
      matched: indices.length,
      id: id === undefined || id === null ? undefined : String(id),
    };
  }

  private async delete<T>(query: NormalizedQuery): Promise<AdapterResult<T>> {
    const rows = this.rows(query.entity.name);
    const kept: Record<string, unknown>[] = [];
    let removed = 0;
    let firstId: string | undefined;

    for (const row of rows) {
      if (matches(row, query.where)) {
        removed++;
        if (firstId === undefined) {
          const id = row[query.entity.idField];
          firstId = id === undefined || id === null ? undefined : String(id);
        }
      } else {
        kept.push(row);
      }
    }

    this.store.set(query.entity.name, kept);

    return { kind: "ack", matched: removed, id: firstId };
  }

  private async count<T>(query: NormalizedQuery): Promise<AdapterResult<T>> {
    const count = this.rows(query.entity.name).filter((row) => matches(row, query.where)).length;
    return { kind: "count", count };
  }

  private async aggregate<T>(query: NormalizedQuery): Promise<AdapterResult<T>> {
    const rows = applyPipeline(this.rows(query.entity.name), query.pipeline ?? [], this.store);
    return { kind: "items", items: rows as T[] };
  }
}

function applyPage(
  rows: Record<string, unknown>[],
  page?: { limit: number; offset: number },
): Record<string, unknown>[] {
  if (!page) return rows;
  return rows.slice(page.offset, page.offset + page.limit);
}

function applySort(
  rows: Record<string, unknown>[],
  sort?: NormalizedSort,
): Record<string, unknown>[] {
  if (!sort || sort.length === 0) return rows;

  const copy = [...rows];
  copy.sort((left, right) => {
    for (const { field, direction } of sort) {
      const leftValue = getPath(left, field);
      const rightValue = getPath(right, field);
      const leftNull = leftValue === null || leftValue === undefined;
      const rightNull = rightValue === null || rightValue === undefined;

      if (leftNull && rightNull) continue;
      if (leftNull) return 1;
      if (rightNull) return -1;

      const result = compareValues(leftValue, rightValue);
      if (Number.isNaN(result)) continue;
      if (result !== 0) return direction === "asc" ? result : -result;
    }
    return 0;
  });

  return copy;
}

function applySelect(row: Record<string, unknown>, select?: string[]): Record<string, unknown> {
  if (!select) return clone(row);

  const output: Record<string, unknown> = {};
  for (const field of select) {
    const value = getPath(row, field);
    if (value !== undefined) setPath(output, field, clone(value));
  }
  return output;
}

function matches(row: Record<string, unknown>, where?: CompiledWhere): boolean {
  if (!where) return true;

  switch (where.kind) {
    case "and":
      return where.clauses.every((clause) => matches(row, clause));
    case "or":
      return where.clauses.some((clause) => matches(row, clause));
    case "not":
      return !matches(row, where.clause);
    case "comparison": {
      const value = getPath(row, where.field);
      switch (where.op) {
        case "eq":
          return valuesEqual(value, where.value);
        case "ne":
          return !valuesEqual(value, where.value);
        case "gt":
          return compareForOrder(value, where.value) > 0;
        case "gte":
          return compareForOrder(value, where.value) >= 0;
        case "lt":
          return compareForOrder(value, where.value) < 0;
        case "lte":
          return compareForOrder(value, where.value) <= 0;
      }
      return false;
    }
    case "array": {
      const value = getPath(row, where.field);
      const values = Array.isArray(value) ? value : [value];

      if (where.op === "in") {
        return values.some((item) => where.value.some((candidate) => valuesEqual(item, candidate)));
      }

      return values.every((item) =>
        where.value.every((candidate) => !valuesEqual(item, candidate)),
      );
    }
    case "text": {
      const value = getPath(row, where.field);
      if (typeof value !== "string") return false;

      const haystack = value.toLowerCase();
      const needle = where.value.toLowerCase();

      switch (where.op) {
        case "contains":
          return haystack.includes(needle);
        case "startsWith":
          return haystack.startsWith(needle);
        case "endsWith":
          return haystack.endsWith(needle);
      }
      return false;
    }
    case "presence": {
      const value = getPath(row, where.field);
      return where.op === "exists"
        ? (value !== undefined) === where.value
        : (value == null) === where.value;
    }
  }
}

function compareForOrder(left: unknown, right: unknown): number {
  if (left instanceof Date) left = left.getTime();
  if (right instanceof Date) right = right.getTime();

  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  if (left === right) return 0;

  return Number.NaN;
}

function applyPipeline(
  rows: Record<string, unknown>[],
  pipeline: NormalizedPipelineStep[],
  store: Map<string, Record<string, unknown>[]>,
): Record<string, unknown>[] {
  let current = rows.map((row) => clone(row));

  for (const step of pipeline) {
    if ("$match" in step) {
      current = current.filter((row) => matches(row, step.$match));
    } else if ("$sort" in step) {
      current = applySort(current, step.$sort);
    } else if ("$limit" in step) {
      current = current.slice(0, step.$limit);
    } else if ("$skip" in step) {
      current = current.slice(step.$skip);
    } else if ("$project" in step) {
      current = current.map((row) => applyProject(row, step.$project));
    } else if ("$group" in step) {
      current = applyGroup(current, step.$group);
    } else if ("$addFields" in step) {
      current = current.map((row) => applyAddFields(row, step.$addFields));
    } else if ("$unwind" in step) {
      current = applyUnwind(current, step.$unwind);
    } else if ("$lookup" in step) {
      current = applyLookup(current, step.$lookup, store);
    } else if ("$count" in step) {
      current = [{ [step.$count]: current.length }];
    }
  }

  return current;
}

function applyProject(
  row: Record<string, unknown>,
  project: Record<string, 0 | 1>,
): Record<string, unknown> {
  const entries = Object.entries(project);
  const includes = entries.filter(([, flag]) => flag === 1).map(([key]) => key);
  const excludes = new Set(entries.filter(([, flag]) => flag === 0).map(([key]) => key));

  if (includes.length === 0) {
    const output = clone(row);
    for (const key of excludes) delete output[key];
    return output;
  }

  const output: Record<string, unknown> = {};
  for (const key of includes) {
    if (excludes.has(key)) continue;
    const value = getPath(row, key);
    if (value !== undefined) setPath(output, key, clone(value));
  }
  return output;
}

function applyAddFields(
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const output = clone(row);
  for (const [key, value] of Object.entries(fields)) {
    setPath(output, key, clone(value));
  }
  return output;
}

function applyGroup(rows: Record<string, unknown>[], group: GroupSpec): Record<string, unknown>[] {
  const groups = new Map<string, { id: unknown; rows: Record<string, unknown>[] }>();

  for (const row of rows) {
    const id =
      typeof group.by === "string"
        ? getPath(row, group.by)
        : Object.fromEntries(
            Object.entries(group.by).map(([key, field]) => [key, getPath(row, field)]),
          );

    const key = JSON.stringify(id) ?? "undefined";
    const existing = groups.get(key);

    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { id, rows: [row] });
    }
  }

  const output: Record<string, unknown>[] = [];

  for (const { id, rows: groupRows } of groups.values()) {
    const result: Record<string, unknown> = { _id: id };

    for (const [name, spec] of Object.entries(group.fields ?? {})) {
      result[name] = aggregateField(groupRows, spec);
    }

    output.push(result);
  }

  return output;
}

function aggregateField(rows: Record<string, unknown>[], spec: Agg): unknown {
  const values = rows.map((row) => (spec.field ? getPath(row, spec.field) : 1));

  switch (spec.op) {
    case "count":
      return values.filter((value) => value !== undefined && value !== null).length;
    case "sum":
      return values.reduce<number>(
        (sum, value) => sum + (typeof value === "number" ? value : 0),
        0,
      );
    case "avg": {
      const numbers = values.filter((value): value is number => typeof value === "number");
      return numbers.length === 0
        ? null
        : numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    }
    case "min": {
      const defined = values.filter((value) => value !== undefined && value !== null);
      return defined.length === 0
        ? null
        : defined.reduce((min, value) => (compareForOrder(value, min) < 0 ? value : min));
    }
    case "max": {
      const defined = values.filter((value) => value !== undefined && value !== null);
      return defined.length === 0
        ? null
        : defined.reduce((max, value) => (compareForOrder(value, max) > 0 ? value : max));
    }
  }
}

function applyUnwind(
  rows: Record<string, unknown>[],
  unwind: UnwindSpec,
): Record<string, unknown>[] {
  const path = typeof unwind === "string" ? unwind : unwind.path;
  const preserve =
    typeof unwind === "string" ? false : (unwind.preserveNullAndEmptyArrays ?? false);
  const output: Record<string, unknown>[] = [];

  for (const row of rows) {
    const value = getPath(row, path);

    if (Array.isArray(value)) {
      if (value.length === 0) {
        if (preserve) {
          const copy = clone(row);
          deletePath(copy, path);
          output.push(copy);
        }
      } else {
        for (const item of value) {
          const copy = clone(row);
          setPath(copy, path, clone(item));
          output.push(copy);
        }
      }
    } else if (value === null || value === undefined) {
      if (preserve) output.push(clone(row));
    } else {
      output.push(clone(row));
    }
  }

  return output;
}

function applyLookup(
  rows: Record<string, unknown>[],
  lookup: {
    from: string;
    localField: string;
    foreignField: string;
    as: string;
    pipeline?: NormalizedPipelineStep[];
  },
  store: Map<string, Record<string, unknown>[]>,
): Record<string, unknown>[] {
  const foreign = store.get(lookup.from) ?? [];

  return rows.map((row) => {
    const local = getPath(row, lookup.localField);

    let joined = foreign
      .filter((candidate) => valuesEqual(getPath(candidate, lookup.foreignField), local))
      .map((candidate) => clone(candidate));

    if (lookup.pipeline && lookup.pipeline.length > 0) {
      joined = applyPipeline(joined, lookup.pipeline, store);
    }

    const output = clone(row);
    setPath(output, lookup.as, joined);
    return output;
  });
}
