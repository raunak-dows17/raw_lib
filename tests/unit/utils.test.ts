import { describe, expect, it } from "vitest";
import {
  clone,
  compareValues,
  deletePath,
  getPath,
  isPlainObject,
  setPath,
  valuesEqual,
} from "../../src/core/utils";

describe("isPlainObject", () => {
  it("accepts plain and null-prototype objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it("rejects arrays, dates, primitives, and null", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(1)).toBe(false);
  });
});

describe("clone", () => {
  it("deep clones nested structures", () => {
    const source = { a: { b: [1, 2] } };
    const copy = clone(source);

    copy.a.b.push(3);

    expect(source.a.b).toEqual([1, 2]);
    expect(copy.a.b).toEqual([1, 2, 3]);
  });
});

describe("getPath", () => {
  it("reads a literal dotted key first", () => {
    expect(getPath({ "a.b": 1, a: { b: 2 } }, "a.b")).toBe(1);
  });

  it("reads nested paths", () => {
    expect(getPath({ a: { b: { c: 3 } } }, "a.b.c")).toBe(3);
  });

  it("returns undefined for broken paths", () => {
    expect(getPath({ a: null }, "a.b")).toBeUndefined();
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getPath(undefined, "a")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
  });
});

describe("setPath and deletePath", () => {
  it("creates intermediate objects", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "a.b.c", 1);
    expect(target).toEqual({ a: { b: { c: 1 } } });
  });

  it("replaces non-object intermediates", () => {
    const target: Record<string, unknown> = { a: 1 };
    setPath(target, "a.b", 2);
    expect(target).toEqual({ a: { b: 2 } });
  });

  it("deletes nested keys", () => {
    const target: Record<string, unknown> = { a: { b: { c: 1, d: 2 } } };
    deletePath(target, "a.b.c");
    expect(target).toEqual({ a: { b: { d: 2 } } });
  });

  it("ignores missing or non-object paths", () => {
    const target: Record<string, unknown> = { a: 1 };
    expect(() => deletePath(target, "a.b")).not.toThrow();
    expect(() => deletePath(target, "x.y.z")).not.toThrow();
    expect(target).toEqual({ a: 1 });
  });
});

describe("valuesEqual", () => {
  it("compares primitives and dates", () => {
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual(1, 2)).toBe(false);
    expect(valuesEqual(new Date(0), new Date(0))).toBe(true);
    expect(valuesEqual(new Date(0), new Date(1))).toBe(false);
  });

  it("compares arrays structurally", () => {
    expect(valuesEqual([1, [2]], [1, [2]])).toBe(true);
    expect(valuesEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("compares objects structurally", () => {
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("returns false for mixed types", () => {
    expect(valuesEqual({ a: 1 }, [1])).toBe(false);
    expect(valuesEqual("1", 1)).toBe(false);
  });
});

describe("compareValues", () => {
  it("compares numbers, strings, and booleans", () => {
    expect(compareValues(1, 2)).toBe(-1);
    expect(compareValues(2, 1)).toBe(1);
    expect(compareValues("a", "b")).toBe(-1);
    expect(compareValues("b", "a")).toBe(1);
    expect(compareValues(false, true)).toBe(-1);
    expect(compareValues(true, true)).toBe(0);
  });

  it("compares dates as timestamps", () => {
    expect(compareValues(new Date(1), new Date(2))).toBe(-1);
    expect(compareValues(new Date(2), new Date(2))).toBe(0);
  });

  it("falls back to string comparison for mixed types", () => {
    expect(compareValues(10, "2")).toBe(-1);
    expect(compareValues(null, null)).toBe(0);
  });
});
