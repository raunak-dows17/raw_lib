import { describe, expect, it } from "vitest";
import { RawLibError } from "../../src/index";
import { v } from "../../src/val";

function issuesOf(schema: { safeParse: (value: unknown) => any }, value: unknown) {
  const result = schema.safeParse(value);
  return result.ok ? [] : result.issues;
}

describe("v.string", () => {
  it("accepts strings and rejects other values", () => {
    expect(v.string().parse("hello")).toBe("hello");
    expect(issuesOf(v.string(), 1)).toEqual([
      { path: "", message: "Expected a string", code: "invalid_type" },
    ]);
  });

  it("applies length rules", () => {
    expect(v.string().min(2).max(4).parse("abc")).toBe("abc");
    expect(issuesOf(v.string().min(4), "abc")[0]?.code).toBe("too_small");
    expect(issuesOf(v.string().max(2), "abc")[0]?.code).toBe("too_big");
    expect(issuesOf(v.string().length(2), "abc")[0]?.code).toBe("invalid_length");
    expect(issuesOf(v.string().nonempty(), "")[0]?.code).toBe("too_small");
  });

  it("validates emails, urls, regexes, prefixes, and suffixes", () => {
    expect(v.string().email().parse("a@b.co")).toBe("a@b.co");
    expect(issuesOf(v.string().email(), "nope")[0]?.code).toBe("invalid_email");
    expect(v.string().url().parse("https://example.com")).toBe("https://example.com");
    expect(issuesOf(v.string().url(), "nope")[0]?.code).toBe("invalid_url");
    expect(v.string().regex(/^a+$/).parse("aaa")).toBe("aaa");
    expect(issuesOf(v.string().regex(/^a+$/), "bbb")[0]?.code).toBe("invalid_string");
    expect(v.string().startsWith("ab").parse("abc")).toBe("abc");
    expect(v.string().endsWith("bc").parse("abc")).toBe("abc");
  });
});

describe("v.number", () => {
  it("accepts finite numbers and rejects NaN or Infinity", () => {
    expect(v.number().parse(1.5)).toBe(1.5);
    expect(issuesOf(v.number(), Number.NaN)[0]?.code).toBe("invalid_type");
    expect(issuesOf(v.number(), Number.POSITIVE_INFINITY)[0]?.code).toBe("invalid_type");
  });

  it("applies numeric rules", () => {
    expect(v.number().int().min(1).max(3).parse(2)).toBe(2);
    expect(issuesOf(v.number().int(), 1.5)[0]?.code).toBe("invalid_type");
    expect(issuesOf(v.number().min(2), 1)[0]?.code).toBe("too_small");
    expect(issuesOf(v.number().max(2), 3)[0]?.code).toBe("too_big");
    expect(issuesOf(v.number().positive(), 0)[0]?.code).toBe("too_small");
    expect(issuesOf(v.number().nonnegative(), -1)[0]?.code).toBe("too_small");
  });
});

describe("v primitives", () => {
  it("validates booleans, literals, and enums", () => {
    expect(v.boolean().parse(true)).toBe(true);
    expect(issuesOf(v.boolean(), "true")[0]?.code).toBe("invalid_type");
    expect(v.literal("admin").parse("admin")).toBe("admin");
    expect(issuesOf(v.literal("admin"), "member")[0]?.code).toBe("invalid_literal");
    expect(v.enum(["a", "b"] as const).parse("a")).toBe("a");
    expect(issuesOf(v.enum(["a", "b"] as const), "c")[0]?.code).toBe("invalid_enum_value");
  });

  it("validates dates", () => {
    expect(v.date().parse(new Date(0))).toEqual(new Date(0));
    expect(v.date().parse("2024-01-01T00:00:00.000Z")).toEqual(
      new Date("2024-01-01T00:00:00.000Z"),
    );
    expect(issuesOf(v.date(), "nope")[0]?.code).toBe("invalid_date");
    expect(issuesOf(v.date(), new Date(Number.NaN))[0]?.code).toBe("invalid_date");
  });
});

describe("v.array", () => {
  it("parses items and reports indexed paths", () => {
    expect(v.array(v.number()).parse([1, 2])).toEqual([1, 2]);
    expect(issuesOf(v.array(v.number()), [1, "x"])).toEqual([
      { path: "[1]", message: "Expected a finite number", code: "invalid_type" },
    ]);
  });

  it("applies size rules", () => {
    expect(v.array(v.string()).min(1).max(2).parse(["a"])).toEqual(["a"]);
    expect(issuesOf(v.array(v.string()).min(2), ["a"])[0]?.code).toBe("too_small");
    expect(issuesOf(v.array(v.string()).max(1), ["a", "b"])[0]?.code).toBe("too_big");
    expect(issuesOf(v.array(v.string()).length(2), ["a"])[0]?.code).toBe("invalid_length");
    expect(issuesOf(v.array(v.string()).nonempty(), [])[0]?.code).toBe("too_small");
  });
});

