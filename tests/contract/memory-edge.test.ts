import { describe, expect, it } from "vitest";
import {
  type Adapter,
  createRawQl,
  isRawLibError,
  MemoryAdapter,
  RawLibError,
  toRawLibError,
} from "../../src/index";

describe("errors", () => {
  it("serializes to a plain shape", () => {
    const error = new RawLibError("FORBIDDEN", "nope", { reason: "policy" });
    expect(error.toJSON()).toEqual({
      code: "FORBIDDEN",
      message: "nope",
      details: { reason: "policy" },
    });
    expect(new RawLibError("NOT_FOUND", "gone").toJSON()).toEqual({
      code: "NOT_FOUND",
      message: "gone",
    });
  });

  it("detects RawLibError instances", () => {
    expect(isRawLibError(new RawLibError("TIMEOUT", "slow"))).toBe(true);
    expect(isRawLibError(new Error("slow"))).toBe(false);
  });

  it("wraps unknown failures", () => {
    const wrapped = toRawLibError(new Error("boom"), "ADAPTER_ERROR");
    expect(wrapped.code).toBe("ADAPTER_ERROR");
    expect(wrapped.message).toBe("boom");
    expect(wrapped.cause).toBeInstanceOf(Error);

    const passthrough = toRawLibError(new RawLibError("CONFLICT", "dup"));
    expect(passthrough.code).toBe("CONFLICT");

    const primitive = toRawLibError("bad");
    expect(primitive.code).toBe("INTERNAL_ERROR");
    expect(primitive.message).toBe("bad");
  });
});

describe("adapter result mapping", () => {
  function makeAdapter(result: Awaited<ReturnType<Adapter["execute"]>>): Adapter {
    return {
      name: "stub",
      capabilities: new Set([
        "filter.logical",
        "filter.comparison",
        "filter.array",
        "filter.text",
        "filter.presence",
        "sort",
        "select",
        "page.offset",
        "pipeline.match",
        "pipeline.group",
        "pipeline.sort",
        "pipeline.limit",
        "pipeline.skip",
        "pipeline.project",
        "pipeline.lookup",
        "pipeline.unwind",
        "pipeline.addFields",
        "pipeline.count",
      ]),
      execute: async () => result as any,
    };
  }

  it("reports hasMore without a total", async () => {
    const db = createRawQl({
      adapter: makeAdapter({ kind: "items", items: [{ id: "1" }, { id: "2" }] }),
    });

    const result = await db.execute({
      op: "list",
      entity: "users",
      page: { limit: 2, offset: 0 },
    });

    expect(result.ok && result.meta?.page).toEqual({
      limit: 2,
      offset: 0,
      hasMore: true,
    });
  });

  it("maps single items", async () => {
    const db = createRawQl({ adapter: makeAdapter({ kind: "item", item: { id: "1" } }) });
    const result = await db.execute({ op: "get", entity: "users", where: { id: "1" } });

    expect(result.ok && result.data).toEqual({ id: "1" });
  });

  it("maps acks without an id", async () => {
    const db = createRawQl({ adapter: makeAdapter({ kind: "ack", matched: 1 }) });
    const result = await db.execute({
      op: "update",
      entity: "users",
      where: { id: "1" },
      data: { name: "A" },
    });

    expect(result.ok && result.data).toEqual({ id: null });
  });
});

