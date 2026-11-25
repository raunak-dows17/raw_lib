# ADR-0005: Policy-enforced natural-language data access

## Status

Accepted.

## Context

A natural-language data agent is only useful if it can reach real data, and only safe if the
model cannot decide what it is allowed to reach. Prompt instructions are not a security
boundary: a model can be persuaded by prompt injection, hallucinate a destructive operation, or
simply make a mistake. Handing the model SQL, a Mongo pipeline, or a database client makes every
one of those failures a production incident.

`raw_lib` already owns a typed query protocol, validation, and an adapter contract. The agent
should reuse that boundary rather than introduce a second execution path.

## Decision

The model emits a typed `Query` or pipeline. Deterministic code owns everything else:

1. Tool arguments are parsed and validated.
2. A policy guard checks operation, entity, fields, operators, stages, lookup targets, and
   limits. Tenant scope is injected server-side.
3. RawQL normalizes and executes the query through the configured adapter.
4. Results are row-capped and redacted before they return to the model.
5. Every tool call, policy decision, and result summary is audited through RawQL.

Defaults are read-only. Writes require both an explicit `allowOps` entry and an approval
callback. The prompt describes the policy, but the guard is the source of truth. The model never
receives credentials, collection handles, or an escape hatch such as `$where` or `$function`.

The agent loop is deterministic code around a nondeterministic model: bounded steps, bounded
tool calls, bounded tokens, bounded time, and a repair path for validation and capability
errors. A kill switch (`agent.enabled = false`) and an empty `allowOps` both disable execution.

## Consequences

- The agent cannot exceed the data layer's own guarantees.
- Policy behavior is unit-testable without a model; the model loop is testable with `mockModel`.
- Eval results are comparable because query comparison and safety checks are deterministic.
- Writes are deliberately inconvenient; human approval is a product requirement, not a flag.
- The guard must be extended whenever RawQL gains a new operator or pipeline stage.
- Redaction is field-based, not semantic. Applications still need to classify their own data.
