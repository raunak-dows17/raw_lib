export type RawQlOperation =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "count"
  | "aggregate";

export type RawQlRequest = {
  id?: string;
  type: RawQlOperation;
  entity: string;
  data?: Record<string, any>;
  filter?: RawQlFilter;
  options?: RawQlOptions;
  pipeline?: RawQlPipelineStep[];
};

export type FilterOperations =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "search"
  | "startsWith"
  | "endsWith";

export type RawQlFilter =
  | {
      field: string;
      op: FilterOperations;
      value: any;
    }
  | {
      and?: RawQlFilter[];
      or?: RawQlFilter[];
      not?: RawQlFilter;
    };

export type RawQlOptions = {
  sort?: { field: string; direction: "asc" | "desc" }[];
  limit?: number | 10;
  skip?: number;
  page?: number | 1;
  select?: string[];
  populate?: RawQlPopulate;
};

export type RawQlPopulate = {
  field: string,
  select?: string[];
  populate?: RawQlPopulate[];
}

export type RawQlPipelineStep =
  | { match: RawQlFilter }
  | { group: RawQlGroup }
  | { sort: { field: string; direction: "asc" | "desc" }[] }
  | { limit: number | 10 }
  | { skip: number }
  | { project: { [field: string]: 0 | 1 } };

export interface RawQlGroup {
  _id: string | Record<string, string>;
  fields: Record<string, RawQlAggreateField>;
}

export interface RawQlAggreateField {
  op: "count" | "sum" | "avg" | "min" | "max";
  field?: string[];
}
