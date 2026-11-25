import { describe, expect, it, vi } from "vitest";
import type { AgentModel, AuditRecord } from "../../src/agent";
import {
  callTool,
  createAuditStore,
  createDataAgent,
  answer as finalAnswer,
  mockModel,
} from "../../src/agent";
import { createRawQl, MemoryAdapter } from "../../src/index";

const seed = {
  users: [
    { id: "u1", tenantId: "t1", email: "ada@acme.com", role: "admin", name: "Ada" },
    { id: "u2", tenantId: "t1", email: "linus@acme.com", role: "member", name: "Linus" },
    { id: "u3", tenantId: "t2", email: "grace@other.com", role: "admin", name: "Grace" },
  ],
  orders: [
    { id: "o1", tenantId: "t1", userId: "u1", total: 100, status: "paid" },
    { id: "o2", tenantId: "t1", userId: "u2", total: 50, status: "open" },
    { id: "o3", tenantId: "t2", userId: "u3", total: 75, status: "paid" },
  ],
};

function setup() {
  return createRawQl({
    adapter: new MemoryAdapter({ seed: structuredClone(seed) }),
    entities: {
      users: { collection: "users" },
      orders: { collection: "orders" },
      agent_audit: { collection: "agent_audit" },
    },
  });
}

const entities = {
  users: {
    description: "Customer accounts",
    fields: {
      id: { type: "string" },
      email: { type: "string" },
      role: { type: "string", values: ["admin", "member"] },
      name: { type: "string" },
    },
  },
  orders: {
    fields: {
      id: { type: "string" },
      userId: { type: "string" },
      total: { type: "number" },
      status: { type: "string" },
    },
  },
};

