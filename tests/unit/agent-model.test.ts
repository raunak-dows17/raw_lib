import { describe, expect, it } from "vitest";
import { createAuditStore } from "../../src/agent/audit";
import { answer, callTool, mockModel } from "../../src/agent/model";
import type { AuditRecord } from "../../src/agent/types";

describe("mockModel", () => {
  it("returns scripted turns in order and falls back to text", async () => {
    const model = mockModel([callTool("query", { query: { op: "count" } }), answer("done")], {
      id: "scripted",
      fallbackText: "fallback",
    });

    expect(model.id).toBe("scripted");
    expect(await model.generate({ system: "s", messages: [], tools: [] })).toMatchObject({
      toolCalls: [{ name: "query" }],
    });
    expect(await model.generate({ system: "s", messages: [], tools: [] })).toEqual({
      text: "done",
    });
    expect(await model.generate({ system: "s", messages: [], tools: [] })).toEqual({
      text: "fallback",
    });
  });

  it("supports function steps and repeating the last step", async () => {
    let calls = 0;
    const model = mockModel(
      [
        async () => {
          calls++;
          return answer(`call ${calls}`);
        },
      ],
      { repeatLast: true },
    );

    expect(await model.generate({ system: "s", messages: [], tools: [] })).toEqual({
      text: "call 1",
    });
    expect(await model.generate({ system: "s", messages: [], tools: [] })).toEqual({
      text: "call 2",
    });
    expect(await model.generate({ system: "s", messages: [], tools: [] })).toEqual({
      text: "call 3",
    });
  });

  it("builds tool calls and answers with optional usage", () => {
    expect(callTool("query", { query: { op: "count" } })).toEqual({
      toolCalls: [{ id: "call_query", name: "query", arguments: { query: { op: "count" } } }],
    });

    expect(
      callTool("query", {}, { id: "custom", usage: { inputTokens: 1, outputTokens: 2 } }),
    ).toEqual({
      toolCalls: [{ id: "custom", name: "query", arguments: {} }],
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    expect(answer("hi")).toEqual({ text: "hi" });
    expect(answer("hi", { inputTokens: 3, outputTokens: 4 })).toEqual({
      text: "hi",
      usage: { inputTokens: 3, outputTokens: 4 },
    });
  });
});

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    runId: "run-1",
    question: "How many users?",
    actor: "ada",
    tenant: "t1",
    policyDecisions: [],
    tokens: { inputTokens: 1, outputTokens: 1 },
    model: "mock",
    outcome: "answered",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createAuditStore", () => {
  it("requires a database", () => {
    expect(() => createAuditStore(undefined as never)).toThrow(/db/);
  });

  it("records and lists through RawQL, clamping paging", async () => {
    const calls: unknown[] = [];
    const db = {
      execute: async (query: unknown) => {
        calls.push(query);
        return { ok: true, data: [] };
      },
    };
    const store = createAuditStore({ db: db as never, entity: "audit_log" });

    const recorded = await store.record(record());
    const listed = await store.list({ limit: 0, offset: -5 });

    expect(recorded.ok).toBe(true);
    expect(listed.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      op: "create",
      entity: "audit_log",
      data: { runId: "run-1" },
    });
    expect(calls[1]).toMatchObject({
      op: "list",
      entity: "audit_log",
      page: { limit: 1, offset: 0 },
    });
  });

  it("caps large list limits at 500", async () => {
    let captured: { page?: { limit: number } } = {};
    const db = {
      execute: async (query: { page?: { limit: number } }) => {
        captured = query;
        return { ok: true, data: [] };
      },
    };
    const store = createAuditStore({ db: db as never });

    await store.list({ limit: 10_000, offset: 12 });

    expect(captured.page?.limit).toBe(500);
  });

  it("turns thrown errors into typed results", async () => {
    const store = createAuditStore({
      db: {
        execute: async () => {
          throw new Error("database offline");
        },
      } as never,
    });

    const recorded = await store.record(record());
    const listed = await store.list();

    expect(recorded.ok).toBe(false);
    expect(listed.ok).toBe(false);
    if (!recorded.ok) expect(recorded.error.code).toBe("INTERNAL_ERROR");
    if (!listed.ok) expect(listed.error.message).toContain("database offline");
  });
});
