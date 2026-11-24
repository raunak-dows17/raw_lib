import { describe, expect, it } from "vitest";
import { compilePipeline } from "../../src/core/compiler/pipeline";
import { normalizeQuery } from "../../src/core/compiler/query";
import { compileSort } from "../../src/core/compiler/sort";
import { compileWhere } from "../../src/core/compiler/where";
import { RawLibError } from "../../src/core/errors";

const entity = { name: "users", collection: "users", idField: "id" };

function expectRawLibError(fn: () => unknown, code = "VALIDATION_FAILED") {
  try {
    fn();
    throw new Error("Expected a RawLibError");
  } catch (error) {
    expect(error).toBeInstanceOf(RawLibError);
    expect((error as RawLibError).code).toBe(code);
  }
}

describe("compileWhere", () => {
  it("compiles shorthand equality", () => {
    expect(compileWhere({ role: "admin" })).toEqual({
      kind: "comparison",
      field: "role",
      op: "eq",
      value: "admin",
    });
  });

  it("compiles comparison operators", () => {
    expect(compileWhere({ age: { gte: 18, lt: 65 } })).toEqual({
      kind: "and",
      clauses: [
        { kind: "comparison", field: "age", op: "gte", value: 18 },
        { kind: "comparison", field: "age", op: "lt", value: 65 },
      ],
    });
  });

  it("compiles array operators", () => {
    expect(compileWhere({ role: { in: ["admin", "owner"] } })).toEqual({
      kind: "array",
      field: "role",
      op: "in",
      value: ["admin", "owner"],
    });
  });

  it("compiles text operators", () => {
    expect(compileWhere({ email: { endsWith: "@acme.com" } })).toEqual({
      kind: "text",
      field: "email",
      op: "endsWith",
      value: "@acme.com",
    });
  });

  it("compiles null as isNull", () => {
    expect(compileWhere({ deletedAt: null })).toEqual({
      kind: "presence",
      field: "deletedAt",
      op: "isNull",
      value: true,
    });
  });

  it("compiles logical operators", () => {
    expect(compileWhere({ $or: [{ role: "admin" }, { role: "owner" }] })).toEqual({
      kind: "or",
      clauses: [
        { kind: "comparison", field: "role", op: "eq", value: "admin" },
        { kind: "comparison", field: "role", op: "eq", value: "owner" },
      ],
    });
  });

  it("compiles nested logical operators", () => {
    expect(
      compileWhere<Record<string, unknown>>({
        $and: [{ role: "admin" }, { $not: { status: "banned" } }],
      }),
    ).toEqual({
      kind: "and",
      clauses: [
        { kind: "comparison", field: "role", op: "eq", value: "admin" },
        { kind: "not", clause: { kind: "comparison", field: "status", op: "eq", value: "banned" } },
      ],
    });
  });

  it("returns undefined for an empty filter", () => {
    expect(compileWhere({})).toBeUndefined();
    expect(compileWhere(undefined)).toBeUndefined();
  });

  it("rejects invalid operands", () => {
    expectRawLibError(() => compileWhere({ role: { in: "admin" } }));
    expectRawLibError(() => compileWhere({ email: { contains: 1 } }));
    expectRawLibError(() => compileWhere({ active: { exists: "yes" } }));
  });

  it("rejects unknown logical operators", () => {
    expectRawLibError(() => compileWhere({ $foo: [] } as any));
  });
});

describe("compileSort", () => {
  it("compiles object sort", () => {
    expect(compileSort({ createdAt: "desc", id: "asc" })).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "id", direction: "asc" },
    ]);
  });

  it("compiles array sort", () => {
    expect(compileSort([{ field: "name", direction: "asc" }])).toEqual([
      { field: "name", direction: "asc" },
    ]);
  });

  it("returns undefined for empty sort", () => {
    expect(compileSort({})).toBeUndefined();
    expect(compileSort(undefined)).toBeUndefined();
  });

  it("rejects invalid directions", () => {
    expectRawLibError(() => compileSort({ name: "sideways" } as any));
  });
});

