# Examples

Runnable examples that show the full stack — RawQL, RawVal, RawAuth, and the policy-enforced
data agent. Each example is standalone: it has its own `package.json` and uses the in-memory
adapter, so there is nothing to install besides Node.js.

## HTTP APIs

```bash
cd examples/express
npm install
npm run dev
```

All three expose the same routes:

| Method | Route            | Purpose                            |
| ------ | ---------------- | ---------------------------------- |
| `POST` | `/auth/register` | Create a user and start a session  |
| `POST` | `/auth/login`    | Password login                     |
| `POST` | `/auth/refresh`  | Rotate the refresh token           |
| `POST` | `/auth/logout`   | Revoke the session                 |
| `GET`  | `/me`            | Verify the access token            |
| `GET`  | `/users`         | List users without password hashes |

Send `Authorization: Bearer <accessToken>` to protected routes and `x-device-id` when you want
strict device binding. Replace `MemoryAdapter` with `mongo()` from `raw_lib/mongo` to persist
data; the application code does not change.

> The examples target `raw_lib@2`. Until the release is published, point `raw_lib` at the
> repository (`"raw_lib": "file:../.."`) or run `npm link` from the project root.

## Agent examples

Three self-contained demos for `raw_lib/agent`:

| Example                          | What it shows                                                                            | Needs a key? |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| [`agent-console`](agent-console) | Terminal REPL: query inspector, citations, redacted data, audit timeline, eval dashboard | No           |
| [`agent-eval`](agent-eval)       | Golden + adversarial dataset (117 cases) and the `runEval` report                        | Optional     |
| [`mcp-server`](mcp-server)       | Read-only MCP server exposing `describe_entity`, `query`, `aggregate`, `explain`         | No           |

```bash
cd examples/agent-console
npm install
npm run dev
```

Then try `Which accounts are on the enterprise plan?`, `Delete every user`, `:audit`, and
`:eval`.

For the eval harness:

```bash
cd examples/agent-eval
npm install
EVAL_ORACLE=1 npm run eval     # harness self-test, not a model benchmark
OPENAI_API_KEY=sk-... npm run eval   # or ANTHROPIC_API_KEY / OLLAMA_MODEL
```

`EVAL_JSON=report.json` writes the full per-case report, including failure labels and guarded
queries. The oracle mode checks that the harness and dataset are wired correctly; publish real
numbers only from a model run.

All three enforce the same policy in code: read-only operations, server-side tenant scope, denied
sensitive fields, and email redaction.
