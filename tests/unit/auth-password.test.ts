import { describe, expect, it } from "vitest";
import { defaultPasswordHasher } from "../../src/auth/password";

describe("defaultPasswordHasher", () => {
  it("produces scrypt hashes with parameters and a random salt", async () => {
    const first = await defaultPasswordHasher.hash("correct horse battery staple");
    const second = await defaultPasswordHasher.hash("correct horse battery staple");

    expect(first.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(first).not.toBe(second);
    expect(first).not.toContain("correct horse");
  });

  it("verifies matching passwords only", async () => {
    const hash = await defaultPasswordHasher.hash("s3cret-password");

    await expect(defaultPasswordHasher.verify("s3cret-password", hash)).resolves.toBe(true);
    await expect(defaultPasswordHasher.verify("wrong-password", hash)).resolves.toBe(false);
  });

  it("rejects unknown or malformed hash formats", async () => {
    await expect(defaultPasswordHasher.verify("x", "")).resolves.toBe(false);
    await expect(defaultPasswordHasher.verify("x", "bcrypt$whatever")).resolves.toBe(false);
    await expect(defaultPasswordHasher.verify("x", "scrypt$bad")).resolves.toBe(false);
    await expect(defaultPasswordHasher.verify("x", "pbkdf2$bad")).resolves.toBe(false);
  });

  it("verifies PBKDF2 hashes produced by the Web Crypto fallback", async () => {
    const webcrypto = globalThis.crypto;
    const salt = new Uint8Array(16).fill(7);
    const keyMaterial = await webcrypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("fallback-password"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await webcrypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
      keyMaterial,
      512,
    );

    const encoded = [
      "pbkdf2",
      210_000,
      Buffer.from(salt).toString("base64url"),
      Buffer.from(new Uint8Array(bits)).toString("base64url"),
    ].join("$");

    await expect(defaultPasswordHasher.verify("fallback-password", encoded)).resolves.toBe(true);
    await expect(defaultPasswordHasher.verify("nope", encoded)).resolves.toBe(false);
  });

  it("detects hashes that need a parameter upgrade", () => {
    expect(defaultPasswordHasher.needsRehash?.("scrypt$32768$8$1$c2FsdA$a2V5")).toBe(false);
    expect(defaultPasswordHasher.needsRehash?.("scrypt$16384$8$1$c2FsdA$a2V5")).toBe(true);
    expect(defaultPasswordHasher.needsRehash?.("scrypt$bad")).toBe(true);
    expect(defaultPasswordHasher.needsRehash?.("pbkdf2$210000$a$b")).toBe(false);
  });
});
