import { describe, expect, it } from "vitest";
import type { AgentEntities, NormalizedAgentPolicy } from "../../src/agent";
import { defineAgentTools, normalizePolicy } from "../../src/agent";
import { createRawQl, MemoryAdapter } from "../../src/index";

const seed = {
  users: [
    { id: "u1", tenantId: "t1", name: "Ada", email: "ada@acme.com", plan: "enterprise" },
    { id: "u2", tenantId: "t1", name: "Linus", email: "linus@acme.com", plan: "pro" },
  ],
  orders: [
    { id: "o1", tenantId: "t1", userId: "u1", total: 100, status: "paid" },
    { id: "o2", tenantId: "t1", userId: "u2", total: 50, status: "open" },
  ],
  secrets: [{ id: "s1", value: "nope" }],
};

const entities: AgentEntities = {
  users: {
    description: "Customer accounts",
    fields: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      plan: { type: "string" },
      tenantId: { type: "string", sensitive: true },
    },
    relations: {
      orders: { entity: "orders", field: "userId" },
      secrets: { entity: "secrets", field: "userId" },
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
  secrets: { fields: { id: { type: "string" }, value: { type: "string" } } },
};

function setup(options: { policy?: NormalizedAgentPolicy; approve?: () => boolean } = {}) {
  const db = createRawQl({
    adapter: new MemoryAdapter({ seed: structuredClone(seed) }),
    entities: {
      users: { collection: "users" },
      orders: { collection: "orders" },
      secrets: { collection: "secrets" },
      unknown_entity: { collection: "unknown_entity" },
    },
  });

  const policy =
    options.policy ??
    normalizePolicy(
      {
        allowEntities: ["users", "orders"],
        redactFields: { users: ["email"] },
        maxRows: 1,
      },
      entities,
    );

  return defineAgentTools({
    db,
    policy,
    entities,
    ...(options.approve ? { approve: options.approve } : {}),
  });
}

const context = { runId: "run-1", context: { tenant: "t1" } };

describe("defineAgentTools", () => {
  it("exposes four JSON-schema tools", () => {
    const toolkit = setup();

    expect(toolkit.definitions.map((tool) => tool.name)).toEqual([
      "describe_entity",
      "query",
      "aggregate",
      "explain",
    ]);
    for (const tool of toolkit.definitions) {
      expect(tool.parameters).toMatchObject({ type: "object" });
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("describes entities, hides denied fields, and filters relations", async () => {
    const toolkit = setup();
    const result = await toolkit.execute(
      { id: "c1", name: "describe_entity", arguments: { entity: "users" } },
      context,
    );

    expect(result.result.ok).toBe(true);
    if (!result.result.ok) return;

    const description = result.result.data as {
      entity: string;
      description: string;
      fields: Record<string, unknown>;
      relations: Record<string, unknown>;
      allowedOps: string[];
    };

    expect(description.entity).toBe("users");
    expect(description.description).toBe("Customer accounts");
    expect(description.fields.email).toBeDefined();
    expect(description.fields.tenantId).toBeUndefined();
    expect(description.relations.orders).toBeDefined();
    expect(description.relations.secrets).toBeUndefined();
    expect(description.allowedOps).toEqual(["list", "get", "count", "aggregate"]);
  });

  it("infers fields from a sample and from one row when fields are omitted", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: { ...structuredClone(seed), events: [{ id: "e1", kind: "signup", at: 1 }] },
      }),
      entities: {
        users: { collection: "users" },
        events: { collection: "events" },
      },
    });
    const policy = normalizePolicy(
      { allowEntities: ["users", "events"] },
      {
        users: { sample: { id: "u1", active: true } },
        events: {},
      },
    );
    const toolkit = defineAgentTools({
      db,
      policy,
      entities: {
        users: { sample: { id: "u1", active: true } },
        events: {},
      },
    });

    const users = await toolkit.execute(
      { id: "c1", name: "describe_entity", arguments: { entity: "users" } },
      context,
    );
    const events = await toolkit.execute(
      { id: "c2", name: "describe_entity", arguments: { entity: "events" } },
      context,
    );

    expect(users.result.ok && users.result.data).toMatchObject({
      fields: { id: { type: "string" }, active: { type: "boolean" } },
    });
    expect(events.result.ok && events.result.data).toMatchObject({
      fields: { id: { type: "string" }, kind: { type: "string" }, at: { type: "number" } },
    });
  });

  it("rejects empty and disallowed entities", async () => {
    const toolkit = setup();
    const empty = await toolkit.execute(
      { id: "c1", name: "describe_entity", arguments: { entity: "  " } },
      context,
    );
    const denied = await toolkit.execute(
      { id: "c2", name: "describe_entity", arguments: { entity: "secrets" } },
      context,
    );

    expect(empty.result.ok).toBe(false);
    if (!empty.result.ok) expect(empty.result.error.code).toBe("VALIDATION_FAILED");
    expect(empty.invalid).toBe(true);

    expect(denied.result.ok).toBe(false);
    if (!denied.result.ok) expect(denied.result.error.code).toBe("FORBIDDEN");
    expect(denied.invalid).toBe(false);
  });

  it("rejects malformed arguments and unknown tools", async () => {
    const toolkit = setup();
    const cases = [
      { id: "c1", name: "query", arguments: 42 as never },
      { id: "c2", name: "query", arguments: "{not json" },
      { id: "c3", name: "query", arguments: "[]" },
      { id: "c4", name: "describe_entity", arguments: { entity: 1 } },
      { id: "c5", name: "query", arguments: {} },
      { id: "c6", name: "aggregate", arguments: { entity: "orders" } },
      { id: "c7", name: "explain", arguments: { query: "nope" } },
      { id: "c8", name: "nope", arguments: {} },
    ];

    for (const call of cases) {
      const result = await toolkit.execute(call as never, context);
      expect(result.result.ok).toBe(false);
      expect(result.invalid).toBe(true);
      if (!result.result.ok) expect(result.result.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("accepts JSON string arguments", async () => {
    const toolkit = setup();
    const result = await toolkit.execute(
      {
        id: "c1",
        name: "query",
        arguments: JSON.stringify({ query: { op: "count", entity: "orders" } }),
      },
      context,
    );

    expect(result.result.ok).toBe(true);
    if (result.result.ok) expect(result.result.data).toBe(2);
  });

  it("caps rows and redacts fields in results", async () => {
    const toolkit = setup();
    const result = await toolkit.execute(
      {
        id: "c1",
        name: "query",
        arguments: {
          query: {
            op: "list",
            entity: "users",
            select: ["id", "name", "email"],
            sort: { id: "asc" },
          },
        },
      },
      context,
    );

    expect(result.result.ok).toBe(true);
    expect(result.rows).toBe(1);
    expect(result.decisions).toContain("Truncated rows to 1");
    expect(result.data).toEqual([{ id: "u1", name: "Ada", email: "[redacted]" }]);
  });

  it("redacts joined lookup rows", async () => {
    const toolkit = setup({
      policy: normalizePolicy(
        {
          allowEntities: ["users", "orders"],
          redactFields: { users: ["email"] },
        },
        entities,
      ),
    });

    const result = await toolkit.execute(
      {
        id: "c1",
        name: "aggregate",
        arguments: {
          entity: "users",
          pipeline: [
            {
              $lookup: {
                from: "users",
                localField: "id",
                foreignField: "id",
                as: "same",
              },
            },
          ],
        },
      },
      context,
    );

    expect(result.result.ok).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain("ada@acme.com");
    expect(JSON.stringify(result.data)).toContain("[redacted]");
  });

  it("explains valid queries and refuses forbidden ones", async () => {
    const toolkit = setup();
    const valid = await toolkit.execute(
      {
        id: "c1",
        name: "explain",
        arguments: { query: { op: "list", entity: "users", where: { plan: "pro" } } },
      },
      context,
    );
    const forbidden = await toolkit.execute(
      {
        id: "c2",
        name: "explain",
        arguments: { query: { op: "delete", entity: "users", where: { id: "u1" } } },
      },
      context,
    );

    expect(valid.result.ok).toBe(true);
    if (valid.result.ok) {
      expect(valid.result.data).toMatchObject({
        plan: { op: "list", entity: { name: "users" } },
      });
      expect(JSON.stringify(valid.result.data)).toContain("capabilities");
    }
    expect(forbidden.result.ok).toBe(false);
    expect(forbidden.invalid).toBe(false);
  });

  it("returns approval denials without marking them invalid", async () => {
    const toolkit = setup({
      policy: normalizePolicy(
        { allowOps: ["list", "update"], requireApproval: ["update"], allowEntities: ["users"] },
        entities,
      ),
      approve: () => false,
    });

    const result = await toolkit.execute(
      {
        id: "c1",
        name: "query",
        arguments: {
          query: { op: "update", entity: "users", where: { id: "u1" }, data: { name: "A" } },
        },
      },
      context,
    );

    expect(result.result.ok).toBe(false);
    if (!result.result.ok) expect(result.result.error.code).toBe("FORBIDDEN");
    expect(result.invalid).toBe(false);
    expect(result.proposedQuery).toBeDefined();
  });

  it("reports execution errors and timeouts", async () => {
    const failingDb = {
      execute: async () => ({
        ok: false as const,
        error: { code: "ADAPTER_ERROR" as const, message: "boom" },
      }),
      resolveEntity: () => ({ name: "users", idField: "id", fields: {} }),
    };
    const policy = normalizePolicy({ allowEntities: ["users"] }, entities);

    const failing = defineAgentTools({
      db: failingDb as never,
      policy,
      entities,
    });
    const failure = await failing.execute(
      { id: "c1", name: "query", arguments: { query: { op: "list", entity: "users" } } },
      context,
    );
    expect(failure.result.ok).toBe(false);
    expect(failure.invalid).toBe(false);

    const hanging = defineAgentTools({
      db: {
        execute: () => new Promise(() => {}),
        resolveEntity: () => ({ name: "users", idField: "id", fields: {} }),
      } as never,
      policy: normalizePolicy({ allowEntities: ["users"], timeoutMs: 5 }, entities),
      entities,
    });
    const timeout = await hanging.execute(
      { id: "c2", name: "query", arguments: { query: { op: "list", entity: "users" } } },
      context,
    );
    expect(timeout.result.ok).toBe(false);
    if (!timeout.result.ok) expect(timeout.result.error.code).toBe("TIMEOUT");
    expect(timeout.invalid).toBe(false);
  });
});
