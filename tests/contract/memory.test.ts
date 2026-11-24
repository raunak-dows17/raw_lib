import { describe, expect, it } from "vitest";
import { createRawQl, MemoryAdapter } from "../../src/index";

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  age: number;
  tags?: string[];
  plan?: string;
  tenantId?: string;
  deletedAt?: string | null;
};

type Post = { id: string; userId: string; title: string };

const seed = {
  users: [
    {
      id: "u1",
      name: "Ada",
      email: "ada@acme.com",
      role: "admin",
      age: 36,
      tags: ["db", "ai"],
      plan: "pro",
      tenantId: "t1",
      deletedAt: "2024-01-01",
    },
    {
      id: "u2",
      name: "Linus",
      email: "linus@kernel.org",
      role: "member",
      age: 54,
      tags: ["os"],
      plan: "team",
      tenantId: "t1",
    },
    {
      id: "u3",
      name: "Grace",
      email: "grace@navy.mil",
      role: "admin",
      age: 45,
      tags: ["compiler"],
      plan: "pro",
      tenantId: "t2",
    },
  ],
  posts: [
    { id: "p1", userId: "u1", title: "Hello" },
    { id: "p2", userId: "u1", title: "World" },
    { id: "p3", userId: "u2", title: "Kernel" },
  ],
};

function makeDb() {
  return createRawQl({ adapter: new MemoryAdapter({ seed }) });
}

