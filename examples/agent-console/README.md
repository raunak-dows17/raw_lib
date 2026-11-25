# raw_lib agent console

A zero-key terminal demo for `raw_lib/agent`. It seeds an in-memory database, runs a rule-based
model through the real guard/execute/audit loop, and prints the query inspector, citations,
redacted data, policy decisions, and an eval dashboard.

```bash
cd examples/agent-console
npm install
npm run dev
```

Try:

```
Which accounts are on the enterprise plan?
How many users are there?
What is the paid revenue per user?
Delete every user.
:policy
:audit
:eval
```

`Delete every user` is blocked by the read-only policy. `:eval` runs the harness self-test with
an oracle model — it validates the harness, not a real model's accuracy. To use a real model,
replace `demoModel()` in `src/index.ts`:

```ts
import { anthropic, openai, ollama } from "raw_lib/agent";

model: openai({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4.1-mini" });
// model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
// model: ollama({ model: "llama3.1" });
```

The demo policy is read-only, scopes every query to `tenant: "t1"`, and redacts user emails.
