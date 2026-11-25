import { describe, expect, it } from "vitest";
import {
  capRows,
  describeEntityFields,
  guardQuery,
  normalizePolicy,
  pipelineStageCount,
  redactRows,
  rowCount,
} from "../../src/agent/policy";

const entities = {
  users: {
    description: "Customer accounts",
    fields: {
      id: { type: "string" },
      email: { type: "string" },
      passwordHash: { type: "string", sensitive: true },
      profile: { type: "object" },
    },
  },
  orders: {
    fields: {
      id: { type: "string" },
      userId: { type: "string" },
      total: { type: "number" },
    },
  },
};

async function guard(query: unknown, policy = normalizePolicy({}, entities), context = {}) {
  return guardQuery(query, policy, context);
}

describe("normalizePolicy", () => {
  it("defaults to read-only access over configured entities", () => {
    const policy = normalizePolicy({}, entities);

    expect([...policy.allowOps]).toEqual(["list", "get", "count", "aggregate"]);
    expect(policy.allowEntities).toEqual(new Set(["users", "orders"]));
    expect(policy.maxLimit).toBe(50);
    expect(policy.maxPipelineStages).toBe(6);
    expect(policy.requireApproval).toEqual(new Set(["create", "update", "delete"]));
    expect(policy.budget).toEqual({ maxToolCalls: 8, maxTokens: 20_000 });
  });

  it("allows every entity when none are configured", () => {
    expect(normalizePolicy({}).allowEntities).toBe("*");
  });

  it("treats sensitive fields as denied", () => {
    expect(normalizePolicy({}, entities).denyFields.users).toEqual(["passwordHash"]);
  });

  it("rejects invalid configuration", () => {
    expect(() => normalizePolicy({ maxLimit: 0 })).toThrow(/maxLimit/);
    expect(() => normalizePolicy({ allowOps: ["nope" as never] })).toThrow(/operation/);
    expect(() =>
      normalizePolicy({
        denyFields: { users: ["email"] },
        redactFields: { users: ["email"] },
      }),
    ).toThrow(/both denied and redacted/);
  });
});

