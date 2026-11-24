import { describe, expect, it, vi } from "vitest";
import { type Auth, type AuthConfig, createAuth } from "../../src/auth";
import { createRawQl, MemoryAdapter } from "../../src/index";

const SECRET = "integration-secret-0123456789";

function createClock(start = "2026-01-01T00:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

function harness(overrides: Partial<AuthConfig> = {}) {
  const clock = createClock();
  const db = createRawQl({ adapter: new MemoryAdapter() });
  const auth = createAuth({ db, secret: SECRET, clock: clock.now, ...overrides });
  return { auth, db, clock };
}

const credentials = {
  email: "Ada@Acme.com",
  username: "Ada",
  phone: "+15550001111",
  password: "correct horse battery",
};

async function register(auth: Auth, overrides: Record<string, unknown> = {}) {
  const result = await auth.register({ ...credentials, ...overrides });
  if (!result.ok) throw new Error(`register failed: ${result.error.message}`);
  return result.data;
}

describe("auth registration", () => {
  it("creates a user and an initial session", async () => {
    const { auth, db } = harness();
    const result = await auth.register(credentials);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.user).toMatchObject({
      email: "ada@acme.com",
      username: "ada",
      phone: "+15550001111",
      roles: [],
    });
    expect(result.data.user.id).toBeTruthy();
    expect("passwordHash" in result.data.user).toBe(false);
    expect("refreshTokenHash" in result.data.session).toBe(false);
    expect("refreshTokenHistory" in result.data.session).toBe(false);
    expect(result.data.accessToken.split(".")).toHaveLength(3);
    expect(result.data.refreshToken.length).toBeGreaterThan(20);
    expect(new Date(result.data.accessExpiresAt).getTime()).toBeGreaterThan(
      Date.parse("2026-01-01T00:00:00.000Z"),
    );

    const stored = await db.execute<{ passwordHash: string }>({
      op: "get",
      entity: "users",
      where: { id: result.data.user.id },
    });

    expect(stored.ok).toBe(true);
    if (stored.ok && stored.data) {
      expect(stored.data.passwordHash.startsWith("scrypt$")).toBe(true);
      expect(stored.data.passwordHash).not.toContain(credentials.password);
    }
  });

  it("rejects duplicate identifiers", async () => {
    const { auth } = harness();
    await register(auth);

    for (const identifier of [
      { email: "ada@acme.com" },
      { username: "ADA" },
      { phone: "+15550001111" },
    ]) {
      const result = await auth.register({ ...credentials, ...identifier });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("validates the password and identifier requirements", async () => {
    const { auth } = harness();

    const short = await auth.register({ email: "a@b.co", password: "short" });
    const missing = await auth.register({ password: "correct horse battery" });
    const custom = harness({ password: { minLength: 4 } });

    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.code).toBe("VALIDATION_FAILED");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("VALIDATION_FAILED");
    expect(await custom.auth.register({ email: "a@b.co", password: "four" })).toMatchObject({
      ok: true,
    });
  });

  it("stores metadata as a nested field without shadowing canonical fields", async () => {
    const { auth, db } = harness();
    const result = await auth.register({
      ...credentials,
      metadata: { plan: "pro", email: "evil@example.com", passwordHash: "nope" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.user.email).toBe("ada@acme.com");
    expect(result.data.user.metadata).toEqual({
      plan: "pro",
      email: "evil@example.com",
      passwordHash: "nope",
    });

    const stored = await db.execute<{ email: string; passwordHash: string }>({
      op: "get",
      entity: "users",
      where: { id: result.data.user.id },
    });

    expect(stored.ok && stored.data?.email).toBe("ada@acme.com");
    expect(stored.ok && stored.data?.passwordHash.startsWith("scrypt$")).toBe(true);
  });

  it("supports a custom password hasher", async () => {
    const hasher = {
      hash: async (password: string) => `plain:${password}`,
      verify: async (password: string, stored: string) => stored === `plain:${password}`,
    };
    const { auth } = harness({ password: { hasher } });

    await register(auth);
    const login = await auth.login.password({
      identifier: "ada@acme.com",
      password: credentials.password,
    });

    expect(login.ok).toBe(true);
  });
});

describe("password login", () => {
  it("accepts email, username, phone, and a bare identifier", async () => {
    const { auth } = harness();
    await register(auth);

    const identifiers = [
      "ada@acme.com",
      "ADA@ACME.COM",
      "ada",
      "+15550001111",
      { email: "ada@acme.com" },
      { username: "ada" },
      { phone: "+15550001111" },
    ];

    for (const identifier of identifiers) {
      const result = await auth.login.password({
        identifier,
        password: credentials.password,
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.user.email).toBe("ada@acme.com");
    }
  });

  it("returns the same generic error for unknown users and bad passwords", async () => {
    const { auth } = harness();
    await register(auth);

    const unknown = await auth.login.password({
      identifier: "nobody@acme.com",
      password: credentials.password,
    });
    const wrong = await auth.login.password({
      identifier: "ada@acme.com",
      password: "not-the-password",
    });

    expect(unknown.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    if (!unknown.ok && !wrong.ok) {
      expect(unknown.error).toEqual(wrong.error);
      expect(unknown.error.code).toBe("INVALID_CREDENTIALS");
    }
  });

  it("rejects empty identifiers", async () => {
    const { auth } = harness();
    const result = await auth.login.password({ identifier: "  ", password: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("invokes login hooks without changing outcomes", async () => {
    const onLogin = vi.fn(() => {
      throw new Error("hook boom");
    });
    const onLoginFailed = vi.fn();
    const { auth } = harness({ hooks: { onLogin, onLoginFailed } });
    await register(auth);
    onLogin.mockClear();

    const ok = await auth.login.password({
      identifier: "ada@acme.com",
      password: credentials.password,
      device: { ip: "127.0.0.1" },
    });
    const failed = await auth.login.password({
      identifier: "ada@acme.com",
      password: "wrong",
      device: { ip: "127.0.0.1" },
    });

    expect(ok.ok).toBe(true);
    expect(failed.ok).toBe(false);
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLoginFailed).toHaveBeenCalledWith({
      identifier: "ada@acme.com",
      reason: "invalid_credentials",
      ip: "127.0.0.1",
    });
  });
});

describe("refresh rotation", () => {
  it("issues a new refresh token and keeps the session usable", async () => {
    const { auth } = harness();
    const first = await register(auth);

    const refreshed = await auth.refresh({ refreshToken: first.refreshToken });

    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;

    expect(refreshed.data.refreshToken).not.toBe(first.refreshToken);
    expect(refreshed.data.session.id).toBe(first.session.id);
    expect(refreshed.data.session.rotation).toBe(1);

    const verified = await auth.verify({ accessToken: refreshed.data.accessToken });
    expect(verified.ok).toBe(true);
  });

  it("revokes the session family when a rotated token is reused", async () => {
    const onRefreshReuse = vi.fn();
    const { auth } = harness({ hooks: { onRefreshReuse } });
    const first = await register(auth);
    const refreshed = await auth.refresh({ refreshToken: first.refreshToken });

    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;

    const replay = await auth.refresh({ refreshToken: first.refreshToken });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("TOKEN_INVALID");

    const after = await auth.refresh({ refreshToken: refreshed.data.refreshToken });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("SESSION_REVOKED");

    const verified = await auth.verify({ accessToken: refreshed.data.accessToken });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.code).toBe("SESSION_REVOKED");

    expect(onRefreshReuse).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown and malformed refresh tokens", async () => {
    const { auth } = harness();

    for (const refreshToken of ["", "not-a-token"]) {
      const result = await auth.refresh({ refreshToken });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("TOKEN_INVALID");
    }
  });

  it("rejects expired refresh tokens", async () => {
    const { auth, clock } = harness();
    const first = await register(auth);
    clock.advance(31 * 24 * 60 * 60 * 1_000);

    const result = await auth.refresh({ refreshToken: first.refreshToken });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOKEN_EXPIRED");
  });

  it("honours custom token lifetimes", async () => {
    const { auth, clock } = harness({ accessTtl: "1s", refreshTtl: "1h" });
    const first = await register(auth);

    clock.advance(2_000);
    const expiredAccess = await auth.verify({ accessToken: first.accessToken });
    expect(expiredAccess.ok).toBe(false);
    if (!expiredAccess.ok) expect(expiredAccess.error.code).toBe("TOKEN_EXPIRED");

    const refreshed = await auth.refresh({ refreshToken: first.refreshToken });
    expect(refreshed.ok).toBe(true);

    clock.advance(2 * 60 * 60 * 1_000);
    const expiredRefresh = await auth.refresh({
      refreshToken: refreshed.ok ? refreshed.data.refreshToken : "",
    });
    expect(expiredRefresh.ok).toBe(false);
    if (!expiredRefresh.ok) expect(expiredRefresh.error.code).toBe("TOKEN_EXPIRED");
  });
});

describe("access token verification", () => {
  it("returns the user, session, and claims", async () => {
    const { auth } = harness();
    const first = await register(auth);

    const result = await auth.verify({ accessToken: first.accessToken });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.user.id).toBe(first.user.id);
      expect(result.data.session.id).toBe(first.session.id);
      expect(result.data.claims.sub).toBe(first.user.id);
      expect(result.data.claims.sid).toBe(first.session.id);
    }
  });

  it("rejects tampered and malformed access tokens", async () => {
    const { auth } = harness();
    const first = await register(auth);
    const [header, payload] = first.accessToken.split(".");

    for (const accessToken of [
      `${header}.${payload}.forged`,
      "not-a-token",
      `${header}.${payload}`,
    ]) {
      const result = await auth.verify({ accessToken });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("TOKEN_INVALID");
    }
  });

  it("rejects a valid token whose session was deleted", async () => {
    const { auth, db } = harness();
    const first = await register(auth);

    await db.execute({ op: "delete", entity: "sessions", where: { id: first.session.id } });

    const result = await auth.verify({ accessToken: first.accessToken });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOKEN_INVALID");
  });
});

describe("device fingerprints", () => {
  const device = { deviceId: "device-a", userAgent: "Agent/1.0" };

  it("binds sessions to the device under the strict policy", async () => {
    const { auth } = harness();
    const first = await register(auth, { device });

    expect(await auth.verify({ accessToken: first.accessToken, device })).toMatchObject({
      ok: true,
    });

    const otherDevice = await auth.verify({
      accessToken: first.accessToken,
      device: { deviceId: "device-b", userAgent: device.userAgent },
    });
    const noDevice = await auth.verify({ accessToken: first.accessToken });

    expect(otherDevice.ok).toBe(false);
    if (!otherDevice.ok) expect(otherDevice.error.code).toBe("FINGERPRINT_MISMATCH");
    expect(noDevice.ok).toBe(false);
    if (!noDevice.ok) expect(noDevice.error.code).toBe("FINGERPRINT_MISMATCH");
  });

  it("accepts a matching user agent under the loose policy", async () => {
    const { auth } = harness({ fingerprint: { policy: "loose" } });
    const first = await register(auth, { device });

    const result = await auth.verify({
      accessToken: first.accessToken,
      device: { userAgent: device.userAgent },
    });

    expect(result.ok).toBe(true);
  });

  it("can require a device id at session creation", async () => {
    const { auth } = harness({ fingerprint: { requireDeviceId: true } });

    const result = await auth.register(credentials);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FINGERPRINT_MISMATCH");
  });

  it("supports an explicit opt-out", async () => {
    const { auth } = harness({ fingerprint: { policy: "off" } });
    const first = await register(auth, { device });

    const result = await auth.verify({
      accessToken: first.accessToken,
      device: { deviceId: "somewhere-else" },
    });

    expect(result.ok).toBe(true);
  });
});

describe("session management", () => {
  it("lists, revokes, and logs out sessions", async () => {
    const onSessionRevoked = vi.fn();
    const { auth } = harness({ hooks: { onSessionRevoked } });
    const first = await register(auth);
    const second = await auth.login.password({
      identifier: "ada@acme.com",
      password: credentials.password,
    });
    if (!second.ok) throw new Error("login failed");

    const listed = await auth.sessions.list({ userId: first.user.id });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data).toHaveLength(2);

    const revoked = await auth.sessions.revoke({ sessionId: second.data.session.id });
    expect(revoked).toMatchObject({ ok: true });
    if (revoked.ok) expect(revoked.data.revokedAt).toBeTruthy();

    expect(onSessionRevoked).toHaveBeenCalledTimes(1);

    const verify = await auth.verify({ accessToken: second.data.accessToken });
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.error.code).toBe("SESSION_REVOKED");
  });

  it("revokes by refresh token and is idempotent", async () => {
    const { auth } = harness();
    const first = await register(auth);

    const loggedOut = await auth.logout({ refreshToken: first.refreshToken });
    const again = await auth.logout({ refreshToken: first.refreshToken });
    const bySession = await auth.logout({ sessionId: first.session.id });

    expect(loggedOut).toEqual({ ok: true, data: { revoked: true } });
    expect(again).toEqual({ ok: true, data: { revoked: false } });
    expect(bySession).toEqual({ ok: true, data: { revoked: false } });

    const result = await auth.refresh({ refreshToken: first.refreshToken });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_REVOKED");
  });

  it("revokes every session for a user", async () => {
    const { auth } = harness();
    const first = await register(auth);
    await auth.login.password({ identifier: "ada@acme.com", password: credentials.password });
    await auth.login.password({ identifier: "ada@acme.com", password: credentials.password });

    const result = await auth.logoutAll({ userId: first.user.id });
    expect(result).toEqual({ ok: true, data: { revoked: 3 } });

    const active = await auth.sessions.list({ userId: first.user.id });
    expect(active.ok).toBe(true);
    if (active.ok) expect(active.data.every((session) => session.revokedAt)).toBe(true);
  });

  it("returns NOT_FOUND for unknown sessions", async () => {
    const { auth } = harness();
    const result = await auth.sessions.revoke({ sessionId: "missing" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("validates logout inputs", async () => {
    const { auth } = harness();
    const result = await auth.logout({});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("createAuth validation", () => {
  it("requires a database and a strong secret", () => {
    expect(() => createAuth({ db: undefined as never, secret: SECRET })).toThrow(/db/);
    expect(() =>
      createAuth({ db: createRawQl({ adapter: new MemoryAdapter() }), secret: "short" }),
    ).toThrow(/secret/);
  });
});
