# ADR-0001: Single package with subpath exports

## Status

Accepted.

## Context

The v1 package made Mongoose, bcrypt, JWT, Twilio, and SendGrid mandatory dependencies. That
contradicted the "use only what you need" promise and made edge runtimes impossible. A monorepo
would isolate dependencies but adds release and versioning overhead for a solo project.

## Decision

Ship a single `raw_lib` package with subpath exports:

```
raw_lib          core (zero runtime dependencies)
raw_lib/mongo    native MongoDB adapter
raw_lib/val      validation
raw_lib/auth     authentication
raw_lib/auth/*   OTP providers
```

Optional integrations are declared as optional peer dependencies. The `exports` map is the
source of truth for public entry points.

## Consequences

- Users install one package and import only what they need.
- Core stays dependency-free and edge-safe.
- Subpaths are added as each phase lands; the map grows deliberately.
- A future split into scoped packages remains possible without changing the public entry names.
