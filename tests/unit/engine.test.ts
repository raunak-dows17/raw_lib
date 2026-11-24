import { describe, expect, it } from "vitest";
import {
  type Adapter,
  createRawQl,
  MemoryAdapter,
  RawLibError,
  type Validator,
} from "../../src/index";

const seed = {
  users: [
    { id: "u1", name: "Ada", tenantId: "t1" },
    { id: "u2", name: "Linus", tenantId: "t2" },
  ],
};

describe("RawQl engine", () => {
  it("runs middleware before normalization", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({ seed }),
      middlewares: [
        ({ query }) => {
          query.where = { ...(query.where ?? {}), tenantId: "t1" };
        },
      ],
    });

    const result = await db.execute<{ id: string }[]>({ op: "list", entity: "users" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((user) => user.id)).toEqual(["u1"]);
    }
  });

  it("returns middleware errors", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter(),
      middlewares: [
        () => {
          throw new RawLibError("FORBIDDEN", "nope");
        },
      ],
    });

    const result = await db.execute({ op: "count", entity: "users" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
      expect(result.error.message).toBe("nope");
    }
  });

  it("returns validation issues", async () => {
    const validator: Validator = {
      validate: () => ({
        ok: false,
        issues: [{ path: "email", message: "is required" }],
      }),
    };

    const db = createRawQl({ adapter: new MemoryAdapter(), validator });
    const result = await db.execute({
      op: "create",
      entity: "users",
      data: { name: "Ada" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.details).toEqual([{ path: "email", message: "is required" }]);
    }
  });

  it("can skip validation for trusted internal operations", async () => {
    const validator: Validator = {
      validate: () => ({
        ok: false,
        issues: [{ path: "email", message: "is required" }],
      }),
    };

    const db = createRawQl({ adapter: new MemoryAdapter(), validator });
    const result = await db.execute(
      { op: "create", entity: "users", data: { name: "Ada" } },
      { validate: false },
    );

    expect(result.ok).toBe(true);
  });

  it("uses parsed validator output for writes", async () => {
    const validator: Validator = {
      validate: ({ data }) => ({
        ok: true,
        value: { ...(data as Record<string, unknown>), normalized: true },
      }),
    };

    const db = createRawQl({ adapter: new MemoryAdapter(), validator });
    const result = await db.execute<{ id: string; normalized: boolean }>({
      op: "create",
      entity: "users",
      data: { name: "Ada" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.normalized).toBe(true);
    }
  });

  it("rejects unsupported capabilities", async () => {
    const limited: Adapter = {
      name: "limited",
      capabilities: new Set(["filter.comparison", "page.offset"]),
      execute: async () => ({ kind: "items", items: [] }),
    };

    const db = createRawQl({ adapter: limited });
    const result = await db.execute({
      op: "list",
      entity: "users",
      sort: { name: "asc" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED_CAPABILITY");
      expect(result.error.details).toEqual({ missing: ["sort"] });
    }
  });

  it("wraps adapter failures", async () => {
    const failing: Adapter = {
      name: "failing",
      capabilities: new Set(),
      execute: async () => {
        throw new Error("boom");
      },
    };

    const db = createRawQl({ adapter: failing });
    const result = await db.execute({ op: "count", entity: "users" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ADAPTER_ERROR");
      expect(result.error.message).toBe("boom");
    }
  });

  it("closes the adapter", async () => {
    let closed = false;

    const adapter: Adapter = {
      name: "closable",
      capabilities: new Set(),
      execute: async () => ({ kind: "count", count: 0 }),
      close: async () => {
        closed = true;
      },
    };

    const db = createRawQl({ adapter });
    await db.close();

    expect(closed).toBe(true);
  });

  it("resolves configured entities", () => {
    const db = createRawQl({
      adapter: new MemoryAdapter(),
      entities: { users: { collection: "people", idField: "_id" } },
    });

    expect(db.resolveEntity("users")).toEqual({
      name: "users",
      collection: "people",
      idField: "_id",
    });
    expect(db.resolveEntity("posts")).toEqual({
      name: "posts",
      collection: "posts",
      idField: "id",
    });
  });

  it("requires an adapter", () => {
    expect(() => createRawQl({ adapter: undefined as any })).toThrow(RawLibError);
  });

  it("reports result metadata", async () => {
    const db = createRawQl({ adapter: new MemoryAdapter({ seed }) });
    const result = await db.execute({ op: "count", entity: "users" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(2);
      expect(result.meta?.adapter).toBe("memory");
      expect(result.meta?.count).toBe(2);
    }
  });
});