describe("guardQuery", () => {
  it("rejects writes by default", async () => {
    const result = await guard({ op: "delete", entity: "users", where: { id: "u1" } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("rejects unknown operations, operators, and entities", async () => {
    const op = await guard({ op: "upsert", entity: "users" });
    const operator = await guard({
      op: "list",
      entity: "users",
      where: { email: { regex: "a" } },
    });
    const entity = await guard({ op: "list", entity: "secrets" });

    expect(op.ok).toBe(false);
    expect(operator.ok).toBe(false);
    expect(entity.ok).toBe(false);
    if (!entity.ok) expect(entity.error.code).toBe("FORBIDDEN");
  });

  it("rejects denied fields in filters, selects, sorts, and pipelines", async () => {
    const policy = normalizePolicy(
      {
        denyFields: { users: ["email"], orders: ["userId"] },
      },
      entities,
    );

    const where = await guard({ op: "list", entity: "users", where: { email: "a@b.co" } }, policy);
    const select = await guard({ op: "list", entity: "users", select: ["id", "email"] }, policy);
    const sort = await guard({ op: "list", entity: "users", sort: { email: "asc" } }, policy);
    const project = await guard(
      {
        op: "aggregate",
        entity: "orders",
        pipeline: [{ $project: { userId: 1 } }],
      },
      policy,
    );

    for (const result of [where, select, sort, project]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("rejects nested fields when a parent is denied", async () => {
    const policy = normalizePolicy({ denyFields: { users: ["profile"] } }, entities);
    const result = await guard(
      { op: "list", entity: "users", where: { "profile.email": "a@b.co" } },
      policy,
    );

    expect(result.ok).toBe(false);
  });

  it("clamps list limits and fills a default limit", async () => {
    const policy = normalizePolicy({ maxLimit: 25 }, entities);
    const clamped = await guard({ op: "list", entity: "users", page: { limit: 500 } }, policy);
    const defaulted = await guard({ op: "list", entity: "users" }, policy);

    expect(clamped.ok).toBe(true);
    if (clamped.ok) {
      expect(clamped.data.query.page?.limit).toBe(25);
      expect(clamped.data.decisions).toContain("Clamped limit from 500 to 25");
    }

    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) expect(defaulted.data.query.page?.limit).toBe(25);
  });

  it("rejects invalid page values", async () => {
    const zero = await guard({ op: "list", entity: "users", page: { limit: 0 } });
    const offset = await guard({ op: "list", entity: "users", page: { offset: -1 } });

    expect(zero.ok).toBe(false);
    expect(offset.ok).toBe(false);
  });

  it("limits pipeline depth and rejects unsupported stages", async () => {
    const policy = normalizePolicy({ maxPipelineStages: 2 }, entities);
    const deep = await guard(
      {
        op: "aggregate",
        entity: "users",
        pipeline: [{ $limit: 1 }, { $skip: 0 }, { $limit: 2 }],
      },
      policy,
    );
    const stage = await guard(
      {
        op: "aggregate",
        entity: "users",
        pipeline: [{ $out: "stolen" }],
      },
      policy,
    );

    expect(deep.ok).toBe(false);
    expect(stage.ok).toBe(false);
  });

  it("restricts lookup targets to allowed entities", async () => {
    const policy = normalizePolicy({ allowEntities: ["users"] }, entities);
    const result = await guard(
      {
        op: "aggregate",
        entity: "users",
        pipeline: [
          {
            $lookup: {
              from: "orders",
              localField: "id",
              foreignField: "userId",
              as: "orders",
            },
          },
        ],
      },
      policy,
    );

    expect(result.ok).toBe(false);
  });

  it("injects tenant scope into filters and pipelines", async () => {
    const policy = normalizePolicy(
      {
        tenantScope: (context) => ({ tenantId: context.tenant }),
      },
      entities,
    );

    const list = await guard({ op: "list", entity: "users", where: { email: "a@b.co" } }, policy, {
      tenant: "t1",
    });
    const pipeline = await guard(
      { op: "aggregate", entity: "orders", pipeline: [{ $limit: 5 }] },
      policy,
      { tenant: "t1" },
    );

    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.query.where).toEqual({
        $and: [{ tenantId: "t1" }, { email: "a@b.co" }],
      });
      expect(list.data.decisions).toContain("Injected tenant scope into the filter");
    }

    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      expect(pipeline.data.query.pipeline?.[0]).toEqual({ $match: { tenantId: "t1" } });
      expect(pipeline.data.decisions).toContain("Injected tenant scope into the pipeline");
    }
  });

  it("marks writes as requiring approval", async () => {
    const policy = normalizePolicy({ allowOps: ["update"], requireApproval: ["update"] }, entities);
    const result = await guard(
      { op: "update", entity: "users", where: { id: "u1" }, data: { email: "new@b.co" } },
      policy,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.requiresApproval).toBe(true);
  });

  it("validates where shape", async () => {
    const notObject = await guard({ op: "list", entity: "users", where: "email" });
    const badAnd = await guard({
      op: "list",
      entity: "users",
      where: { $and: { email: "a@b.co" } },
    });

    expect(notObject.ok).toBe(false);
    expect(badAnd.ok).toBe(false);
  });
});

describe("redaction and result helpers", () => {
  it("redacts nested fields without mutating the input", () => {
    const input = [
      { id: "u1", email: "ada@acme.com", profile: { email: "ada@acme.com", name: "Ada" } },
    ];

    const output = redactRows(input, ["email", "profile.email"]);

    expect(output).toEqual([
      { id: "u1", email: "[redacted]", profile: { email: "[redacted]", name: "Ada" } },
    ]);
    expect(input[0]?.email).toBe("ada@acme.com");
  });

  it("counts rows and caps oversized results", () => {
    expect(rowCount([1, 2, 3])).toBe(3);
    expect(rowCount(7)).toBe(7);
    expect(rowCount(null)).toBe(0);
    expect(rowCount({ id: "u1" })).toBe(1);

    expect(capRows([1, 2, 3], 2)).toEqual({ value: [1, 2], truncated: true });
    expect(capRows([1], 2)).toEqual({ value: [1], truncated: false });
  });

  it("hides denied and sensitive fields from descriptions", () => {
    const policy = normalizePolicy({ denyFields: { users: ["email"] } }, entities);
    const fields = describeEntityFields(entities.users, undefined, policy, "users");

    expect(fields.id).toBeDefined();
    expect(fields.email).toBeUndefined();
    expect(fields.passwordHash).toBeUndefined();
    expect(fields.profile).toBeDefined();
  });

  it("infers fields from a sample", () => {
    const policy = normalizePolicy({}, entities);
    const fields = describeEntityFields(undefined, { id: "u1", active: true }, policy, "users");

    expect(fields).toEqual({ id: { type: "string" }, active: { type: "boolean" } });
  });
});

describe("guardQuery edge cases", () => {
  it("rejects unsupported filter keys and malformed logical groups", async () => {
    const cases = [
      { op: "list", entity: "users", where: { $where: "true" } },
      { op: "list", entity: "users", where: { $and: { email: "a@b.co" } } },
      { op: "list", entity: "users", where: { $or: [null] } },
      { op: "list", entity: "users", where: { $not: { email: { regex: "a" } } } },
    ];

    for (const query of cases) {
      const result = await guard(query);
      expect(result.ok).toBe(false);
    }
  });

  it("accepts and validates sort arrays and select lists", async () => {
    const valid = await guard({
      op: "list",
      entity: "users",
      sort: [{ field: "id", direction: "asc" }],
      select: ["id", "email"],
    });
    const badDirection = await guard({
      op: "list",
      entity: "users",
      sort: [{ field: "id", direction: "up" }],
    });
    const badEntry = await guard({ op: "list", entity: "users", sort: [{ field: 1 }] });
    const badSort = await guard({ op: "list", entity: "users", sort: "id" });
    const badSelect = await guard({ op: "list", entity: "users", select: "id" });
    const badField = await guard({ op: "list", entity: "users", select: [1] });

    expect(valid.ok).toBe(true);
    for (const result of [badDirection, badEntry, badSort, badSelect, badField]) {
      expect(result.ok).toBe(false);
    }
  });

  it("validates aggregation stages", async () => {
    const policy = normalizePolicy({ maxPipelineStages: 8 }, entities);
    const valid = await guard(
      {
        op: "aggregate",
        entity: "orders",
        pipeline: [
          { $match: { total: { gte: 10 } } },
          {
            $group: { by: { status: "status", userId: "userId" }, fields: { n: { op: "count" } } },
          },
          { $sort: [{ field: "n", direction: "desc" }] },
          { $unwind: "items" },
          { $unwind: { path: "items" } },
          { $addFields: { flagged: true } },
          { $count: "total" },
        ],
      },
      policy,
    );

    expect(valid.ok).toBe(true);

    const invalid = [
      {
        op: "aggregate",
        entity: "orders",
        pipeline: [{ $group: { by: 1, fields: { n: { op: "count" } } } }],
      },
      {
        op: "aggregate",
        entity: "orders",
        pipeline: [{ $group: { by: "status", fields: { n: { op: "nope" } } } }],
      },
      {
        op: "aggregate",
        entity: "orders",
        pipeline: [{ $group: { by: "status", fields: { n: "sum" } } }],
      },
      { op: "aggregate", entity: "orders", pipeline: [{ $limit: -1 }] },
      { op: "aggregate", entity: "orders", pipeline: [{ $skip: 1.5 }] },
      { op: "aggregate", entity: "orders", pipeline: [{ $unwind: 1 }] },
      { op: "aggregate", entity: "orders", pipeline: [{ $addFields: "x" }] },
      { op: "aggregate", entity: "orders", pipeline: [{ $count: "" }] },
      { op: "aggregate", entity: "orders", pipeline: [{ $lookup: { from: "users" } }] },
      {
        op: "aggregate",
        entity: "orders",
        pipeline: [
          {
            $lookup: {
              from: "users",
              localField: "userId",
              foreignField: "id",
              as: "u",
              pipeline: [{ $out: "x" }],
            },
          },
        ],
      },
    ];

    for (const query of invalid) {
      const result = await guard(query, policy);
      expect(result.ok).toBe(false);
    }
  });

  it("validates write data fields", async () => {
    const policy = normalizePolicy(
      { allowOps: ["update", "create"], denyFields: { users: ["email"] } },
      entities,
    );

    const notObject = await guard(
      { op: "update", entity: "users", where: { id: "u1" }, data: "name" },
      policy,
    );
    const denied = await guard(
      { op: "update", entity: "users", where: { id: "u1" }, data: { email: "x@y.co" } },
      policy,
    );
    const arrayDenied = await guard(
      { op: "create", entity: "users", data: [{ name: "A" }, { email: "x@y.co" }] },
      policy,
    );

    expect(notObject.ok).toBe(false);
    expect(denied.ok).toBe(false);
    expect(arrayDenied.ok).toBe(false);
  });

  it("rejects invalid tenant scopes and injects into empty filters", async () => {
    const invalid = normalizePolicy({ tenantScope: (() => "t1") as never }, entities);
    const result = await guard({ op: "list", entity: "users" }, invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");

    const scoped = normalizePolicy(
      { tenantScope: (context) => ({ tenantId: context.tenant }) },
      entities,
    );
    const empty = await guard({ op: "list", entity: "users" }, scoped, { tenant: "t1" });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data.query.where).toEqual({ tenantId: "t1" });
  });

  it("counts nested pipeline stages", () => {
    expect(pipelineStageCount(undefined)).toBe(0);
    expect(
      pipelineStageCount([
        { $match: { id: "u1" } },
        {
          $lookup: {
            from: "orders",
            localField: "id",
            foreignField: "userId",
            as: "orders",
            pipeline: [{ $match: { status: "paid" } }, { $limit: 2 }],
          },
        },
      ]),
    ).toBe(4);
  });

  it("redacts through nested arrays", () => {
    const input = [{ id: "u1", profile: [{ email: "a@b.co" }, { email: "c@d.co" }] }];
    const output = redactRows(input, ["profile.email"]);

    expect(output).toEqual([
      { id: "u1", profile: [{ email: "[redacted]" }, { email: "[redacted]" }] },
    ]);
  });
});
