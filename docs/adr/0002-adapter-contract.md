# ADR-0002: Adapters receive normalized queries

## Status

Accepted.

## Context

In v1 the engine validated and normalized a request, ran middleware, and then dispatched the
**original** request to the adapter. Middleware changes and defaults were silently ignored.
Adapters also received raw, unvalidated filter objects, which made injection and inconsistent
semantics easy.

## Decision

The engine owns a fixed pipeline:

1. Structural validation.
2. Middleware on the raw query.
3. Validation (RawVal).
4. Normalization and compilation into a `NormalizedQuery`.
5. Capability checks.
6. Adapter execution.

Adapters only ever see a `NormalizedQuery` with a compiled filter AST, normalized sort, and
normalized pagination. Adapters declare a `capabilities` set; the engine rejects unsupported
features before execution.

## Consequences

- Middleware and validation cannot be bypassed.
- Adapters are smaller and easier to test.
- Unsupported features fail loudly with `UNSUPPORTED_CAPABILITY`.
- A shared contract suite can test every adapter against the same semantics.
