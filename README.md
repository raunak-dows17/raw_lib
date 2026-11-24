# raw_lib v2

Modular, adapter-driven query, validation, and authentication toolkit for Node.js.

> Status: **2.0.0** — the core engine, Mongo adapter, validation, password and OTP auth,
> examples, and migration guide are complete. v1 remains available on `main` and npm.

See [`MIGRATION.md`](MIGRATION.md) if you are upgrading from 1.x, [`CHANGELOG.md`](CHANGELOG.md)
for the release notes, and [`examples`](examples) for Express, Fastify, and Hono servers.

## What it is

`raw_lib` gives you one typed protocol for data access and builds the rest of a backend on top:

- **RawQL** — typed queries (`list`, `get`, `create`, `update`, `delete`, `count`, `aggregate`)
  over swappable adapters.
- **RawVal** — operation-level validation plugged into RawQL.
- **RawAuth** — password/OTP auth, device sessions, and access/refresh tokens built on RawQL.

Core has no runtime dependencies. Database drivers, validators, and OTP providers are
optional integrations behind subpath imports.

## Quick start

```ts
import { createRawQl, MemoryAdapter } from "raw_lib";

const db = createRawQl({
  adapter: new MemoryAdapter({
    seed: {
      users: [
        { id: "u_1", name: "Ada", role: "admin", age: 36 },
        { id: "u_2", name: "Linus", role: "member", age: 54 },
      ],
    },
  }),
});

const result = await db.execute({
  op: "list",
  entity: "users",
  where: { role: "admin", age: { gte: 18 } },
  sort: { age: "desc" },
  page: { limit: 20 },
});

if (result.ok) {
  console.log(result.data);
}
```

Typed entity helpers use the same protocol:

```ts
const users = db.entity<{ id: string; name: string; role: string; age: number }>("users");

const page = await users.list({ where: { role: "admin" }, page: { limit: 10 } });
const one = await users.get({ id: "u_1" });
```

## MongoDB

The Mongo adapter lives behind `raw_lib/mongo` and uses the native driver. Install `mongodb`
as a peer dependency:

```bash
npm install mongodb
```

```ts
import { createRawQl } from "raw_lib";
import { mongo } from "raw_lib/mongo";

const db = createRawQl({
  adapter: mongo({
    uri: process.env.MONGO_URL!,
    dbName: "app",
  }),
  entities: {
    users: { collection: "users" },
  },
});

const users = db.entity<{ id: string; email: string }>("users");
const result = await users.list({ where: { email: { endsWith: "@acme.com" } } });
```

With the default `idField: "id"`, the adapter maps `id` to Mongo's `_id` and exposes
ObjectIds as strings, so the same entity code works against the memory adapter. Use
`idField: "_id"` to work with raw Mongo documents, or a custom `idField` for your own key.
Connections are opened lazily; call `db.close()` to release them.

## Validation