describe("memory adapter edge cases", () => {
  it("seeds rows without ids and appends repeated seeds", () => {
    const adapter = new MemoryAdapter();
    adapter.seed({ users: [{ name: "A" }] });
    adapter.seed({ users: [{ name: "B", _id: "kept" }] });

    return adapter
      .execute<{ id?: string; _id?: string; name: string }>({
        op: "list",
        entity: { name: "users", collection: "users", idField: "id" },
        page: { limit: 10, offset: 0 },
      })
      .then((result) => {
        if (result.kind !== "items") throw new Error("expected items");
        expect(result.items).toHaveLength(2);
        expect(result.items[0]?.id).toBeTruthy();
        expect(result.items[1]?._id).toBe("kept");
        expect(result.total).toBe(2);
      });
  });

  it("returns an empty list for an unknown entity", async () => {
    const db = createRawQl({ adapter: new MemoryAdapter() });
    const result = await db.execute({ op: "list", entity: "ghosts" });
    expect(result.ok && result.data).toEqual([]);
  });

  it("filters with every comparison operator", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          nums: [
            { id: "1", n: 1 },
            { id: "2", n: 2 },
            { id: "3", n: 3 },
          ],
        },
      }),
    });

    const eq = await db.execute<{ id: string }[]>({ op: "list", entity: "nums", where: { n: 2 } });
    const ne = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "nums",
      where: { n: { ne: 2 } },
    });
    const gt = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "nums",
      where: { n: { gt: 1 } },
    });
    const lt = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "nums",
      where: { n: { lt: 3 } },
    });
    const lte = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "nums",
      where: { n: { lte: 2 } },
    });

    expect(eq.ok && eq.data.map((row) => row.id)).toEqual(["2"]);
    expect(ne.ok && ne.data.map((row) => row.id).sort()).toEqual(["1", "3"]);
    expect(gt.ok && gt.data.map((row) => row.id).sort()).toEqual(["2", "3"]);
    expect(lt.ok && lt.data.map((row) => row.id).sort()).toEqual(["1", "2"]);
    expect(lte.ok && lte.data.map((row) => row.id).sort()).toEqual(["1", "2"]);
  });

  it("filters with nin, contains, and startsWith", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          docs: [
            { id: "1", title: "Alpha", tag: "a" },
            { id: "2", title: "Beta", tag: "b" },
            { id: "3", title: "Gamma", tag: "c" },
          ],
        },
      }),
    });

    const nin = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "docs",
      where: { tag: { nin: ["a", "b"] } },
    });
    const contains = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "docs",
      where: { title: { contains: "MM" } },
    });
    const starts = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "docs",
      where: { title: { startsWith: "al" } },
    });

    expect(nin.ok && nin.data.map((row) => row.id)).toEqual(["3"]);
    expect(contains.ok && contains.data.map((row) => row.id)).toEqual(["3"]);
    expect(starts.ok && starts.data.map((row) => row.id)).toEqual(["1"]);
  });

  it("filters with exists false and non-null checks", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          docs: [{ id: "1", note: "x" }, { id: "2" }, { id: "3", note: null }],
        },
      }),
    });

    const missing = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "docs",
      where: { note: { exists: false } },
    });
    const nonNull = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "docs",
      where: { note: { isNull: false } },
    });

    expect(missing.ok && missing.data.map((row) => row.id)).toEqual(["2"]);
    expect(nonNull.ok && nonNull.data.map((row) => row.id)).toEqual(["1"]);
  });

  it("filters on dotted fields and non-string text values", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          docs: [
            { id: "1", profile: { city: "Paris" }, code: 1234 },
            { id: "2", profile: { city: "Berlin" }, code: 9 },
          ],
        },
      }),
    });

    const nested = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "docs",
      where: { "profile.city": { endsWith: "ris" } },
    });
    const nonString = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "docs",
      where: { code: { contains: "23" } },
    });

    expect(nested.ok && nested.data.map((row) => row.id)).toEqual(["1"]);
    expect(nonString.ok && nonString.data).toEqual([]);
  });

  it("supports select on dotted fields", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({ seed: { docs: [{ id: "1", profile: { city: "Paris" } }] } }),
    });

    const result = await db.execute({ op: "list", entity: "docs", select: ["id", "profile.city"] });

    expect(result.ok && result.data).toEqual([{ id: "1", profile: { city: "Paris" } }]);
  });

  it("keeps explicitly provided ids on create", async () => {
    const db = createRawQl({ adapter: new MemoryAdapter() });
    const result = await db.execute<{ id: string }>({
      op: "create",
      entity: "users",
      data: { id: "custom" },
    });

    expect(result.ok && result.data.id).toBe("custom");
  });

  it("generates ids for empty-string ids", async () => {
    const db = createRawQl({ adapter: new MemoryAdapter() });
    const result = await db.execute<{ id: string }>({
      op: "create",
      entity: "users",
      data: { id: "" } as any,
    });

    expect(result.ok && result.data.id).not.toBe("");
  });

  it("rejects non-object create payloads", async () => {
    const db = createRawQl({ adapter: new MemoryAdapter() });
    const result = await db.execute({
      op: "create",
      entity: "users",
      data: [1] as any,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("updates every matching row when using where", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          users: [
            { id: "1", role: "admin", active: false },
            { id: "2", role: "admin", active: false },
            { id: "3", role: "member", active: false },
          ],
        },
      }),
    });

    const result = await db.execute({
      op: "update",
      entity: "users",
      where: { role: "admin" },
      data: { active: true },
    });
    const users = await db.execute<{ id: string; active: boolean }[]>({
      op: "list",
      entity: "users",
      where: { active: true },
    });

    expect(result.ok).toBe(true);
    expect(users.ok && users.data.map((row) => row.id).sort()).toEqual(["1", "2"]);
  });

  it("deletes every matching row when using where", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          users: [
            { id: "1", role: "admin" },
            { id: "2", role: "admin" },
            { id: "3", role: "member" },
          ],
        },
      }),
    });

    const result = await db.execute({ op: "delete", entity: "users", where: { role: "admin" } });
    const count = await db.execute<number>({ op: "count", entity: "users" });

    expect(result.ok).toBe(true);
    expect(count.ok && count.data).toBe(1);
  });

  it("sorts by a second field when the first ties", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          users: [
            { id: "1", role: "admin", name: "Zed" },
            { id: "2", role: "admin", name: "Ada" },
            { id: "3", role: "member", name: "Bob" },
          ],
        },
      }),
    });

    const result = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "users",
      sort: [
        { field: "role", direction: "asc" },
        { field: "name", direction: "asc" },
      ],
    });

    expect(result.ok && result.data.map((row) => row.id)).toEqual(["2", "1", "3"]);
  });

  it("keeps original order when sort values are not comparable", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          docs: [
            { id: "1", value: { nested: true } },
            { id: "2", value: { nested: true } },
          ],
        },
      }),
    });

    const result = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "docs",
      sort: { value: "asc" },
    });

    expect(result.ok && result.data.map((row) => row.id)).toEqual(["1", "2"]);
  });

  it("groups by multiple fields and aggregates numbers", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          users: [
            { id: "1", role: "admin", plan: "pro", age: 30, score: 10 },
            { id: "2", role: "admin", plan: "pro", age: 50, score: 20 },
            { id: "3", role: "member", plan: "free", age: 20, score: "x" },
          ],
        },
      }),
    });

    const result = await db.execute<
      {
        _id: Record<string, unknown>;
        total: number;
        sum: number;
        avg: number;
        min: unknown;
        max: unknown;
      }[]
    >({
      op: "aggregate",
      entity: "users",
      pipeline: [
        {
          $group: {
            by: { role: "role", plan: "plan" },
            fields: {
              total: { op: "count" },
              sum: { op: "sum", field: "score" },
              avg: { op: "avg", field: "age" },
              min: { op: "min", field: "age" },
              max: { op: "max", field: "age" },
            },
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data.find((row) => row._id.role === "admin")).toMatchObject({
        total: 2,
        sum: 30,
        avg: 40,
        min: 30,
        max: 50,
      });
      expect(result.data.find((row) => row._id.role === "member")).toMatchObject({
        total: 1,
        sum: 0,
        avg: 20,
        min: 20,
        max: 20,
      });
    }
  });

  it("returns null aggregates for non-numeric fields", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({ seed: { docs: [{ id: "1", label: "a" }] } }),
    });

    const result = await db.execute<
      { avg: number | null; min: number | null; max: number | null }[]
    >({
      op: "aggregate",
      entity: "docs",
      pipeline: [
        {
          $group: {
            by: "label",
            fields: {
              avg: { op: "avg", field: "missing" },
              min: { op: "min", field: "missing" },
              max: { op: "max", field: "missing" },
            },
          },
        },
      ],
    });

    expect(result.ok && result.data).toEqual([{ _id: "a", avg: null, min: null, max: null }]);
  });

  it("projects exclusions and limits/skips", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          docs: [
            { id: "1", name: "A", secret: "x" },
            { id: "2", name: "B", secret: "y" },
            { id: "3", name: "C", secret: "z" },
          ],
        },
      }),
    });

    const result = await db.execute<{ id: string; name: string }[]>({
      op: "aggregate",
      entity: "docs",
      pipeline: [
        { $sort: { id: "asc" } },
        { $skip: 1 },
        { $limit: 1 },
        { $project: { secret: 0 } },
      ],
    });

    expect(result.ok && result.data).toEqual([{ id: "2", name: "B" }]);
  });

  it("counts an empty pipeline result", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({ seed: { docs: [{ id: "1", active: false }] } }),
    });

    const result = await db.execute<{ total: number }[]>({
      op: "aggregate",
      entity: "docs",
      pipeline: [{ $match: { active: true } }, { $count: "total" }],
    });

    expect(result.ok && result.data).toEqual([{ total: 0 }]);
  });

  it("unwinds with preserveNullAndEmptyArrays", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          docs: [
            { id: "1", tags: [] },
            { id: "2", tags: null },
            { id: "3", tags: ["a", "b"] },
            { id: "4", tags: "solo" },
          ],
        },
      }),
    });

    const result = await db.execute<{ id: string; tags?: string }[]>({
      op: "aggregate",
      entity: "docs",
      pipeline: [
        { $unwind: { path: "tags", preserveNullAndEmptyArrays: true } },
        { $sort: { id: "asc" } },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((row) => row.id)).toEqual(["1", "2", "3", "3", "4"]);
      expect(result.data[0]).toEqual({ id: "1" });
      expect(result.data[1]).toEqual({ id: "2", tags: null });
    }
  });

  it("drops empty arrays when not preserving", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          docs: [
            { id: "1", tags: [] },
            { id: "2", tags: null },
          ],
        },
      }),
    });

    const result = await db.execute({
      op: "aggregate",
      entity: "docs",
      pipeline: [{ $unwind: "tags" }],
    });

    expect(result.ok && result.data).toEqual([]);
  });

  it("applies nested pipelines during lookup", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({
        seed: {
          users: [{ id: "1" }],
          posts: [
            { id: "p1", userId: "1", published: true },
            { id: "p2", userId: "1", published: false },
          ],
        },
      }),
    });

    const result = await db.execute<{ id: string; posts: { id: string }[] }[]>({
      op: "aggregate",
      entity: "users",
      pipeline: [
        {
          $lookup: {
            from: "posts",
            localField: "id",
            foreignField: "userId",
            as: "posts",
            pipeline: [{ $match: { published: true } }],
          },
        },
      ],
    });

    expect(result.ok && result.data[0]?.posts).toEqual([
      { id: "p1", userId: "1", published: true },
    ]);
  });

  it("adds nested fields", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({ seed: { docs: [{ id: "1", meta: { a: 1 } }] } }),
    });

    const result = await db.execute<{ id: string; meta: { b: number } }[]>({
      op: "aggregate",
      entity: "docs",
      pipeline: [{ $addFields: { "meta.b": 2 } }],
    });

    expect(result.ok && result.data[0]?.meta).toEqual({ a: 1, b: 2 });
  });

  it("supports update data validation inside the adapter", async () => {
    const adapter = new MemoryAdapter({ seed: { docs: [{ id: "1" }] } });

    await expect(
      adapter.execute({
        op: "update",
        entity: { name: "docs", collection: "docs", idField: "id" },
        where: { kind: "comparison", field: "id", op: "eq", value: "1" },
        data: "nope",
      }),
    ).rejects.toBeInstanceOf(RawLibError);
  });
});
