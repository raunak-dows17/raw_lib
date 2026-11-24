import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import type {
  CompiledWhere,
  NormalizedPipelineStep,
  NormalizedSort,
} from "../core/types/normalized";
import type { Agg, GroupSpec, UnwindSpec } from "../core/types/query";
import { isPlainObject } from "../core/utils";

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export function toMongoField(field: string, idField: string): string {
  if (idField !== "id") return field;
  if (field === "id") return "_id";
  if (field.startsWith("id.")) return `_id${field.slice(2)}`;
  return field;
}

export function toMongoId(value: unknown): unknown {
  if (value instanceof ObjectId) return value;
  if (typeof value === "string" && OBJECT_ID_PATTERN.test(value)) return new ObjectId(value);
  return value;
}

function idValue(field: string, value: unknown): unknown {
  if (field !== "_id") return value;
  if (Array.isArray(value)) return value.map(toMongoId);
  return toMongoId(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function toMongoFilter(
  where: CompiledWhere | undefined,
  idField: string,
): Record<string, unknown> {
  if (!where) return {};

  switch (where.kind) {
    case "and":
      return { $and: where.clauses.map((clause) => toMongoFilter(clause, idField)) };
    case "or":
      return { $or: where.clauses.map((clause) => toMongoFilter(clause, idField)) };
    case "not":
      return { $nor: [toMongoFilter(where.clause, idField)] };
    case "comparison": {
      const field = toMongoField(where.field, idField);
      const value = idValue(field, where.value);
      if (where.op === "eq") return { [field]: value };
      return { [field]: { [`$${where.op}`]: value } };
    }
    case "array": {
      const field = toMongoField(where.field, idField);
      const value = idValue(field, where.value);
      return { [field]: { [where.op === "in" ? "$in" : "$nin"]: value } };
    }
    case "text": {
      const field = toMongoField(where.field, idField);
      const escaped = escapeRegex(where.value);
      const pattern =
        where.op === "contains"
          ? escaped
          : where.op === "startsWith"
            ? `^${escaped}`
            : `${escaped}$`;
      return { [field]: { $regex: pattern, $options: "i" } };
    }
    case "presence": {
      const field = toMongoField(where.field, idField);
      if (where.op === "exists") return { [field]: { $exists: where.value } };
      return { [field]: where.value ? null : { $ne: null } };
    }
  }
}

export function toMongoSort(sort: NormalizedSort, idField: string): Record<string, 1 | -1> {
  const output: Record<string, 1 | -1> = {};
  for (const { field, direction } of sort) {
    output[toMongoField(field, idField)] = direction === "asc" ? 1 : -1;
  }
  return output;
}

export function toMongoProjection(select: string[], idField: string): Record<string, 0 | 1> {
  const projection: Record<string, 0 | 1> = {};

  for (const field of select) {
    projection[toMongoField(field, idField)] = 1;
  }

  if (idField === "id" && projection._id === undefined) {
    projection._id = 0;
  }

  return projection;
}

export function normalizeValue(value: unknown): unknown {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = normalizeValue(item);
    }
    return output;
  }
  return value;
}

export function mapDocument(
  doc: Record<string, unknown>,
  idField: string,
): Record<string, unknown> {
  const output = normalizeValue(doc) as Record<string, unknown>;

  if (idField === "id" && output._id !== undefined && output.id === undefined) {
    output.id = output._id;
    delete output._id;
  }

  return output;
}

export function mapAggregateDocuments(
  docs: Record<string, unknown>[],
  idField: string,
  keepGroupId: boolean,
): Record<string, unknown>[] {
  return docs.map((doc) => {
    const output = normalizeValue(doc) as Record<string, unknown>;

    if (idField === "id") {
      for (const [key, value] of Object.entries(output)) {
        if (Array.isArray(value)) {
          output[key] = value.map((item) =>
            isPlainObject(item) ? mapDocument(item, idField) : item,
          );
        }
      }

      if (!keepGroupId && output._id !== undefined && output.id === undefined) {
        output.id = output._id;
        delete output._id;
      }
    }

    return output;
  });
}

