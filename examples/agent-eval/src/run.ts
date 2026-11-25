import { writeFile } from "node:fs/promises";
import { createRawQl, MemoryAdapter } from "raw_lib";
import {
  type AgentModel,
  answer,
  anthropic,
  callTool,
  createAuditStore,
  createDataAgent,
  ollama,
  openai,
  runEval,
} from "raw_lib/agent";
import { agentPolicy, datasetStats, entities, evalDataset, seed } from "./dataset.js";

const oracle = process.env.EVAL_ORACLE === "1";
const jsonOut = process.env.EVAL_JSON;

function buildDb() {
  return createRawQl({
    adapter: new MemoryAdapter({ seed: structuredClone(seed) }),
    entities: {
      users: { collection: "users" },
      orders: { collection: "orders" },
      agent_audit: { collection: "agent_audit" },
    },
  });
}

/** Solved-by-construction model: it validates the harness, not a model's accuracy. */
function oracleModel(expected: (typeof evalDataset.cases)[number]["expected"]): AgentModel {
  if (expected.kind === "refusal") {
    return {
      id: "oracle",
      generate: async (input) => {
        const last = input.messages[input.messages.length - 1];
        if (last?.role === "tool") {
          return answer("I can't perform that operation.", { inputTokens: 10, outputTokens: 5 });
        }
        return callTool("query", {
          query: { op: "delete", entity: "users", where: { id: "u1" } },
        });
      },
    };
  }

  if (expected.kind === "query") {
    return {
      id: "oracle",
      generate: async (input) => {
        const last = input.messages[input.messages.length - 1];
        if (last?.role === "tool") {
          return answer("Query complete.", { inputTokens: 10, outputTokens: 5 });
        }
        return callTool("query", { query: expected.query });
      },
    };
  }

  return {
    id: "oracle",
    generate: async () => answer("No oracle for result cases."),
  };
}

function selectModel(expected: (typeof evalDataset.cases)[number]["expected"]): AgentModel {
  if (oracle) return oracleModel(expected);
  if (process.env.OPENAI_API_KEY) {
    return openai({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
    });
  }
  if (process.env.OLLAMA_MODEL) {
    return ollama({ model: process.env.OLLAMA_MODEL });
  }
  return oracleModel(expected);
}

function printTable(report: Awaited<ReturnType<typeof runEval>>): void {
  const width = Math.max(...report.cases.map((entry) => entry.id.length), 6);
  for (const entry of report.cases) {
    const status = entry.passed ? "PASS" : "FAIL";
    const detail = entry.passed
      ? `${entry.outcome} · ${entry.toolCalls} call(s) · ${entry.latencyMs}ms`
      : `${entry.failure ?? "unknown"}${entry.query ? ` (${entry.query.op} ${entry.query.entity})` : ""}`;
    console.log(`  ${status}  ${entry.id.padEnd(width)}  ${detail}`);
  }
}

function printFailures(report: Awaited<ReturnType<typeof runEval>>): void {
  const failures = report.cases.filter((entry) => !entry.passed);
  if (failures.length === 0) {
    console.log("\nNo failures.");
    return;
  }

  const counts = new Map<string, number>();
  for (const entry of failures) {
    const key = entry.failure ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  console.log("\nFailure breakdown");
  for (const [failure, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${failure}`);
  }

  console.log("\nFirst failures");
  for (const entry of failures.slice(0, 10)) {
    console.log(`  ${entry.id}: ${entry.question}`);
    console.log(
      `    ${entry.failure ?? "unknown"}${entry.query ? ` → ${JSON.stringify(entry.query)}` : ""}`,
    );
  }
}

const modelName = oracle
  ? "oracle (harness self-test)"
  : process.env.OPENAI_API_KEY
    ? `openai:${process.env.OPENAI_MODEL ?? "gpt-4.1-mini"}`
    : process.env.ANTHROPIC_API_KEY
      ? `anthropic:${process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"}`
      : process.env.OLLAMA_MODEL
        ? `ollama:${process.env.OLLAMA_MODEL}`
        : "oracle (no provider configured; set EVAL_ORACLE=1 to silence this notice)";

console.log("raw_lib agent eval");
console.log(`  dataset: ${evalDataset.name}`);
console.log(
  `  cases:   ${datasetStats.total} (${datasetStats.list} list, ${datasetStats.count} count, ${datasetStats.get} get, ${datasetStats.aggregate} aggregate, ${datasetStats.adversarial} adversarial)`,
);
console.log(`  model:   ${modelName}`);
if (
  !oracle &&
  !process.env.OPENAI_API_KEY &&
  !process.env.ANTHROPIC_API_KEY &&
  !process.env.OLLAMA_MODEL
) {
  console.log("  note:    this is a harness self-test, not a model benchmark");
}
console.log("");

const report = await runEval({
  dataset: evalDataset,
  agentForCase: (testCase) => {
    const db = buildDb();
    return createDataAgent({
      db,
      entities,
      policy: agentPolicy,
      audit: createAuditStore({ db }),
      maxSteps: 6,
      model: selectModel(testCase.expected),
    });
  },
  pricing: {
    inputPerMillion: Number(process.env.EVAL_INPUT_PRICE ?? 0),
    outputPerMillion: Number(process.env.EVAL_OUTPUT_PRICE ?? 0),
  },
});

printTable(report);
printFailures(report);

const m = report.metrics;
console.log("\nMetrics");
console.log(
  `  execution accuracy  ${(m.executionAccuracy * 100).toFixed(1)}%  (${m.passed}/${m.total})`,
);
console.log(`  schema validity     ${(m.schemaValidity * 100).toFixed(1)}%`);
console.log(`  unsafe rate         ${(m.unsafeRate * 100).toFixed(1)}%`);
console.log(`  repair rate         ${(m.repairRate * 100).toFixed(1)}%`);
console.log(`  refusal rate        ${(m.refusalRate * 100).toFixed(1)}%`);
console.log(`  latency p50 / p95   ${m.latencyP50Ms}ms / ${m.latencyP95Ms}ms`);
console.log(`  tokens              ${m.tokens.inputTokens} in / ${m.tokens.outputTokens} out`);
if (m.estimatedCostUsd !== undefined) {
  console.log(`  estimated cost      $${m.estimatedCostUsd.toFixed(4)}`);
}

if (jsonOut) {
  await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nReport written to ${jsonOut}`);
}

if (!report.cases.every((entry) => entry.passed)) {
  process.exitCode = 1;
}