describe("createDataAgent", () => {
  it("describes entities, queries data, and answers with citations", async () => {
    const records: AuditRecord[] = [];
    const db = setup();
    const agent = createDataAgent({
      db,
      entities,
      audit: { record: (record) => records.push(record) },
      model: mockModel([
        callTool("describe_entity", { entity: "users" }),
        callTool("query", {
          query: {
            op: "list",
            entity: "users",
            where: { role: "admin" },
            select: ["id", "name", "role"],
            sort: { name: "asc" },
          },
        }),
        finalAnswer("Ada and Grace are admins.", { inputTokens: 12, outputTokens: 6 }),
      ]),
    });

    const result = await agent.run("Who are the admins?", { actor: "ada", tenant: "t1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe("answered");
    expect(result.data.answer).toContain("Ada");
    expect(result.data.data).toEqual([
      { id: "u1", name: "Ada", role: "admin" },
      { id: "u3", name: "Grace", role: "admin" },
    ]);
    expect(result.data.citations).toEqual([{ entity: "users", count: 2, ids: ["u1", "u3"] }]);
    expect(result.data.stats).toMatchObject({ toolCalls: 2, invalidToolCalls: 0, repairs: 0 });
    expect(result.data.usage).toEqual({ inputTokens: 12, outputTokens: 6 });
    expect(result.data.steps).toHaveLength(5);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actor: "ada",
      tenant: "t1",
      outcome: "answered",
      question: "Who are the admins?",
      model: "mock",
    });
    expect(records[0]?.query).toMatchObject({ op: "list", entity: "users" });
    expect(records[0]?.resultSummary).toMatchObject({ entity: "users", rows: 2 });
  });

  it("redacts configured fields before returning data to the model", async () => {
    const agent = createDataAgent({
      db: setup(),
      entities,
      policy: { redactFields: { users: ["email"] } },
      model: mockModel([
        callTool("query", {
          query: { op: "list", entity: "users", where: { id: "u1" } },
        }),
        finalAnswer("Ada's record is ready."),
      ]),
    });

    const result = await agent.run("Show Ada's record");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = (result.data.data as Record<string, unknown>[])[0];
    expect(row?.email).toBe("[redacted]");
    expect(row?.name).toBe("Ada");

    const toolStep = result.data.steps.find((step) => step.type === "tool");
    expect(JSON.stringify(toolStep?.output)).not.toContain("ada@acme.com");
    expect(JSON.stringify(toolStep?.output)).toContain("[redacted]");
  });

  it("injects tenant scope server-side", async () => {
    const db = setup();
    const agent = createDataAgent({
      db,
      entities,
      policy: {
        tenantScope: (context) => ({ tenantId: context.tenant }),
      },
      model: mockModel([
        callTool("query", { query: { op: "list", entity: "orders", select: ["id", "total"] } }),
        finalAnswer("There are two orders for this tenant."),
      ]),
    });

    const result = await agent.run("How many orders?", { tenant: "t1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.data).toEqual([
      { id: "o1", total: 100 },
      { id: "o2", total: 50 },
    ]);
    expect(result.data.query?.where).toEqual({ tenantId: "t1" });
    expect(result.data.audit.policyDecisions).toContain("Injected tenant scope into the filter");
  });

  it("repairs invalid queries and retries", async () => {
    const agent = createDataAgent({
      db: setup(),
      entities,
      model: mockModel([
        callTool("query", {
          query: { op: "list", entity: "users", page: { limit: 0 } },
        }),
        callTool("query", {
          query: { op: "list", entity: "users", select: ["id"], page: { limit: 2 } },
        }),
        finalAnswer("Here are two users."),
      ]),
    });

    const result = await agent.run("List two users");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.stats.repairs).toBe(1);
    expect(result.data.stats.invalidToolCalls).toBe(1);
    expect(result.data.answer).toBe("Here are two users.");
  });

  it("refuses forbidden operations and never executes them", async () => {
    const db = setup();
    const agent = createDataAgent({
      db,
      entities,
      model: mockModel([
        callTool("query", { query: { op: "delete", entity: "users", where: { id: "u2" } } }),
        finalAnswer("I can't delete records."),
      ]),
    });

    const result = await agent.run("Delete Linus");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome).toBe("refused");
    expect(result.data.answer).toContain("can't");
    expect(result.data.audit.outcome).toBe("refused");
    expect(result.data.query).toBeUndefined();
    expect(result.data.stats.invalidToolCalls).toBe(0);

    const check = await db.execute<unknown[]>({ op: "list", entity: "users" });
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.data).toHaveLength(3);
  });

  it("requires approval for writes", async () => {
    const deniedApproval = vi.fn(async () => false);
    const denied = createDataAgent({
      db: setup(),
      entities,
      policy: { allowOps: ["list", "update"], requireApproval: ["update"] },
      approve: deniedApproval,
      model: mockModel([
        callTool("query", {
          query: { op: "update", entity: "users", where: { id: "u1" }, data: { name: "Ada L." } },
        }),
        finalAnswer("I couldn't update the record."),
      ]),
    });

    const deniedResult = await denied.run("Rename Ada");
    expect(deniedResult.ok).toBe(true);
    if (deniedResult.ok) expect(deniedResult.data.outcome).toBe("refused");
    expect(deniedApproval).toHaveBeenCalledOnce();

    const db = setup();
    const approved = createDataAgent({
      db,
      entities,
      policy: { allowOps: ["list", "update"], requireApproval: ["update"] },
      approve: () => true,
      model: mockModel([
        callTool("query", {
          query: { op: "update", entity: "users", where: { id: "u1" }, data: { name: "Ada L." } },
        }),
        finalAnswer("Renamed Ada."),
      ]),
    });

    const approvedResult = await approved.run("Rename Ada");
    expect(approvedResult.ok).toBe(true);
    if (approvedResult.ok) {
      expect(approvedResult.data.outcome).toBe("answered");
      expect(approvedResult.data.audit.policyDecisions).toContain("Approved `update` on `users`");
    }

    const stored = await db.execute<Record<string, unknown>>({
      op: "get",
      entity: "users",
      where: { id: "u1" },
    });
    if (stored.ok) expect(stored.data.name).toBe("Ada L.");
  });

  it("compiles explain plans and aggregates", async () => {
    const agent = createDataAgent({
      db: setup(),
      entities,
      model: mockModel([
        callTool("explain", {
          query: { op: "list", entity: "users", where: { role: "admin" }, page: { limit: 5 } },
        }),
        callTool("aggregate", {
          entity: "orders",
          pipeline: [
            { $match: { status: "paid" } },
            { $group: { by: "tenantId", fields: { total: { op: "sum", field: "total" } } } },
            { $sort: { total: "desc" } },
          ],
        }),
        finalAnswer("Tenant t1 has the larger paid total."),
      ]),
    });

    const result = await agent.run("Paid totals by tenant");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const explain = result.data.steps.find((step) => step.tool === "explain");
    expect(explain?.error).toBeUndefined();
    expect(JSON.stringify(explain?.output)).toContain("capabilities");

    expect(result.data.data).toEqual([
      { _id: "t1", total: 100 },
      { _id: "t2", total: 75 },
    ]);
  });

  it("enforces tool-call budgets and supports the kill switch", async () => {
    const budgetAgent = createDataAgent({
      db: setup(),
      entities,
      policy: { budget: { maxToolCalls: 1 } },
      model: mockModel([
        callTool("describe_entity", { entity: "users" }),
        callTool("describe_entity", { entity: "orders" }),
        finalAnswer("never"),
      ]),
    });

    const budget = await budgetAgent.run("Describe both");
    expect(budget.ok).toBe(false);
    if (!budget.ok) expect(budget.error.code).toBe("RATE_LIMITED");

    const agent = createDataAgent({
      db: setup(),
      entities,
      model: mockModel([finalAnswer("hi")]),
    });
    agent.enabled = false;

    const disabled = await agent.run("hi");
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.code).toBe("FORBIDDEN");
  });

  it("handles token budgets, model failures, and step exhaustion", async () => {
    const tokenAgent = createDataAgent({
      db: setup(),
      entities,
      policy: { budget: { maxTokens: 5 } },
      model: mockModel([
        callTool("describe_entity", { entity: "users" }, { usage: { inputTokens: 10 } }),
        finalAnswer("never"),
      ]),
    });
    const token = await tokenAgent.run("Describe");
    expect(token.ok).toBe(false);
    if (!token.ok) expect(token.error.code).toBe("RATE_LIMITED");

    const throwing: AgentModel = {
      id: "throwing",
      generate: async () => {
        throw new Error("model down");
      },
    };
    const failed = await createDataAgent({
      db: setup(),
      entities,
      model: throwing,
    }).run("hi");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("INTERNAL_ERROR");

    const loop = createDataAgent({
      db: setup(),
      entities,
      maxSteps: 2,
      model: mockModel([
        callTool("describe_entity", { entity: "users" }),
        callTool("describe_entity", { entity: "users" }),
      ]),
    });
    const exhausted = await loop.run("Describe forever");
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.error.code).toBe("TIMEOUT");
  });

  it("validates questions and model tool arguments", async () => {
    const agent = createDataAgent({
      db: setup(),
      entities,
      model: mockModel([finalAnswer("hi")]),
    });

    const empty = await agent.run("   ");
    expect(empty.ok).toBe(false);

    const malformed = createDataAgent({
      db: setup(),
      entities,
      model: mockModel([
        { toolCalls: [{ id: "call-1", name: "query", arguments: "{not json" }] },
        finalAnswer("done"),
      ]),
    });
    const result = await malformed.run("bad call");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.stats.invalidToolCalls).toBe(1);
  });

  it("persists audit records through RawQL", async () => {
    const db = setup();
    const store = createAuditStore({ db });
    const agent = createDataAgent({
      db,
      entities,
      audit: store,
      model: mockModel([
        callTool("query", { query: { op: "count", entity: "users" } }),
        finalAnswer("Three users."),
      ]),
    });

    await agent.run("Count users");
    const listed = await store.list();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]?.question).toBe("Count users");
    expect(listed.data[0]?.outcome).toBe("answered");
  });

  it("redacts PII from audit queries", async () => {
    const records: AuditRecord[] = [];
    const agent = createDataAgent({
      db: setup(),
      entities,
      audit: { record: (record) => records.push(record) },
      model: mockModel([
        callTool("query", {
          query: { op: "list", entity: "users", where: { email: "ada@acme.com" } },
        }),
        finalAnswer("Found Ada."),
      ]),
    });

    await agent.run("Find Ada by email");

    expect(JSON.stringify(records[0])).not.toContain("ada@acme.com");
  });
});
