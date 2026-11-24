# raw_lib v2

Modular, adapter-driven query, validation, and authentication toolkit for Node.js.

> Status: **2.0.0-alpha** — the core engine and Mongo adapter are implemented; validation
> and auth land in the next phases. v1 remains available on `main` and npm.

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
| RawVal                               | Next        |
| RawAuth                              | Next        |
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
