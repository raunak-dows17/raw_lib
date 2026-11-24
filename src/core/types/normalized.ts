import type { ResolvedEntity } from "./entity";
import type { GroupSpec, LookupSpec, Op, SortDirection, UnwindSpec } from "./query";

export type CompiledWhere =
  | {
      kind: "comparison";
      field: string;
      op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      value: unknown;
    }
  | { kind: "array"; field: string; op: "in" | "nin"; value: unknown[] }
  | { kind: "text"; field: string; op: "contains" | "startsWith" | "endsWith"; value: string }
  | { kind: "presence"; field: string; op: "exists" | "isNull"; value: boolean }
  | { kind: "and"; clauses: CompiledWhere[] }
  | { kind: "or"; clauses: CompiledWhere[] }
  | { kind: "not"; clause: CompiledWhere };

export type NormalizedSort = { field: string; direction: SortDirection }[];

export type NormalizedLookupSpec = Omit<LookupSpec, "pipeline"> & {
  pipeline?: NormalizedPipelineStep[];
};

export type NormalizedPipelineStep =
  | { $match: CompiledWhere }
  | { $group: GroupSpec }
  | { $sort: NormalizedSort }
  | { $limit: number }
  | { $skip: number }
  | { $project: Record<string, 0 | 1> }
  | { $lookup: NormalizedLookupSpec }
  | { $unwind: UnwindSpec }
  | { $addFields: Record<string, unknown> }
  | { $count: string };

export type NormalizedQuery = {
  op: Op;
  entity: ResolvedEntity;
  where?: CompiledWhere;
  data?: unknown;
  sort?: NormalizedSort;
  select?: string[];
  page?: { limit: number; offset: number };
  pipeline?: NormalizedPipelineStep[];
};
