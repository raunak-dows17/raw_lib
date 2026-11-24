# raw_lib v2 — Protocol Specification

> Version: 2.0.0-alpha · Status: draft

## 1. Overview

RawQL defines a typed, database-independent query protocol. An engine validates and normalizes
a `Query`, checks adapter capabilities, and hands a `NormalizedQuery` to an adapter. Adapters
translate that query into their driver. RawVal and RawAuth are layers on top of the same engine.

```
caller → RawQL engine → adapter
            │
            ├─ middleware
            ├─ validation (RawVal)
            ├─ normalization + compilation
            └─ capability checks
```

## 2. Operations

| Operation   | Purpose                  | Required input            |
| ----------- | ------------------------ | ------------------------- |
| `list`      | Return a page of rows    | `entity`                  |
| `get`       | Return one row or `null` | `entity`, `where`         |
| `create`    | Insert one or many rows  | `entity`, `data`          |
| `update`    | Patch matching rows      | `entity`, `where`, `data` |
| `delete`    | Remove matching rows     | `entity`, `where`         |
| `count`     | Count matching rows      | `entity`                  |
| `aggregate` | Run a pipeline           | `entity`, `pipeline`      |

## 3. Query shape

```ts
type Query<T> = {
  op: Op;
  entity: string;
  where?: Where<T>;
  data?: Partial<T> | Partial<T>[];
  sort?: Sort;
  select?: (keyof T & string)[];
  page?: { limit?: number; offset?: number };
  pipeline?: PipelineStep[];
};
```

Rules:

- `where` is required and non-empty for `get`, `update`, and `delete`. This prevents accidental
  mass reads or mutations.
- `pipeline` is only valid for `aggregate`; `aggregate` does not accept `where`, `sort`,
  `select`, or `page`. Use pipeline stages instead.
- `page.limit` defaults to 20 and must be a positive integer no greater than the engine's
  `maxLimit` (default 1000).
- `page.offset` defaults to 0 and must be a non-negative integer.

## 4. Filters

### Shorthand

```ts
where: {
  role: "admin",                     // eq
  age: { gte: 18 },                  // operator object
  email: { endsWith: "@acme.com" },  // text operator
  deletedAt: null,                   // isNull
}
```

### Operators

| Group      | Operators                            |
| ---------- | ------------------------------------ |
| Comparison | `eq`, `ne`, `gt`, `gte`, `lt`, `lte` |
| Array      | `in`, `nin`                          |
| Text       | `contains`, `startsWith`, `endsWith` |
| Presence   | `exists`, `isNull`                   |

Text operators are case-insensitive and their input is escaped. Raw regular expressions are
not part of the protocol.

### Logical operators

```ts
where: {
  $and: [{ role: "admin" }, { age: { gte: 18 } }],
  $or: [{ plan: "pro" }, { plan: "team" }],
  $not: { status: "banned" },
}
```

Field names beginning with `$` are reserved.

## 5. Sorting, selection, pagination

```ts
sort: { createdAt: "desc", id: "asc" }
// or
sort: [{ field: "createdAt", direction: "desc" }]
```

- Sort directions are `asc` and `desc`.
- `select` is a list of top-level fields. If omitted, all fields are returned.
- Pagination uses `limit` + `offset`. The result metadata reports `total` when the adapter can
  provide it and `hasMore` when it can be determined.

## 6. Pipeline subset

```ts
type PipelineStep =
  | { $match: Where<any> }
  | { $group: { by: string | Record<string, string>; fields?: Record<string, Agg> } }
  | { $sort: Sort }
  | { $limit: number }
  | { $skip: number }
  | { $project: Record<string, 0 | 1> }
  | {
      $lookup: {
        from: string;
        localField: string;
        foreignField: string;
        as: string;
        pipeline?: PipelineStep[];
      };
    }
  | { $unwind: string | { path: string; preserveNullAndEmptyArrays?: boolean } }
  | { $addFields: Record<string, unknown> }
  | { $count: string };

type Agg = { op: "count" | "sum" | "avg" | "min" | "max"; field?: string };
```

Every stage is capability-gated. An adapter that cannot run a stage returns
`UNSUPPORTED_CAPABILITY` before execution.

## 7. Results

```ts
type Result<T> =
  | { ok: true; data: T; meta?: Meta }
  | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };
```

- `list` → `T[]`, pagination in `meta.page`.
- `get` → `T | null`.
- `create` → `T` or `T[]` for bulk inserts.
- `update` / `delete` → `{ id: string | null }`; no match returns `NOT_FOUND`.
- `count` → `number`.
- `aggregate` → `T[]`.

## 8. Error codes

`VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`,
`UNSUPPORTED_CAPABILITY`, `ADAPTER_ERROR`, `TIMEOUT`, `INTERNAL_ERROR`, plus auth codes:
`INVALID_CREDENTIALS`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `SESSION_REVOKED`,
`FINGERPRINT_MISMATCH`, `OTP_EXPIRED`, `OTP_INVALID`, `OTP_ATTEMPTS_EXCEEDED`,
`OTP_ALREADY_USED`.

## 9. Adapters

```ts
interface Adapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  execute<T>(query: NormalizedQuery): Promise<AdapterResult<T>>;
  connect?(): Promise<void>;
  close?(): Promise<void>;
}
```

Adapters must pass the shared contract suite. A new adapter is correct when it passes that suite
plus its driver-specific integration tests.

## 10. Middleware and validation order

1. Structural validation of the query.
2. Middleware runs on the raw query and may mutate it or abort with a `RawLibError`.
3. RawVal validates the final query/data and may replace `data` with parsed output.
4. Normalization compiles filters, sort, pagination, and pipeline.
5. Capability checks.
6. Adapter execution.
7. Result mapping.

## 11. Memory adapter semantics

- Missing IDs are generated with `crypto.randomUUID()`.
- `update` performs a shallow merge and never changes the ID field.
- Nulls sort last.
- Text matching is case-insensitive.
- `$group` emits `{ _id, ...fields }`.
- `$count` emits `[{ [name]: count }]`.
