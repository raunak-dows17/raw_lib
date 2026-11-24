import { describe, expect, it } from "vitest";
import { parseDuration, toSeconds } from "../../src/auth/time";
import { RawLibError } from "../../src/core/errors";

describe("parseDuration", () => {
  it("parses single and compound units", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("15s")).toBe(15_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("30d")).toBe(2_592_000_000);
    expect(parseDuration("1w")).toBe(604_800_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
  });

  it("accepts numbers as milliseconds", () => {
    expect(parseDuration(1_500)).toBe(1_500);
    expect(parseDuration(0)).toBe(0);
  });

  it("rejects invalid durations", () => {
    expect(() => parseDuration("")).toThrow(RawLibError);
    expect(() => parseDuration("abc")).toThrow(RawLibError);
    expect(() => parseDuration("15")).toThrow(RawLibError);
    expect(() => parseDuration("1h30")).toThrow(RawLibError);
    expect(() => parseDuration(-1)).toThrow(RawLibError);
    expect(() => parseDuration(Number.NaN)).toThrow(RawLibError);
  });

  it("converts to whole seconds with a floor of one", () => {
    expect(toSeconds(15_000)).toBe(15);
    expect(toSeconds(999)).toBe(1);
    expect(toSeconds(0)).toBe(1);
  });
});
