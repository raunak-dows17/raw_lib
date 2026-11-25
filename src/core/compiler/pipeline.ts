import { RawLibError } from "../errors";
import type {
  NormalizedLookupSpec,
  NormalizedPipelineStep,
  NormalizedSort,
} from "../types/normalized";
import type { GroupSpec, PipelineStep, Sort, UnwindSpec } from "../types/query";
import { isPlainObject } from "../utils";
import { compileSort } from "./sort";
import { compileWhere } from "./where";

export function compilePipeline(pipeline?: PipelineStep[]): NormalizedPipelineStep[] | undefined {
  if (pipeline === undefined) return undefined;
  if (!Array.isArray(pipeline)) {
    throw new RawLibError("VALIDATION_FAILED", "`pipeline` must be an array");
  }
  return pipeline.map((step) => compileStep(step));
}

function compileStep(step: PipelineStep): NormalizedPipelineStep {
  if (!isPlainObject(step)) {
    throw new RawLibError("VALIDATION_FAILED", "Pipeline steps must be objects");
  }

  const keys = Object.keys(step);
  if (keys.length !== 1) {
    throw new RawLibError(
      "VALIDATION_FAILED",
      "Each pipeline step must have exactly one stage key",
    );
  }

  const key = keys[0] as string;
  const value: unknown = (step as Record<string, unknown>)[key];

  switch (key) {
    case "$match": {
      const where = compileWhere(value as any);
      if (!where) {
        throw new RawLibError("VALIDATION_FAILED", "`$match` requires a non-empty filter");
      }
      return { $match: where };
    }
    case "$group":
      return { $group: validateGroup(value) };
    case "$sort": {
      const sort = compileSort(value as Sort);
      if (!sort) {
        throw new RawLibError("VALIDATION_FAILED", "`$sort` requires at least one field");
      }
      return { $sort: sort as NormalizedSort };
    }
    case "$limit":
      return { $limit: validatePositiveInteger(value, "$limit") };
    case "$skip":
      return { $skip: validateNonNegativeInteger(value, "$skip") };
    case "$project":
      return { $project: validateProject(value) };
    case "$lookup":
      return { $lookup: validateLookup(value) };
    case "$unwind":
      return { $unwind: validateUnwind(value) };
    case "$addFields":
      return { $addFields: validateRecord(value, "$addFields") };
    case "$count": {
      if (typeof value !== "string" || value.length === 0) {
        throw new RawLibError("VALIDATION_FAILED", "`$count` requires a non-empty string");
      }
      return { $count: value };
    }
    default:
      throw new RawLibError("VALIDATION_FAILED", `Unsupported pipeline stage: ${key}`);
  }
}

function validateGroup(value: unknown): GroupSpec {
  const group = validateRecord(value, "$group");
  const by = group.by;

  if (typeof by === "string") {
    if (by.length === 0) {
      throw new RawLibError("VALIDATION_FAILED", "`$group.by` must be a non-empty string");
    }
  } else if (isPlainObject(by)) {
    for (const [key, field] of Object.entries(by)) {
      if (typeof field !== "string" || field.length === 0) {
        throw new RawLibError(
          "VALIDATION_FAILED",
          `\`$group.by.${key}\` must be a non-empty string`,
        );
      }
    }
  } else {
    throw new RawLibError("VALIDATION_FAILED", "`$group.by` must be a string or an object");
  }

  if (group.fields !== undefined) {
    if (!isPlainObject(group.fields)) {
      throw new RawLibError("VALIDATION_FAILED", "`$group.fields` must be an object");
    }
    for (const [name, spec] of Object.entries(group.fields)) {
      if (!isPlainObject(spec)) {
        throw new RawLibError("VALIDATION_FAILED", `\`$group.fields.${name}\` must be an object`);
      }
      const op = spec.op;
      if (op !== "count" && op !== "sum" && op !== "avg" && op !== "min" && op !== "max") {
        throw new RawLibError(
          "VALIDATION_FAILED",
          `Unsupported group operator for \`${name}\`: ${String(op)}`,
        );
      }
      if (op !== "count" && (typeof spec.field !== "string" || spec.field.length === 0)) {
        throw new RawLibError(
          "VALIDATION_FAILED",
          `\`$group.fields.${name}\` requires a field for \`${op}\``,
        );
      }
    }
  }

  return group as GroupSpec;
}

function validateLookup(value: unknown): NormalizedLookupSpec {
  const lookup = validateRecord(value, "$lookup");

  for (const key of ["from", "localField", "foreignField", "as"]) {
    if (typeof lookup[key] !== "string" || (lookup[key] as string).length === 0) {
      throw new RawLibError("VALIDATION_FAILED", `\`$lookup.${key}\` must be a non-empty string`);
    }
  }

  const normalized: NormalizedLookupSpec = {
    from: lookup.from as string,
    localField: lookup.localField as string,
    foreignField: lookup.foreignField as string,
    as: lookup.as as string,
  };

  if (lookup.pipeline !== undefined) {
    const nested = compilePipeline(lookup.pipeline as PipelineStep[]);
    if (nested) normalized.pipeline = nested;
  }

  return normalized;
}

function validateUnwind(value: unknown): UnwindSpec {
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new RawLibError("VALIDATION_FAILED", "`$unwind` requires a non-empty path");
    }
    return value;
  }

  if (!isPlainObject(value)) {
    throw new RawLibError("VALIDATION_FAILED", "`$unwind` must be a string or an object");
  }

  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new RawLibError("VALIDATION_FAILED", "`$unwind.path` must be a non-empty string");
  }

  if (
    value.preserveNullAndEmptyArrays !== undefined &&
    typeof value.preserveNullAndEmptyArrays !== "boolean"
  ) {
    throw new RawLibError(
      "VALIDATION_FAILED",
      "`$unwind.preserveNullAndEmptyArrays` must be a boolean",
    );
  }

  return {
    path: value.path,
    ...(value.preserveNullAndEmptyArrays !== undefined
      ? { preserveNullAndEmptyArrays: value.preserveNullAndEmptyArrays }
      : {}),
  };
}

function validateProject(value: unknown): Record<string, 0 | 1> {
  const project = validateRecord(value, "$project");
  const normalized: Record<string, 0 | 1> = {};

  for (const [key, flag] of Object.entries(project)) {
    if (flag !== 0 && flag !== 1) {
      throw new RawLibError("VALIDATION_FAILED", `\`$project.${key}\` must be 0 or 1`);
    }
    normalized[key] = flag;
  }

  return normalized;
}

function validateRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new RawLibError("VALIDATION_FAILED", `\`${name}\` must be an object`);
  }
  return value;
}

function validatePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RawLibError("VALIDATION_FAILED", `\`${name}\` must be a positive integer`);
  }
  return value;
}

function validateNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RawLibError("VALIDATION_FAILED", `\`${name}\` must be a non-negative integer`);
  }
  return value;
}