describe("compilePipeline", () => {
  it("compiles match and sort", () => {
    expect(compilePipeline([{ $match: { role: "admin" } }, { $sort: { age: "desc" } }])).toEqual([
      { $match: { kind: "comparison", field: "role", op: "eq", value: "admin" } },
      { $sort: [{ field: "age", direction: "desc" }] },
    ]);
  });

  it("compiles group, limit, skip, project, and count", () => {
    expect(
      compilePipeline([
        { $group: { by: "role", fields: { total: { op: "count" } } } },
        { $limit: 10 },
        { $skip: 5 },
        { $project: { role: 1 } },
        { $count: "total" },
      ]),
    ).toEqual([
      { $group: { by: "role", fields: { total: { op: "count" } } } },
      { $limit: 10 },
      { $skip: 5 },
      { $project: { role: 1 } },
      { $count: "total" },
    ]);
  });

  it("rejects malformed steps", () => {
    expectRawLibError(() => compilePipeline([{ $limit: 1, $skip: 1 } as any]));
    expectRawLibError(() => compilePipeline([{ $limit: 0 }]));
    expectRawLibError(() => compilePipeline([{ $skip: -1 }]));
    expectRawLibError(() => compilePipeline([{ $unknown: 1 } as any]));
    expectRawLibError(() =>
      compilePipeline([{ $group: { by: "role", fields: { x: { op: "sum" } } } }]),
    );
  });
});

describe("normalizeQuery", () => {
  it("applies list defaults", () => {
    expect(normalizeQuery({ op: "list", entity: "users" }, entity).page).toEqual({
      limit: 20,
      offset: 0,
    });
  });

  it("respects pagination", () => {
    expect(
      normalizeQuery({ op: "list", entity: "users", page: { limit: 5, offset: 10 } }, entity).page,
    ).toEqual({ limit: 5, offset: 10 });
  });

  it("rejects invalid pagination", () => {
    expectRawLibError(() =>
      normalizeQuery({ op: "list", entity: "users", page: { limit: 0 } }, entity),
    );
    expectRawLibError(() =>
      normalizeQuery({ op: "list", entity: "users", page: { limit: 5000 } }, entity),
    );
    expectRawLibError(() =>
      normalizeQuery({ op: "list", entity: "users", page: { offset: -1 } }, entity),
    );
  });

  it("requires where for get, update, and delete", () => {
    expectRawLibError(() => normalizeQuery({ op: "get", entity: "users" }, entity));
    expectRawLibError(() =>
      normalizeQuery({ op: "update", entity: "users", data: { name: "A" } }, entity),
    );
    expectRawLibError(() => normalizeQuery({ op: "delete", entity: "users" }, entity));
  });

  it("requires data for create and update", () => {
    expectRawLibError(() => normalizeQuery({ op: "create", entity: "users" }, entity));
    expectRawLibError(() =>
      normalizeQuery({ op: "update", entity: "users", where: { id: "u1" } }, entity),
    );
  });

  it("requires a pipeline for aggregate", () => {
    expectRawLibError(() => normalizeQuery({ op: "aggregate", entity: "users" }, entity));
  });

  it("rejects pipeline on non-aggregate operations", () => {
    expectRawLibError(() =>
      normalizeQuery({ op: "list", entity: "users", pipeline: [{ $limit: 1 }] }, entity),
    );
  });

  it("rejects where on aggregate", () => {
    expectRawLibError(() =>
      normalizeQuery(
        { op: "aggregate", entity: "users", where: { role: "admin" }, pipeline: [{ $limit: 1 }] },
        entity,
      ),
    );
  });

  it("copies select fields", () => {
    const select = ["id", "name"] as const;
    const normalized = normalizeQuery({ op: "list", entity: "users", select: [...select] }, entity);
    expect(normalized.select).toEqual(["id", "name"]);
    expect(normalized.select).not.toBe(select);
  });
});
