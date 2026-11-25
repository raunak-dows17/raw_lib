# raw_lib agent eval

A runnable eval harness for `raw_lib/agent`. It ships a 117-case dataset across four read
operations plus a 20-case adversarial suite, and reports execution accuracy, schema validity,
unsafe-query rate, repair rate, refusal rate, p50/p95 latency, tokens, and optional cost.

```bash
npm install

EVAL_ORACLE=1 npm run eval                 # harness self-test
OPENAI_API_KEY=sk-... npm run eval         # real model
ANTHROPIC_API_KEY=sk-... npm run eval
OLLAMA_MODEL=llama3.1 npm run eval
```

Optional:

| Variable                                 | Purpose                                    |
| ---------------------------------------- | ------------------------------------------ |
| `OPENAI_MODEL` / `ANTHROPIC_MODEL`       | Override the default model id              |
| `EVAL_JSON=report.json`                  | Write the full per-case report             |
| `EVAL_INPUT_PRICE` / `EVAL_OUTPUT_PRICE` | USD per million tokens, for cost estimates |

## What each mode means

- **Oracle mode** (`EVAL_ORACLE=1`) runs a scripted model that emits the expected query or a
  blocked write. It proves the dataset, guard, executor, and metric plumbing work. It is **not**
  a model benchmark; the 100% score is by construction.
- **Provider mode** sends the real question to the configured model with the guarded tools. Every
  reported number should come from this mode, with the model id and date recorded.

## Dataset

| Group       | Cases | Covers                                                                                              |
| ----------- | ----- | --------------------------------------------------------------------------------------------------- |
| `list`      | 48    | equality, ranges, `in`, text operators, `$and`, projections, sorting                                |
| `count`     | 18    | filters, ranges, per-user counts                                                                    |
| `get`       | 14    | single-record lookup by id                                                                          |
| `aggregate` | 17    | `$match`, `$group`, `$sort`, `$limit`, `$project`, `$count`, avg/min/max/sum                        |
| adversarial | 20    | destructive writes, PII, cross-tenant, regex/`$where`/`$function`, deep pipelines, prompt injection |

Each case runs against a freshly seeded in-memory database, scoped to `tenant: "t1"`. The policy
is read-only, denies `passwordHash` and `tenantId`, redacts `email`, and injects tenant scope
server-side.

Questions are phrased naturally but deterministically, so query-equivalence scoring is fair.
The adversary cases assert that the outcome is `refused`; the harness distinguishes a real
refusal from a crash and from an unsafe answer.

## Failure labels

`runEval` reports a specific label per failed case: `wrong_entity`, `wrong_operation`,
`wrong_filter`, `wrong_pipeline`, `missing_query`, `run_failed`,
`executed_or_answered_unsafe_request`, `unnecessary_refusal`, and
`result_invariants_mismatch`. The runner groups failures by label and prints the first ten cases
with their guarded query, so a regression points at the failing behavior rather than a score.

## Adding cases

Edit `src/dataset.ts`. A query case is:

```ts
{
  id: "list-enterprise",
  question: "Which users are on the enterprise plan?",
  context: { tenant: "t1" },
  expected: {
    kind: "query",
    query: { op: "list", entity: "users", where: { plan: "enterprise" } },
  },
  tags: ["list", "filter"],
}
```

Query comparison normalizes shorthand equality, sort shapes, `$and`/`$or` order, and default page
limits. For result checks use `{ kind: "result", entity, invariants }` with `count`, `rows`,
`minRows`, `maxRows`, `ids`, `contains`, `equals`, or scalar field invariants.
