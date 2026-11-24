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

## 12. Mongo adapter semantics

The Mongo adapter (`raw_lib/mongo`) uses the native `mongodb` driver and connects lazily.

- **ID mapping.** With the default `idField: "id"`, the adapter stores the logical ID in
  Mongo's `_id` and returns `_id` values as `id`. ObjectId values are exposed as hex strings.
  Set `idField: "_id"` to work with raw Mongo documents, or use a custom field for app-owned
  keys. Custom ID fields are generated with `crypto.randomUUID()` when omitted.
- **Updates** use `$set` and never change the ID field.
- **Filters** compile to native operators; `contains`, `startsWith`, and `endsWith` become
  escaped, case-insensitive regular expressions. `$not` becomes `$nor`.
- **Pagination** uses `skip`/`limit`; `page.cursor` and `transactions` are not claimed.
- **Aggregation** supports every neutral pipeline stage. `$group` results keep `_id`; other
  stages expose document IDs as `id` when `idField` is `id`. `$lookup.from` is a collection
  name.
- **Capabilities** include all filter, sort, select, offset-pagination, pipeline, and
  atomic-update features implemented by the adapter.

## 13. RawVal semantics

`raw_lib/val` accepts any Standard Schema v1 implementation and ships a zero-dependency
builder (`v.string`, `v.number`, `v.object`, `v.array`, `v.record`, `v.union`, `v.date`,
`v.literal`, `v.enum`, `v.any`, `v.unknown`).

- Schemas are registered per entity and per operation: `rawval({ users: { create, update } })`.
  Unregistered operations pass through unchanged.
- `create` and `update` validate `data`; `list`, `get`, `delete`, and `count` validate the
  query; `aggregate` validates the pipeline.
- Parsed output replaces `data` for writes, so defaults, coercion, and transforms reach the
  adapter.
- Failures become `VALIDATION_FAILED` with `{ path, message, code }[]` details.
- `v.object` strips unknown keys; `.partial()` makes every field optional; `.extend()` adds
  fields. `.optional()`, `.nullable()`, `.default()`, `.refine()`, and `.transform()` are
  available on every schema.
- `v` schemas expose `~standard.validate`, so they compose with zod, valibot, and arktype
  schemas inside the same configuration.

## 14. RawAuth semantics

`raw_lib/auth` implements password authentication and device-bound sessions over RawQL.

- **Configuration.** `createAuth({ db, secret, entities?, accessTtl?, refreshTtl?, password?,
  fingerprint?, hooks?, clock? })`. `secret` must be at least 16 bytes. Entity names default
  to `users`, `sessions`, and `otps`; point them at your own collections with `entities`.
- **Flows.** `register`, `login.password`, `refresh`, `verify`, `logout`, `logoutAll`,
  `sessions.list`, and `sessions.revoke`. Every flow returns a `Result`; failures use the auth
  error codes from section 8.
- **Access tokens.** Compact HS256 JWTs with `sub`, `sid`, `jti`, `iat`, `exp`, and optional
  `roles`, signed through Web Crypto. Default TTL is 15 minutes.
- **Refresh tokens.** 32 random bytes encoded as base64url. Only the SHA-256 hash is stored on
  the session. Every refresh rotates the token; the previous hashes are retained (default 20)
  so reuse is detectable. Reuse revokes every active session in the token family.
- **Sessions.** Each session records `familyId`, hashed device fingerprint fields, `createdAt`,
  `lastUsedAt`, `expiresAt`, `revokedAt`, `rotation`, and refresh-token expiry. Public session
  objects never include token hashes.
- **Device fingerprinting.** `strict` (default) requires the bound device ID to match, falling
  back to the user agent only when no device ID was bound. `loose` accepts either match. `off`
  disables the check. A session created without a fingerprint is unbound; once bound, missing
  or different devices are rejected. `requireDeviceId` rejects session creation without one.
- **Passwords.** Default `scrypt` with N=2^15, r=8, p=1 and a random salt, using `node:crypto`
  when available and PBKDF2-SHA256 through Web Crypto otherwise. `password.hasher` accepts a
  custom `{ hash, verify }` implementation. Minimum length defaults to 8.
- **Enumeration and timing.** Unknown users and wrong passwords return the same
  `INVALID_CREDENTIALS` error, and unknown users still incur a dummy hash comparison.
- **Hooks.** `onLogin`, `onLoginFailed`, `onSessionRevoked`, and `onRefreshReuse` receive audit
  context. Hook failures are swallowed so they can never change an auth outcome.
- **Limitations.** OTP flows and delivery providers are not implemented yet. The auth layer
  does not create database unique indexes; add them on identifier columns to enforce
  registration uniqueness under concurrency.
