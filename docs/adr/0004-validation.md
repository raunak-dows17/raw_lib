# ADR-0004: Standard Schema plus a built-in validator

## Status

Accepted.

## Context

v1's validation engine had a bespoke registry that did not match its own README and had no
integration with popular schema libraries. Users already use zod, valibot, or arktype.

## Decision

RawVal accepts any **Standard Schema** implementation (`~standard.validate`) and ships a small
zero-dependency builder (`v.object`, `v.string`, etc.) for users who do not want a validator
dependency.

Validation is operation-aware: `create`/`update` validate `data`; `list`/`get`/`delete`/`count`
validate query parameters; `aggregate` validates the pipeline shape. Parsed output replaces
`data` for writes.

## Consequences

- No custom schema DSL to learn for users who already use a validator.
- Core remains dependency-free.
- Validation errors map to `VALIDATION_FAILED` with `{ path, message, code }`.
- The built-in builder is intentionally small; advanced use cases should use a real library.
