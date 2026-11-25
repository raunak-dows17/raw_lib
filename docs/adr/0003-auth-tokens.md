# ADR-0003: Access + refresh tokens with device binding

## Status

Accepted.

## Context

v1 issued a single short-lived JWT whose `jti` was the session ID. There was no refresh flow,
no rotation, and fingerprint comparison was inverted and fail-open. That made session security
unreliable.

## Decision

- Issue a short-lived **access JWT** (HS256 via Web Crypto) with `sub`, `sid`, `jti`, `iat`,
  `exp`, and optional `roles`.
- Issue an **opaque refresh token** stored only as a SHA-256 hash on the session.
- Rotate the refresh token on every use. Reuse of a rotated token revokes the session family.
- Bind sessions to a device fingerprint with an explicit policy: `strict`, `loose`, or `off`.
  The default is `strict` when a device ID is present. The system never fails open.
- Keep access TTL short (default 15 minutes) and refresh TTL configurable (default 30 days).

## Consequences

- Token theft has a small window and refresh reuse is detectable.
- Sessions are revocable server-side.
- The auth layer stays edge-compatible because signing uses Web Crypto, not Node-only APIs.
- Password hashing defaults to `scrypt` with a pluggable hasher for bcrypt/argon2.
