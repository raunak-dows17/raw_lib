import { describe, expect, it } from "vitest";
import { normalizeQuery } from "../../src/core/compiler/query";
import type { RawLibError } from "../../src/core/errors";

const entity = { name: "users", collection: "users", idField: "id" };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as RawLibError).code;
  }
  return undefined;
}

describe("assertQueryShape", () => {
  it("rejects non-object queries", () => {
    expect(code(() => normalizeQuery(null as any, entity))).toBe("VALIDATION_FAILED");
    expect(code(() => normalizeQuery("list" as any, entity))).toBe("VALIDATION_FAILED");
  });

  it("rejects unknown operations and empty entities", () => {
    expect(code(() => normalizeQuery({ op: "explode" as any, entity: "users" }, entity))).toBe(
      "VALIDATION_FAILED",
    );
    expect(code(() => normalizeQuery({ op: "list", entity: "" }, entity))).toBe(
      "VALIDATION_FAILED",
    );
    expect(
      code(() => normalizeQuery({ op: "list", entity: "users" }, { ...entity, name: "" })),
    ).toBe(undefined);
    expect(code(() => normalizeQuery({ op: "list", entity: 1 as any }, entity))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("rejects array update payloads", () => {
    expect(
      code(() =>
        normalizeQuery(
          { op: "update", entity: "users", where: { id: "1" }, data: [] as any },
          entity,
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("rejects data on list and count", () => {
    expect(code(() => normalizeQuery({ op: "list", entity: "users", data: {} }, entity))).toBe(
      "VALIDATION_FAILED",
    );
    expect(code(() => normalizeQuery({ op: "count", entity: "users", data: {} }, entity))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("rejects pagination on aggregate", () => {
    expect(
      code(() =>
        normalizeQuery(
          { op: "aggregate", entity: "users", pipeline: [{ $limit: 1 }], page: { limit: 1 } },
          entity,
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("allows pagination defaults to be configured", () => {
    const normalized = normalizeQuery({ op: "list", entity: "users" }, entity, {
      defaultLimit: 5,
      maxLimit: 10,
    });
    expect(normalized.page).toEqual({ limit: 5, offset: 0 });
    expect(
      code(() =>
        normalizeQuery({ op: "list", entity: "users", page: { limit: 11 } }, entity, {
          maxLimit: 10,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});
