import * as vb from "valibot";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRawQl, MemoryAdapter, RawLibError, type Validator } from "../../src/index";
import { rawval, v } from "../../src/val";

type ValidateInput = Parameters<Validator["validate"]>[0];

const entity = { name: "users", collection: "users", idField: "id" };

function context(overrides: Partial<ValidateInput> = {}): ValidateInput {
  return {
    op: "create",
    entity,
    query: { op: "create", entity: "users" },
    data: undefined,
    ...overrides,
  };
}

describe("rawval", () => {
  it("validates create data and returns parsed output", async () => {
    const validator = rawval({
      users: {
        create: v.object({
          email: v.string().email(),
          age: v.number().int().min(18),
          role: v.string().default("member"),
        }),
      },
    });

    const result = await validator.validate(context({ data: { email: "ada@acme.com", age: 30 } }));

    expect(result).toEqual({
      ok: true,
      value: { email: "ada@acme.com", age: 30, role: "member" },
    });
  });

  it("returns issues for invalid writes", async () => {
    const validator = rawval({
      users: { create: v.object({ email: v.string().email(), age: v.number().min(18) }) },
    });

    const result = await validator.validate(context({ data: { email: "nope", age: 12 } }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { path: "email", message: "Must be a valid email address", code: "invalid_email" },
        {
          path: "age",
          message: "Must be greater than or equal to 18",
          code: "too_small",
        },
      ]);
    }
  });

  it("validates read queries", async () => {
    const validator = rawval({
      users: {
        list: v.object({
          op: v.literal("list"),
          entity: v.literal("users"),
          page: v.object({ limit: v.number().int().positive() }).optional(),
        }),
      },
    });

    const valid = await validator.validate(
      context({
        op: "list",
        data: undefined,
        query: { op: "list", entity: "users", page: { limit: 10 } },
      }),
    );
    const invalid = await validator.validate(
      context({
        op: "list",
        data: undefined,
        query: { op: "list", entity: "users", page: { limit: 0 } },
      }),
    );

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues[0]?.path).toBe("page.limit");
  });

  it("passes through when no schema is registered", async () => {
    const validator = rawval({});
    const result = await validator.validate(context({ data: { anything: true } }));
    expect(result).toEqual({ ok: true });
  });

  it("uses fallback schemas", async () => {
    const validator = rawval(
      {},
      {
        fallback: {
          count: v.object({ op: v.literal("count"), entity: v.string() }),
        },
      },
    );

    const result = await validator.validate(
      context({ op: "count", data: undefined, query: { op: "count", entity: "posts" } }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects invalid schema registrations", () => {
    expect(() => rawval({ users: { create: {} as any } })).toThrow(RawLibError);
  });
});

describe("standard schema integrations", () => {
  it("accepts a hand-written Standard Schema", async () => {
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "string"
            ? { value }
            : { issues: [{ message: "Expected a string", path: [{ key: "name" }] }] },
      },
    };

    const validator = rawval({ users: { create: schema as any } });
    const result = await validator.validate(context({ data: 1 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([{ path: "name", message: "Expected a string" }]);
    }
  });

  it("handles issues without a path", async () => {
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: () => ({ issues: [{ message: "Whole value is invalid" }] }),
      },
    };

    const validator = rawval({ users: { create: schema as any } });
    const result = await validator.validate(context({ data: 1 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([{ path: "", message: "Whole value is invalid" }]);
    }
  });

  it("accepts zod schemas", async () => {
    const validator = rawval({
      users: {
        create: z.object({
          email: z.string().email(),
          age: z.number().int().min(18),
        }),
      },
    });

    const valid = await validator.validate(context({ data: { email: "ada@acme.com", age: 30 } }));
    const invalid = await validator.validate(context({ data: { email: "nope", age: 12 } }));

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues.map((issue) => issue.path).sort()).toEqual(["age", "email"]);
    }
  });

  it("accepts valibot schemas", async () => {
    const validator = rawval({
      users: {
        create: vb.object({
          email: vb.pipe(vb.string(), vb.email()),
          age: vb.pipe(vb.number(), vb.integer(), vb.minValue(18)),
        }),
      },
    });

    const valid = await validator.validate(context({ data: { email: "ada@acme.com", age: 30 } }));
    const invalid = await validator.validate(context({ data: { email: "nope", age: 12 } }));

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues.map((issue) => issue.path).sort()).toEqual(["age", "email"]);
    }
  });
});

describe("rawval inside the engine", () => {
  it("validates and normalizes writes before they reach the adapter", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter(),
      validate: rawval({
        users: {
          create: v.object({
            email: v.string().email(),
            age: v.number().int().min(18),
            role: v.string().default("member"),
          }),
        },
      }),
    });

    const result = await db.execute<{ id: string; role: string }>({
      op: "create",
      entity: "users",
      data: { email: "ada@acme.com", age: 30 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.role).toBe("member");
      expect(result.data.id).toBeTruthy();
    }
  });

  it("returns VALIDATION_FAILED with issue details", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter(),
      validate: rawval({
        users: { create: v.object({ email: v.string().email() }) },
      }),
    });

    const result = await db.execute({
      op: "create",
      entity: "users",
      data: { email: "nope" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.details).toEqual([
        { path: "email", message: "Must be a valid email address", code: "invalid_email" },
      ]);
    }
  });

  it("keeps partial updates partial", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter({ seed: { users: [{ id: "u1", email: "a@b.co", age: 20 }] } }),
      validate: rawval({
        users: {
          update: v.object({ email: v.string().email(), age: v.number().int().min(18) }).partial(),
        },
      }),
    });

    const result = await db.execute<{ age: number }>({
      op: "update",
      entity: "users",
      where: { id: "u1" },
      data: { age: 21 },
    });

    expect(result.ok).toBe(true);

    const found = await db.execute<{ age: number; email: string }>({
      op: "get",
      entity: "users",
      where: { id: "u1" },
    });

    expect(found.ok && found.data).toMatchObject({ age: 21, email: "a@b.co" });
  });

  it("supports the validator alias", async () => {
    const db = createRawQl({
      adapter: new MemoryAdapter(),
      validator: rawval({
        users: { create: v.object({ email: v.string().email() }) },
      }),
    });

    const result = await db.execute({
      op: "create",
      entity: "users",
      data: { email: "nope" },
    });

    expect(result.ok).toBe(false);
  });
});