describe("MemoryAdapter contract", () => {
  it("lists all rows with pagination metadata", async () => {
    const db = makeDb();
    const result = await db.execute<User[]>({ op: "list", entity: "users" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(3);
      expect(result.meta?.page).toMatchObject({
        limit: 20,
        offset: 0,
        total: 3,
        hasMore: false,
      });
    }
  });

  it("filters with equality", async () => {
    const db = makeDb();
    const result = await db.execute<User[]>({
      op: "list",
      entity: "users",
      where: { role: "admin" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((user) => user.id).sort()).toEqual(["u1", "u3"]);
    }
  });

  it("filters with comparison operators", async () => {
    const db = makeDb();
    const result = await db.execute<User[]>({
      op: "list",
      entity: "users",
      where: { age: { gte: 45 } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((user) => user.id).sort()).toEqual(["u2", "u3"]);
    }
  });

  it("filters with text operators", async () => {
    const db = makeDb();
    const result = await db.execute<User[]>({
      op: "list",
      entity: "users",
      where: { email: { endsWith: "@ACME.com" } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((user) => user.id)).toEqual(["u1"]);
    }
  });

  it("filters with array operators", async () => {
    const db = makeDb();
    const result = await db.execute<User[]>({
      op: "list",
      entity: "users",
      where: { role: { in: ["member"] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((user) => user.id)).toEqual(["u2"]);
    }
  });

  it("filters with logical operators", async () => {
    const db = makeDb();
    const result = await db.execute<User[]>({
      op: "list",
      entity: "users",
      where: { $or: [{ role: "admin" }, { age: { lt: 40 } }] },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((user) => user.id).sort()).toEqual(["u1", "u3"]);
    }
  });

  it("filters with presence operators", async () => {
    const db = makeDb();
    const present = await db.execute<User[]>({
      op: "list",
      entity: "users",
      where: { plan: { exists: true } },
    });
    const missing = await db.execute<User[]>({
      op: "list",
      entity: "users",
      where: { deletedAt: null },
    });

    expect(present.ok && present.data).toHaveLength(3);
    expect(missing.ok && missing.data.map((user) => user.id).sort()).toEqual(["u2", "u3"]);
  });

  it("sorts, selects, and paginates", async () => {
    const db = makeDb();
    const result = await db.execute<Pick<User, "id" | "age">[]>({
      op: "list",
      entity: "users",
      sort: { age: "desc" },
      select: ["id", "age"],
      page: { limit: 2, offset: 0 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((user) => user.id)).toEqual(["u2", "u3"]);
      expect(result.data[0]).toEqual({ id: "u2", age: 54 });
      expect(result.meta?.page).toMatchObject({
        limit: 2,
        offset: 0,
        total: 3,
        hasMore: true,
      });
    }
  });

  it("puts nulls last when sorting", async () => {
    const db = makeDb();
    const result = await db.execute<User[]>({
      op: "list",
      entity: "users",
      sort: { deletedAt: "asc" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0]?.id).toBe("u1");
    }
  });

  it("gets by id and returns null when missing", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const found = await users.get({ id: "u1" });
    const missing = await users.get({ id: "nope" });

    expect(found.ok && found.data?.name).toBe("Ada");
    expect(missing.ok && missing.data).toBeNull();
  });

  it("creates one row and generates an id", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.create({
      data: { name: "Margaret", email: "m@nasa.gov", role: "member", age: 30 },
    });

    expect(result.ok).toBe(true);
    if (result.ok && !Array.isArray(result.data)) {
      expect(result.data.id).toBeTruthy();
      expect(result.data.name).toBe("Margaret");
    }
  });

  it("creates many rows", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.create({
      data: [
        { name: "A", email: "a@a.com", role: "member", age: 20 },
        { name: "B", email: "b@b.com", role: "member", age: 21 },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok && Array.isArray(result.data)) {
      expect(result.data).toHaveLength(2);
      expect(result.data.every((user) => user.id)).toBe(true);
    }
  });

  it("updates matching rows", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const updated = await users.update({ id: "u1", data: { age: 37 } });
    const found = await users.get({ id: "u1" });

    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.data.id).toBe("u1");
    expect(found.ok && found.data?.age).toBe(37);
  });

  it("does not change the id on update", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    await users.update({ id: "u1", data: { id: "hacked" } } as any);
    const found = await users.get({ id: "u1" });

    expect(found.ok && found.data?.id).toBe("u1");
  });

  it("returns NOT_FOUND when updating nothing", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.update({ id: "nope", data: { age: 1 } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("deletes matching rows", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const deleted = await users.delete({ id: "u3" });
    const count = await users.count();

    expect(deleted.ok).toBe(true);
    expect(count.ok && count.data).toBe(2);
  });

  it("returns NOT_FOUND when deleting nothing", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.delete({ id: "nope" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("counts with filters", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.count({ where: { role: "admin" } });

    expect(result.ok && result.data).toBe(2);
  });

  it("groups and aggregates", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.aggregate<{ _id: string; total: number; averageAge: number }>({
      pipeline: [
        {
          $group: {
            by: "role",
            fields: { total: { op: "count" }, averageAge: { op: "avg", field: "age" } },
          },
        },
        { $sort: { total: "desc" } },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data.find((row) => row._id === "admin")).toMatchObject({
        total: 2,
        averageAge: 40.5,
      });
    }
  });

  it("matches and counts in a pipeline", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.aggregate<{ total: number }>({
      pipeline: [{ $match: { role: "admin" } }, { $count: "total" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([{ total: 2 }]);
    }
  });

  it("unwinds arrays", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.aggregate<{ id: string; tags: string }>({
      pipeline: [{ $unwind: "tags" }, { $sort: { id: "asc" } }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(4);
      expect(result.data[0]).toMatchObject({ id: "u1", tags: "db" });
    }
  });

  it("looks up related rows", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.aggregate<{ id: string; posts: Post[] }>({
      pipeline: [
        { $lookup: { from: "posts", localField: "id", foreignField: "userId", as: "posts" } },
        { $sort: { id: "asc" } },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0]?.posts).toHaveLength(2);
      expect(result.data[2]?.posts).toHaveLength(0);
    }
  });

  it("projects fields", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.aggregate<{ name: string }>({
      pipeline: [{ $project: { name: 1 } }, { $sort: { name: "asc" } }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0]).toEqual({ name: "Ada" });
      expect(Object.keys(result.data[0] as object)).toEqual(["name"]);
    }
  });

  it("adds fields", async () => {
    const db = makeDb();
    const users = db.entity<User>("users");

    const result = await users.aggregate<{ id: string; active: boolean }>({
      pipeline: [{ $addFields: { active: true } }, { $limit: 1 }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0]?.active).toBe(true);
    }
  });

  it("returns validation errors for malformed queries", async () => {
    const db = makeDb();
    const result = await db.execute({ op: "get", entity: "users" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
