import { describe, expect, it } from "vitest";
import { type AccessClaims, signAccessToken, verifyAccessToken } from "../../src/auth/tokens";
import { RawLibError } from "../../src/core/errors";

const secret = "test-secret-0123456789";
const baseClaims = { sub: "u1", sid: "s1" };

describe("access tokens", () => {
  it("signs and verifies HS256 tokens", async () => {
    const token = await signAccessToken({
      secret,
      claims: { ...baseClaims, roles: ["admin"] },
      ttlSeconds: 900,
      now: 1_000,
    });

    expect(token.split(".")).toHaveLength(3);

    const claims = await verifyAccessToken({ secret, token, now: 1_100 });
    expect(claims).toMatchObject({
      sub: "u1",
      sid: "s1",
      roles: ["admin"],
      iat: 1_000,
      exp: 1_900,
    });
    expect(typeof claims.jti).toBe("string");
  });

  it("rejects a tampered payload", async () => {
    const token = await signAccessToken({ secret, claims: baseClaims, ttlSeconds: 60 });
    const [header, , signature] = token.split(".");
    const payload = Buffer.from(JSON.stringify({ sub: "evil", sid: "s1" })).toString("base64url");

    await expect(
      verifyAccessToken({ secret, token: `${header}.${payload}.${signature}` }),
    ).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signAccessToken({
      secret: "another-secret-0123456789",
      claims: baseClaims,
      ttlSeconds: 60,
    });

    await expect(verifyAccessToken({ secret, token })).rejects.toMatchObject({
      code: "TOKEN_INVALID",
    });
  });

  it("rejects expired tokens and honours clock tolerance", async () => {
    const token = await signAccessToken({
      secret,
      claims: baseClaims,
      ttlSeconds: 10,
      now: 1_000,
    });

    await expect(verifyAccessToken({ secret, token, now: 1_011 })).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });

    await expect(
      verifyAccessToken({ secret, token, now: 1_011, clockToleranceSeconds: 5 }),
    ).resolves.toMatchObject({ sub: "u1" });
  });

  it("rejects tokens issued in the future", async () => {
    const token = await signAccessToken({
      secret,
      claims: baseClaims,
      ttlSeconds: 60,
      now: 2_000,
    });

    await expect(verifyAccessToken({ secret, token, now: 1_000 })).rejects.toMatchObject({
      code: "TOKEN_INVALID",
    });
  });

  it("rejects malformed tokens", async () => {
    const cases = ["", "a.b", "a.b.c.d", "a.b.c", "!!!.@@@.###"];

    for (const token of cases) {
      await expect(verifyAccessToken({ secret, token })).rejects.toBeInstanceOf(RawLibError);
    }
  });

  it("rejects unsupported algorithms", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "u1", sid: "s1" })).toString("base64url");

    await expect(
      verifyAccessToken({ secret, token: `${header}.${payload}.sig` }),
    ).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("rejects tokens with missing claims", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "u1" })).toString("base64url");

    await expect(
      verifyAccessToken({ secret, token: `${header}.${payload}.sig` }),
    ).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("accepts a Uint8Array secret", async () => {
    const bytes = new TextEncoder().encode(secret);
    const token = await signAccessToken({
      secret: bytes,
      claims: baseClaims,
      ttlSeconds: 60,
    });

    const claims: AccessClaims = await verifyAccessToken({ secret: bytes, token });
    expect(claims.sub).toBe("u1");
  });
});
