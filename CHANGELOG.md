# Changelog

All notable changes to `raw_lib`. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project follows [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-11-24

The first release of the rewritten toolkit. 1.x remains available on the `main` branch and the
`v1-final` tag. See [MIGRATION.md](./MIGRATION.md) for the upgrade guide.

### Added

- **RawQL core** — typed `list`, `get`, `create`, `update`, `delete`, `count`, and `aggregate`
  operations with a normalized query protocol and adapter capability checks.
- **Memory adapter** — reference adapter with the full filter, sort, select, pagination, and
  pipeline surface.
- **MongoDB adapter** (`raw_lib/mongo`) — native driver, lazy connections, logical ID mapping,
  escaped case-insensitive text filters, and pipeline translation.
- **Shared adapter contract suite** — the same behavioral tests run against memory and MongoDB.
- **Typed entity sugar** — `db.entity<T>("users")` with `list`, `get`, `create`, `update`,
  `delete`, `count`, and `aggregate`.
- **RawVal** (`raw_lib/val`) — Standard Schema bridge for zod, valibot, and arktype, plus a
  zero-dependency `v` builder with `object`, `array`, `record`, `union`, `date`, `enum`,
  `literal`, and string/number rules.
- **RawAuth** (`raw_lib/auth`) — registration, password login, OTP login, access/refresh tokens,
  refresh rotation with family revocation, device fingerprint policies, session administration,
  audit hooks, and custom password hashers.
- **OTP delivery** — `twilio()` for SMS, `sendgrid()` for email, and `otpRouter()` for channel
  routing, all over `fetch`.
- **Packaging** — dual ESM/CJS builds, per-subpath type declarations, `npm pack` smoke tests for
  ESM, CJS, and TypeScript consumers.

### Changed

- Requests use `op`/`where`/`sort`/`page` instead of `type`/`filter`/`options`.
- Results are a discriminated union: `{ ok: true, data, meta? }` or `{ ok: false, error }`.
- Pipeline stages use neutral `$` keys and `$group` takes `{ by, fields }`.
- Mongo integration uses the native `mongodb` driver instead of Mongoose.
- Auth issues a short-lived access JWT plus a rotating opaque refresh token.
- Password hashing defaults to `scrypt` with a PBKDF2 Web Crypto fallback.
- OTP codes are stored as salted HMAC-SHA256 digests; contacts are stored as keyed hashes.

### Security

- `update` and `delete` require a non-empty `where`, blocking mass mutations.
- Refresh-token reuse revokes the whole session family.
- Device fingerprints never fail open once a session is bound.
- Unknown users and wrong passwords return identical errors, with dummy hashing to reduce
  timing differences.
- OTP verification enforces TTL, attempt caps, single-use consumption, and per-contact request
  throttling.
- Text filters escape regular-expression metacharacters.

### Removed

- SQL and Redis adapter stubs.
- Mongoose model registration.
- `populate` (use `$lookup` in an aggregate pipeline).
- `graphLookup` and `facet` pipeline stages.
- `revealCode` on OTP requests.
- The 1.x `rawql/*`, `rawval/*`, and `rawauth/*` deep imports.

[2.0.0]: https://github.com/raunak-dows17/raw_lib/releases/tag/v2.0.0
