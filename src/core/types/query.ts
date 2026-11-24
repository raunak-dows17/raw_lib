export type Op = "list" | "get" | "create" | "update" | "delete" | "count" | "aggregate";

export type SortDirection = "asc" | "desc";

export type Sort = Record<string, SortDirection> | { field: string; direction: SortDirection }[];

export type ComparisonOperator<V> =
  | { eq: V }
  | { ne: V }
  | { gt: V }
  | { gte: V }
  | { lt: V }
  | { lte: V };

export type ArrayOperator<V> = { in: V[] } | { nin: V[] };

export type TextOperator = { contains: string } | { startsWith: string } | { endsWith: string };

export type PresenceOperator = { exists: boolean } | { isNull: boolean };

export type Operator<V> =
  | ComparisonOperator<V>
  | ArrayOperator<V>
  | TextOperator
  | PresenceOperator;

export type Where<T = Record<string, unknown>> = {
  [K in keyof T]?: T[K] | Operator<T[K]>;
} & {
  $and?: Where<T>[];
  $or?: Where<T>[];
  $not?: Where<T>;
};

export type Page = { limit?: number; offset?: number };

export type Agg = { op: "count" | "sum" | "avg" | "min" | "max"; field?: string };

export type GroupSpec = {
  by: string | Record<string, string>;
  fields?: Record<string, Agg>;
};

export type LookupSpec = {
  from: string;
  localField: string;
  foreignField: string;
  as: string;
  pipeline?: PipelineStep[];
};

export type UnwindSpec = string | { path: string; preserveNullAndEmptyArrays?: boolean };

export type PipelineStep =
  | { $match: Where<any> }
  | { $group: GroupSpec }
  | { $sort: Sort }
  | { $limit: number }
  | { $skip: number }
  | { $project: Record<string, 0 | 1> }
  | { $lookup: LookupSpec }
  | { $unwind: UnwindSpec }
  | { $addFields: Record<string, unknown> }
  | { $count: string };

export type Query<T = Record<string, unknown>> = {
  op: Op;
  entity: string;
  where?: Where<T>;
  data?: Partial<T> | Partial<T>[];
  sort?: Sort;
  select?: (keyof T & string)[];
  page?: Page;
  pipeline?: PipelineStep[];
};