describe("v.object", () => {
  const user = v.object({
    email: v.string().email(),
    age: v.number().int().min(18),
    name: v.string().optional(),
  });

  it("parses valid objects and strips unknown keys", () => {
    expect(user.parse({ email: "a@b.co", age: 20, extra: true })).toEqual({
      email: "a@b.co",
      age: 20,
    });
  });

  it("reports nested paths", () => {
    expect(issuesOf(user, { email: "nope", age: 12 })).toEqual([
      { path: "email", message: "Must be a valid email address", code: "invalid_email" },
      {
        path: "age",
        message: "Must be greater than or equal to 18",
        code: "too_small",
      },
    ]);
  });

  it("rejects non-objects", () => {
    expect(issuesOf(user, null)[0]).toEqual({
      path: "",
      message: "Expected an object",
      code: "invalid_type",
    });
  });

  it("supports partial and extend", () => {
    const partial = user.partial();
    expect(partial.parse({})).toEqual({});

    const extended = user.extend({ role: v.enum(["admin", "member"] as const) });
    expect(extended.parse({ email: "a@b.co", age: 20, role: "admin" })).toEqual({
      email: "a@b.co",
      age: 20,
      role: "admin",
    });
  });
});

describe("v.record and v.union", () => {
  it("parses records", () => {
    expect(v.record(v.number()).parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(issuesOf(v.record(v.number()), { a: "x" })).toEqual([
      { path: "a", message: "Expected a finite number", code: "invalid_type" },
    ]);
  });

  it("parses unions", () => {
    const schema = v.union([v.string(), v.number()]);
    expect(schema.parse("a")).toBe("a");
    expect(schema.parse(1)).toBe(1);
    expect(issuesOf(schema, true)[0]?.code).toBe("invalid_union");
  });
});

describe("schema modifiers", () => {
  it("supports optional, nullable, and default", () => {
    expect(v.string().optional().parse(undefined)).toBeUndefined();
    expect(v.string().nullable().parse(null)).toBeNull();
    expect(v.string().nullable().parse("x")).toBe("x");
    expect(v.string().default("x").parse(undefined)).toBe("x");
    expect(v.string().default("x").parse("y")).toBe("y");
    expect(issuesOf(v.string().optional(), 1)[0]?.code).toBe("invalid_type");
  });

  it("supports any, unknown, and modifier helpers", () => {
    expect(v.any().parse({ a: 1 })).toEqual({ a: 1 });
    expect(v.unknown().parse(null)).toBeNull();
    expect(v.optional(v.string()).parse(undefined)).toBeUndefined();
    expect(v.nullable(v.string()).parse(null)).toBeNull();
  });

  it("accepts custom Schema implementations", () => {
    const custom = {
      ...v.string(),
      safeParse: (value: unknown) =>
        value === "ok"
          ? { ok: true, value: "ok" }
          : { ok: false, issues: [{ path: "", message: "bad", code: "custom" }] },
    } as any;

    expect(v.array(custom).parse(["ok"])).toEqual(["ok"]);
    expect(issuesOf(v.array(custom), ["no"])[0]?.message).toBe("bad");
  });

  it("supports refine and transform", () => {
    const even = v.number().refine((value) => value % 2 === 0, "Must be even");
    expect(even.parse(2)).toBe(2);
    expect(issuesOf(even, 3)[0]).toEqual({
      path: "",
      message: "Must be even",
      code: "custom",
    });

    expect(
      v
        .string()
        .transform((value) => value.length)
        .parse("abc"),
    ).toBe(3);
    expect(
      issuesOf(
        v.string().transform(() => {
          throw new Error("boom");
        }),
        "abc",
      )[0],
    ).toEqual({ path: "", message: "boom", code: "transform" });
  });

  it("throws a typed error from parse", () => {
    expect(() => v.number().parse("x")).toThrow(RawLibError);
    try {
      v.number().parse("x");
    } catch (error) {
      expect((error as RawLibError).code).toBe("VALIDATION_FAILED");
      expect((error as RawLibError).details).toEqual([
        { path: "", message: "Expected a finite number", code: "invalid_type" },
      ]);
    }
  });
});

describe("standard schema interface", () => {
  it("exposes ~standard.validate", () => {
    const schema = v.object({ name: v.string() });
    const standard = schema["~standard"];

    expect(standard.version).toBe(1);
    expect(standard.vendor).toBe("raw_lib");
    expect(standard.validate({ name: "Ada" })).toEqual({ value: { name: "Ada" } });

    const failure = standard.validate({ name: 1 });
    expect("issues" in failure && failure.issues?.[0]).toEqual({
      message: "Expected a string",
      code: "invalid_type",
      path: ["name"],
    });
  });
});
