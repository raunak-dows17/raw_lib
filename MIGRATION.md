# Migrating from raw_lib 1.x to 2.0

`raw_lib` 2.0 is a rewrite of the 1.x engines. The product goal is the same — a
framework- and database-agnostic query, validation, and authentication toolkit — but the
protocol, result shape, and security model changed. This guide maps every 1.x API to its 2.0
equivalent.

The complete 1.x source remains on the `main` branch and the annotated `v1-final` tag. 2.0
lives on `v2` and ships as `raw_lib@2`.

## Requirements and install

```bash
npm install raw_lib
npm install mongodb   # only when using raw_lib/mongo
```

- Node.js 18+ for the runtime. The build and test toolchain targets Node 22+.
- ESM and CommonJS are both supported.
- Core has no runtime dependencies. Mongo, validation libraries, and OTP providers are
  optional.
- Subpath imports:

| Import          | Contents                                                       |
| --------------- | -------------------------------------------------------------- |
| `raw_lib`       | Core engine, memory adapter, compiler, errors, types           |
| `raw_lib/mongo` | Native MongoDB adapter                                         |
| `raw_lib/val`   | Standard Schema bridge and built-in `v` builder                |
| `raw_lib/auth`  | Password/OTP auth, tokens, sessions, Twilio/SendGrid providers |

## Import map

| 1.x                                                               | 2.0                                         |
| ----------------------------------------------------------------- | ------------------------------------------- |
| `import { RawQlEngine } from "raw_lib"`                           | `import { createRawQl } from "raw_lib"`     |
| `import MongoAdapter from "raw_lib/rawql/adapters/mongo_adapter"` | `import { mongo } from "raw_lib/mongo"`     |
| `import { RawValEngine } from "raw_lib"`                          | `import { rawval, v } from "raw_lib/val"`   |
| `import { RawAuthEngine } from "raw_lib"`                         | `import { createAuth } from "raw_lib/auth"` |
| `raw_lib/rawql/*`, `raw_lib/rawval/*`, `raw_lib/rawauth/*`        | Removed; use the four subpaths above        |

## RawQL

### Engine and adapter

```ts
// 1.x
import { RawQlEngine } from "raw_lib";
import MongoAdapter from "raw_lib/rawql/adapters/mongo_adapter";

const adapter = new MongoAdapter("mongodb://localhost/app");
adapter.registerModel("users", userSchema);
const engine = new RawQlEngine(adapter);
```

```ts
// 2.0
import { createRawQl } from "raw_lib";
import { mongo } from "raw_lib/mongo";

const db = createRawQl({
  adapter: mongo({ uri: "mongodb://localhost/app", dbName: "app" }),
  entities: {
    users: { collection: "users" },
  },
});
```

The Mongo adapter uses the native `mongodb` driver, not Mongoose. `registerModel` is gone;
declare entity-to-collection mappings in `entities` instead. Adapters receive a normalized
query and never the raw request.

### Request shape

```ts
// 1.x
const response = await engine.execute({
  type: "list",
  entity: "users",
  filter: { field: "role", op: "eq", value: "admin" },
  options: {
    sort: [{ field: "createdAt", direction: "desc" }],
    page: 2,
    limit: 10,
    select: ["id", "email"],
  },
});
```

```ts
// 2.0
const result = await db.execute({
  op: "list",
  entity: "users",
  where: { role: "admin" },
  sort: { createdAt: "desc" },
  page: { limit: 10, offset: 10 },
  select: ["id", "email"],
});
```

| 1.x                                  | 2.0                                                             |
| ------------------------------------ | --------------------------------------------------------------- |
| `type`                               | `op`                                                            |
| `filter: { field, op, value }`       | `where: { [field]: { [op]: value } }`                           |
| `filter: { field, op: "eq", value }` | `where: { [field]: value }`                                     |
| `filter: { op: "search" }`           | `where: { [field]: { contains: "..." } }`                       |
| `filter: { and, or, not }`           | `where: { $and, $or, $not }`                                    |
| `options.sort` array                 | `sort` object or `{ field, direction }[]`                       |
| `options.page` + `options.limit`     | `page: { limit, offset }`                                       |
| `options.skip`                       | `page.offset`                                                   |
| `options.select`                     | `select`                                                        |
| `options.populate`                   | Removed; use `$lookup` in `aggregate` or query related entities |

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `contains`, `startsWith`,
`endsWith`, `exists`, `isNull`. Raw regex and unknown operators are rejected.

### Response shape

1.x returned `{ status, message, data }` with a `data.type` discriminator. 2.0 returns a
discriminated result:

