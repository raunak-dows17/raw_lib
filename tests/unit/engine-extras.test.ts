import { describe, expect, it } from "vitest";
import { type Adapter, createRawQl, MemoryAdapter, RawLibError } from "../../src/index";

const seed = {
  users: [
    { id: "u1", name: "Ada", role: "admin", active: true },
    { id: "u2", name: "Linus", role: "member", active: false },
  ],
};

describe("RawQl engine extras", () => {
  it("registers middleware after creation", async () => {
    const db = createRawQl({ adapter: new MemoryAdapter({ seed }) });
    db.use(({ query }) => {
      query.where = { role: "member" };
    });

    const result = await db.execute<{ id: string }[]>({ op: "list", entity: "users" });

    expect(result.ok && result.data.map((row) => row.id)).toEqual(["u2"]);
  });

  it("wraps validator crashes", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({ seed }),
      validator: {
        validate: () => {
          throw new Error("validator blew up");
        },
      },
    });

    const result = await db.execute({ op: "list", entity: "users" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.message).toBe("validator blew up");
    }
  });

  it("rejects non-object queries through execute", async () => {
    const db = createRawQl({ adapter: new MemoryAdapter() });
    const result = await db.execute(null as any);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects empty entity names", () => {
    const db = createRawQl({ adapter: new MemoryAdapter() });
    expect(() => db.resolveEntity("")).toThrow(RawLibError);
    expect(() => db.entity("")).toThrow(RawLibError);
  });

  it("applies configured defaults", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({ seed }),
      defaults: { defaultLimit: 1, maxLimit: 2 },
    });

    const result = await db.execute<{ id: string }[]>({ op: "list", entity: "users" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.meta?.page).toMatchObject({ limit: 1, offset: 0, total: 2, hasMore: true });
    }
  });

  it("filters with $not", async () => {
    const db = createRawQl({ adapter: new MemoryAdapter({ seed }) });
    const result = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "users",
      where: { $not: { role: "admin" } },
    });

    expect(result.ok && result.data.map((row) => row.id)).toEqual(["u2"]);
  });

  it("returns validation errors when where is empty", async () => {
    const db = createRawQl({ adapter: new MemoryAdapter({ seed }) });
    const result = await db.execute({ op: "delete", entity: "users", where: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("reports the first missing capability", async () => {
    const adapter: Adapter = {
      name: "no-pipeline",
      capabilities: new Set(["filter.comparison"]),
      execute: async () => ({ kind: "items", items: [] }),
    };

    const db = createRawQl({ adapter });
    const result = await db.execute({
      op: "aggregate",
      entity: "users",
      pipeline: [{ $skip: 1 }, { $count: "total" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED_CAPABILITY");
      expect(result.error.details).toEqual({
        missing: ["pipeline.skip", "pipeline.count"],
      });
    }
  });

  it("passes normalized queries to the adapter", async () => {
    let received: unknown;

    const adapter: Adapter = {
      name: "spy",
      capabilities: new Set(["filter.comparison"]),
      execute: async (query) => {
        received = query;
        return { kind: "count", count: 0 };
      },
    };

    const db = createRawQl({
      adapter,
      entities: { users: { collection: "people", idField: "_id" } },
    });

    await db.execute({ op: "count", entity: "users", where: { role: "admin" } });

    expect(received).toMatchObject({
      op: "count",
      entity: { name: "users", collection: "people", idField: "_id" },
      where: { kind: "comparison", field: "role", op: "eq", value: "admin" },
    });
  });
});
