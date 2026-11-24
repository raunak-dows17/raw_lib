import { describe, expect, it } from "vitest";
import { createRawQl, MemoryAdapter, RawLibError } from "../../src/index";

type User = { id: string; name: string; role: string; age: number };

const seed = {
  users: [
    { id: "u1", name: "Ada", role: "admin", age: 36 },
    { id: "u2", name: "Linus", role: "member", age: 54 },
    { id: "u3", name: "Grace", role: "admin", age: 45 },
  ],
};

function makeUsers() {
  return createRawQl({ adapter: new MemoryAdapter({ seed }) }).entity<User>("users");
}

describe("EntityClient", () => {
  it("lists with filters, sort, select, and paging", async () => {
    const users = makeUsers();
    const result = await users.list({
      where: { role: "admin" },
      sort: { age: "desc" },
      select: ["id", "name"],
      page: { limit: 1, offset: 0 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([{ id: "u3", name: "Grace" }]);
      expect(result.meta?.page).toMatchObject({ limit: 1, offset: 0, total: 2, hasMore: true });
    }
  });

  it("gets by id or by where", async () => {
    const users = makeUsers();

    const byId = await users.get({ id: "u1" });
    const byWhere = await users.get({ where: { name: "Linus" } });

    expect(byId.ok && byId.data?.id).toBe("u1");
    expect(byWhere.ok && byWhere.data?.id).toBe("u2");
  });

  it("throws when neither id nor where is provided", () => {
    const users = makeUsers();
    expect(() => users.get({} as any)).toThrow(RawLibError);
    expect(() => users.update({ data: { age: 1 } } as any)).toThrow(RawLibError);
    expect(() => users.delete({} as any)).toThrow(RawLibError);
  });

  it("updates by where", async () => {
    const users = makeUsers();
    const result = await users.update({ where: { role: "admin" }, data: { age: 40 } });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.id).toBe("u1");
  });

  it("deletes by where", async () => {
    const users = makeUsers();
    const result = await users.delete({ where: { role: "member" } });
    const count = await users.count();

    expect(result.ok).toBe(true);
    expect(count.ok && count.data).toBe(2);
  });

  it("counts without a filter", async () => {
    const users = makeUsers();
    const result = await users.count();
    expect(result.ok && result.data).toBe(3);
  });

  it("aggregates", async () => {
    const users = makeUsers();
    const result = await users.aggregate<{ _id: string; total: number }>({
      pipeline: [{ $group: { by: "role", fields: { total: { op: "count" } } } }],
    });

    expect(result.ok && result.data).toHaveLength(2);
  });
});