```ts
const result = await db.execute<User[]>({ op: "list", entity: "users" });

if (result.ok) {
  result.data; // User[]
  result.meta?.page; // { limit, offset, hasMore, total? }
} else {
  result.error.code; // "VALIDATION_FAILED" | "NOT_FOUND" | ...
  result.error.message;
}
```

There is no `message` on success and no `data.type`. Single-document operations return the
document (or `null` for `get`), list operations return arrays, and counts return numbers.

### Typed entity sugar

New in 2.0:

```ts
const users = db.entity<User>("users");

await users.list({ where: { role: "admin" } });
await users.get({ id: "u_1" });
await users.create({ data: { email: "ada@acme.com" } });
await users.update({ id: "u_1", data: { role: "member" } });
await users.delete({ id: "u_1" });
```

### Writes

`update` and `delete` require a non-empty `where` (or an entity-sugar `id`). 1.x allowed broad
mutations; 2.0 blocks mass mutations by default. `create` accepts one object or an array.

### Aggregation

Pipeline keys are neutral `$` stages: `$match`, `$group`, `$sort`, `$limit`, `$skip`,
`$project`, `$lookup`, `$unwind`, `$addFields`, `$count`. `$group` uses `{ by, fields }`:

```ts
await db.execute({
  op: "aggregate",
  entity: "orders",
  pipeline: [
    { $match: { status: "paid" } },
    { $group: { by: "customerId", fields: { total: { op: "sum", field: "amount" } } } },
    { $sort: { total: "desc" } },
    { $limit: 10 },
  ],
});
```

`graphLookup` and `facet` are not implemented in 2.0.

## RawVal

1.x registered plain field maps:

```ts
// 1.x
const val = new RawValEngine();
val.register("users", {
  create: {
    email: z.string().email(),
    password: z.string().min(8),
  },
});
```

2.0 accepts any Standard Schema object and plugs into the engine:

```ts
// 2.0 — existing validator
import { z } from "zod";
import { rawval } from "raw_lib/val";

const db = createRawQl({
  adapter,
  validate: rawval({
    users: {
      create: z.object({ email: z.string().email(), password: z.string().min(8) }),
      update: z.object({ email: z.string().email() }).partial(),
    },
  }),
});
```

```ts
// 2.0 — zero-dependency builder
import { rawval, v } from "raw_lib/val";

const db = createRawQl({
  adapter,
  validate: rawval({
    users: {
      create: v.object({
        email: v.string().email(),
        age: v.number().int().min(18),
        role: v.string().default("member"),
      }),
    },
  }),
});
```

| 1.x                                                    | 2.0                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `new RawValEngine()`                                   | `rawval({ entity: { op: schema } })`                         |
| `val.register("users", { create: { field: schema } })` | `rawval({ users: { create: v.object({ field: schema }) } })` |
| Custom `{ validate }` schemas                          | Any Standard Schema (`~standard.validate`)                   |
| `{ valid, errors }`                                    | `VALIDATION_FAILED` with `{ path, message, code }[]`         |

Validation runs after middleware and before normalization. Parsed output replaces `data` for
writes, so defaults, coercion, and transforms reach the adapter.

## RawAuth

### Configuration

```ts
// 1.x
const auth = new RawAuthEngine({
  rawql,
  jwtSecret: process.env.JWT_SECRET,
  jwtTtlSeconds: 900,
  bcryptRounds: 12,
  otpTtlSeconds: 300,
  otpMaxAttempts: 5,
});
```

```ts
// 2.0
import { createAuth, otpRouter, sendgrid, twilio } from "raw_lib/auth";

const auth = createAuth({
  db,
  secret: process.env.AUTH_SECRET!, // at least 16 bytes
  accessTtl: "15m",
  refreshTtl: "30d",
  fingerprint: { policy: "strict" },
  password: { minLength: 8 }, // default scrypt hasher
  otp: {
    ttl: "5m",
    maxAttempts: 5,
    provider: otpRouter({
      sms: twilio({ accountSid, authToken, from }),
      email: sendgrid({ apiKey, from: "noreply@acme.com" }),
    }),
  },
});
```

| 1.x                     | 2.0                                             |
| ----------------------- | ----------------------------------------------- |
| `rawql`                 | `db`                                            |
| `jwtSecret`             | `secret`                                        |
| `jwtTtlSeconds: 900`    | `accessTtl: "15m"` (numbers are milliseconds)   |
| `bcryptRounds`          | Removed; default `scrypt`, or `password.hasher` |
| `otpTtlSeconds: 300`    | `otp.ttl: "5m"` (numbers are milliseconds)      |
| `otpMaxAttempts`        | `otp.maxAttempts`                               |
| Twilio/SendGrid classes | `twilio()`, `sendgrid()`, `otpRouter()`         |

