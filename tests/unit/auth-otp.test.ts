import { describe, expect, it } from "vitest";
import {
  constantTimeHexEqual,
  generateOtpCode,
  hashContact,
  hashOtpCode,
} from "../../src/auth/otp";

describe("generateOtpCode", () => {
  it("generates numeric codes of the requested length", () => {
    for (const length of [4, 6, 8, 10]) {
      const code = generateOtpCode(length);
      expect(code).toMatch(new RegExp(`^\\d{${length}}$`));
    }
  });

  it("does not repeat every time", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateOtpCode(6)));
    expect(codes.size).toBeGreaterThan(1);
  });

  it("rejects unsupported lengths", () => {
    expect(() => generateOtpCode(3)).toThrow(RangeError);
    expect(() => generateOtpCode(11)).toThrow(RangeError);
    expect(() => generateOtpCode(6.5)).toThrow(RangeError);
  });
});

describe("OTP hashing", () => {
  const secret = "otp-secret-0123456789";

  it("hashes codes with the salt and secret", async () => {
    const hash = await hashOtpCode(secret, "salt-a", "123456");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(hashOtpCode(secret, "salt-a", "123456")).resolves.toBe(hash);
    await expect(hashOtpCode(secret, "salt-b", "123456")).resolves.not.toBe(hash);
    await expect(hashOtpCode(secret, "salt-a", "654321")).resolves.not.toBe(hash);
    await expect(hashOtpCode("another-secret-012345", "salt-a", "123456")).resolves.not.toBe(hash);
  });

  it("hashes contacts without storing the raw value", async () => {
    const hash = await hashContact(secret, "ada@acme.com");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("ada@acme.com");
    await expect(hashContact(secret, "ada@acme.com")).resolves.toBe(hash);
    await expect(hashContact(secret, "other@acme.com")).resolves.not.toBe(hash);
  });

  it("compares digests in constant time", () => {
    expect(constantTimeHexEqual("abcd", "abcd")).toBe(true);
    expect(constantTimeHexEqual("abcd", "abce")).toBe(false);
    expect(constantTimeHexEqual("abcd", "abc")).toBe(false);
    expect(constantTimeHexEqual("", "")).toBe(true);
  });
});