export function prepareDocument(
  data: Record<string, unknown>,
  idField: string,
): Record<string, unknown> {
  const doc = normalizeValue(data) as Record<string, unknown>;

  if (idField === "id") {
    if (doc.id !== undefined && doc.id !== null && doc.id !== "") {
      doc._id = toMongoId(doc.id);
    }
    delete doc.id;
  } else if (idField !== "_id") {
    if (doc[idField] === undefined || doc[idField] === null || doc[idField] === "") {
      doc[idField] = randomUUID();
    }
  }

  return doc;
}

export function preparePatch(
  data: Record<string, unknown>,
  idField: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (key === idField) continue;
    if (idField === "id" && (key === "_id" || key.startsWith("id.") || key.startsWith("_id."))) {
      continue;
    }
    patch[toMongoField(key, idField)] = normalizeValue(value);
  }

  return patch;
}

export function extractId(doc: Record<string, unknown>, idField: string): string | undefined {
  const value = idField === "id" ? doc._id : (doc[idField] ?? doc._id);
  if (value === undefined || value === null) return undefined;
  return String(normalizeValue(value));
}

export function toMongoPipeline(
  pipeline: NormalizedPipelineStep[],
  idField: string,
): Record<string, unknown>[] {
  return pipeline.map((step) => {
    if ("$match" in step) return { $match: toMongoFilter(step.$match, idField) };
    if ("$sort" in step) return { $sort: toMongoSort(step.$sort, idField) };
    if ("$limit" in step) return { $limit: step.$limit };
    if ("$skip" in step) return { $skip: step.$skip };
    if ("$count" in step) return { $count: step.$count };
    if ("$project" in step) return { $project: toMongoProject(step.$project, idField) };
    if ("$addFields" in step) return { $addFields: toMongoFields(step.$addFields, idField) };
    if ("$unwind" in step) return { $unwind: toMongoUnwind(step.$unwind, idField) };
    if ("$group" in step) return { $group: toMongoGroup(step.$group, idField) };
    if ("$lookup" in step) {
      const lookup: Record<string, unknown> = {
        from: step.$lookup.from,
        localField: toMongoField(step.$lookup.localField, idField),
        foreignField: toMongoField(step.$lookup.foreignField, idField),
        as: step.$lookup.as,
      };
      if (step.$lookup.pipeline) {
        lookup.pipeline = toMongoPipeline(step.$lookup.pipeline, idField);
      }
      return { $lookup: lookup };
    }
    return step as unknown as Record<string, unknown>;
  });
}

function toMongoProject(project: Record<string, 0 | 1>, idField: string): Record<string, 0 | 1> {
  const output: Record<string, 0 | 1> = {};
  const inclusion = Object.values(project).some((flag) => flag === 1);

  for (const [key, flag] of Object.entries(project)) {
    output[toMongoField(key, idField)] = flag;
  }

  if (inclusion && idField === "id" && output._id === undefined) {
    output._id = 0;
  }

  return output;
}

function toMongoFields(fields: Record<string, unknown>, idField: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[toMongoField(key, idField)] = value;
  }
  return output;
}

function toMongoUnwind(unwind: UnwindSpec, idField: string): Record<string, unknown> | string {
  if (typeof unwind === "string") return `$${toMongoField(unwind, idField)}`;
  return {
    path: `$${toMongoField(unwind.path, idField)}`,
    ...(unwind.preserveNullAndEmptyArrays !== undefined
      ? { preserveNullAndEmptyArrays: unwind.preserveNullAndEmptyArrays }
      : {}),
  };
}

function toMongoGroup(group: GroupSpec, idField: string): Record<string, unknown> {
  const id =
    typeof group.by === "string"
      ? `$${toMongoField(group.by, idField)}`
      : Object.fromEntries(
          Object.entries(group.by).map(([key, field]) => [key, `$${toMongoField(field, idField)}`]),
        );

  const output: Record<string, unknown> = { _id: id };

  for (const [name, spec] of Object.entries(group.fields ?? {})) {
    output[name] = aggregateExpression(spec, idField);
  }

  return output;
}

function aggregateExpression(spec: Agg, idField: string): unknown {
  if (spec.op === "count") {
    if (!spec.field) return { $sum: 1 };
    const field = `$${toMongoField(spec.field, idField)}`;
    return {
      $sum: {
        $cond: [{ $in: [{ $type: field }, ["missing", "null"]] }, 0, 1],
      },
    };
  }

  const field = `$${toMongoField(spec.field as string, idField)}`;
  return { [`$${spec.op}`]: field };
}