### Flows

| 1.x                                                        | 2.0                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `loginWithPassword({ identifier, password, fingerprint })` | `login.password({ identifier, password, device })`    |
| `sendOtp(contact, revealCode?)`                            | `login.otp.request({ contact, purpose?, channel? })`  |
| `verifyOtp(otpId, code)`                                   | `login.otp.verify({ otpId, code, device? })`          |
| `passwordLessLogin(...)`                                   | `login.otp.request` then `login.otp.verify`           |
| `verifyToken(token, fingerprint)`                          | `verify({ accessToken, device })`                     |
| `logout(sessionId)`                                        | `logout({ sessionId })` or `logout({ refreshToken })` |
| `listSessions(userId)`                                     | `sessions.list({ userId })`                           |
| `revokeSession(sessionId)`                                 | `sessions.revoke({ sessionId })`                      |
| —                                                          | `logoutAll({ userId })`                               |
| —                                                          | `refresh({ refreshToken, device })`                   |

`fingerprint` and `device` share the shape `{ deviceId?, userAgent?, ip? }`.

`revealCode` is removed. Codes are never returned from the API; use an injected provider in
tests instead.

### Results

1.x returned `{ status, message, data }`. 2.0 returns `Result<T>`:

```ts
const login = await auth.login.password({ identifier, password, device });

if (!login.ok) {
  login.error.code; // INVALID_CREDENTIALS | FINGERPRINT_MISMATCH | RATE_LIMITED | ...
} else {
  login.data.accessToken;
  login.data.refreshToken;
  login.data.accessExpiresAt;
  login.data.user;
  login.data.session;
}
```

### Tokens and sessions

- 1.x issued one JWT. 2.0 issues a short-lived access JWT **and** an opaque refresh token.
- Refresh tokens rotate on every use. Reusing an old token revokes the session family.
- Sessions store `familyId`, `rotation`, refresh-token hashes, and hashed device fingerprints.
- Session/user documents expose `id` instead of `_id` by default. Set `idField: "_id"` on an
  entity to keep raw Mongo documents.
- The default password hasher is `scrypt`; bcrypt/argon2 can be supplied as a custom
  `PasswordHasher`.
- OTP login requires an existing user in 2.0. There is no auto-registration path.

## Errors

1.x returned or threw string messages. 2.0 has typed codes:

```
VALIDATION_FAILED, NOT_FOUND, CONFLICT, UNAUTHORIZED, FORBIDDEN, RATE_LIMITED,
UNSUPPORTED_CAPABILITY, ADAPTER_ERROR, TIMEOUT, INTERNAL_ERROR,
INVALID_CREDENTIALS, TOKEN_EXPIRED, TOKEN_INVALID, SESSION_REVOKED,
FINGERPRINT_MISMATCH, OTP_EXPIRED, OTP_INVALID, OTP_ATTEMPTS_EXCEEDED, OTP_ALREADY_USED
```

Engine and auth operations return errors as values. Direct helpers such as `compileWhere`,
`verifyAccessToken`, and `Schema.parse` throw `RawLibError` with the same `code`.

## Adapters

| 1.x              | 2.0                             |
| ---------------- | ------------------------------- |
| Mongo (Mongoose) | `raw_lib/mongo` (native driver) |
| SQL (stub)       | Not in 2.0                      |
| Redis (stub)     | Not in 2.0                      |
| Mock adapter     | `MemoryAdapter` in `raw_lib`    |

Adapters implement:

```ts
interface Adapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;
  execute<T>(query: NormalizedQuery): Promise<AdapterResult<T>>;
  connect?(): Promise<void>;
  close?(): Promise<void>;
}
```

Every adapter must pass the shared contract suite in `tests/contract`.

## Breaking changes checklist

- [ ] Replace `RawQlEngine` with `createRawQl`.
- [ ] Replace Mongoose `MongoAdapter`/`registerModel` with `mongo()` and `entities`.
- [ ] Rename `type` → `op`, `filter` → `where`, `options` → `sort`/`page`/`select`.
- [ ] Convert `filter` tuples to object operators; `search` becomes `contains`.
- [ ] Replace `status`/`message`/`data.type` handling with the `Result` union.
- [ ] Wrap validation field maps in `v.object(...)` or a zod/valibot object.
- [ ] Rename `RawAuthEngine` flows and configuration keys.
- [ ] Convert JWT/OTP TTL seconds to durations or milliseconds.
- [ ] Store the new refresh token and call `refresh` before the access token expires.
- [ ] Add `where` clauses to every update and delete.
- [ ] Update error handling to switch on `error.code`.
- [ ] Install `mongodb` when using the Mongo adapter.