`raw_lib/val` plugs any [Standard Schema](https://standardschema.dev) implementation — zod,
valibot, arktype — into the query engine, and ships a small zero-dependency builder:

```ts
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
      update: v.object({ name: v.string(), age: v.number().int().min(18) }).partial(),
    },
  }),
});
```

Or reuse an existing schema library:

```ts
import { z } from "zod";

const db = createRawQl({
  adapter,
  validate: rawval({
    users: { create: z.object({ email: z.string().email() }) },
  }),
});
```

`create`/`update` validate `data`; reads validate the query; `aggregate` validates the
pipeline. Parsed output replaces `data` before it reaches the adapter. Failures return
`VALIDATION_FAILED` with `{ path, message, code }` details.

## Authentication

`raw_lib/auth` builds password auth, device-bound sessions, and access/refresh tokens on top of
RawQL, so users and sessions live in whichever adapter you already use:

```ts
import { createRawQl } from "raw_lib";
import { createAuth } from "raw_lib/auth";

const db = createRawQl({
  adapter,
  entities: {
    users: { collection: "users" },
    sessions: { collection: "sessions" },
    otps: { collection: "otps" },
  },
});

const auth = createAuth({
  db,
  secret: process.env.AUTH_SECRET!, // at least 16 bytes
  accessTtl: "15m",
  refreshTtl: "30d",
  fingerprint: { policy: "strict" },
});

const device = { deviceId: "install-id", userAgent: request.headers["user-agent"] };

const registered = await auth.register({ email, password, device });
if (!registered.ok) throw new Error(registered.error.message);

const { accessToken, refreshToken } = registered.data;
const session = await auth.verify({ accessToken, device });
const rotated = await auth.refresh({ refreshToken, device });
await auth.logout({ refreshToken });
```

- Access tokens are HS256 JWTs signed with Web Crypto, so the token layer is edge-safe and
  dependency-free.
- Refresh tokens are opaque 32-byte values stored only as SHA-256 hashes and rotated on every
  use. Reusing a rotated token revokes the whole session family.
- Sessions bind to a hashed device fingerprint. `strict` (default) requires the bound device;
  `loose` accepts a matching device ID or user agent; `off` is an explicit opt-out. Missing
  fingerprints never fail open once a session is bound.
- Passwords use `scrypt` (N=2^15) through `node:crypto`, with a PBKDF2 Web Crypto fallback and a
  pluggable `PasswordHasher` for bcrypt or argon2.
- `auth.sessions.list`, `auth.sessions.revoke`, `auth.logoutAll`, and hooks such as
  `onLoginFailed` and `onSessionRevoked` cover session administration and auditing.

### OTP login

```ts
import { createAuth, otpRouter, sendgrid, twilio } from "raw_lib/auth";

const auth = createAuth({
  db,
  secret: process.env.AUTH_SECRET!,
  otp: {
    ttl: "5m",
    maxAttempts: 5,
    provider: otpRouter({
      sms: twilio({
        accountSid: process.env.TWILIO_SID!,
        authToken: process.env.TWILIO_TOKEN!,
        from: process.env.TWILIO_FROM!,
      }),
      email: sendgrid({ apiKey: process.env.SENDGRID_KEY!, from: "noreply@acme.com" }),
    }),
  },
});

const requested = await auth.login.otp.request({ contact: "ada@acme.com" });
if (!requested.ok) throw new Error(requested.error.message);

const login = await auth.login.otp.verify({
  otpId: requested.data.otpId,
  code: submittedCode,
  device,
});
```

Codes are numeric, generated with Web Crypto, stored as salted HMAC-SHA256 digests, and
consumed exactly once. Requests are throttled per contact, attempts are capped, and unknown
contacts receive the same response shape without a message being sent. Both providers use
`fetch`, so they work on Node 18+, edge runtimes, and with injected test doubles.

## Examples

[`examples`](examples) contains the same API — register, login, refresh, logout, `/me`, and a
users list — built with Express, Fastify, and Hono. Each runs on the memory adapter with no
external services:

```bash
cd examples/hono
npm install
npm run dev
```

Swap `MemoryAdapter` for `mongo()` from `raw_lib/mongo` to persist data; application code stays
the same.

## Design rules

- Adapters receive a normalized query, never the raw request.
- Unknown operators and unsupported capabilities are typed errors, not silent behavior.
- Writes require a non-empty `where` unless creating.
- Every result is a discriminated union: `{ ok: true, data }` or `{ ok: false, error }`.

## Status

| Module                               | State       |
| ------------------------------------ | ----------- |
| Core engine + memory adapter         | Implemented |
| Mongo adapter                        | Implemented |
| RawVal                               | Implemented |
| RawAuth                              | Implemented |
| OTP + delivery providers             | Implemented |
| Packaging, docs, examples, 2.0.0     | Implemented |
| Agentic data layer (`raw_lib/agent`) | Post-2.0.0  |

See [`docs/spec.md`](docs/spec.md) for the protocol and [`docs/adr`](docs/adr) for design decisions.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Requires Node 18+ at runtime. The build and test toolchain requires Node 22.12+.

## License

MIT © Raunak Pandey
