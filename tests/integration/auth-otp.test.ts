import { describe, expect, it, vi } from "vitest";
import { type AuthConfig, createAuth, type OtpProvider } from "../../src/auth";
import { createRawQl, MemoryAdapter } from "../../src/index";

const SECRET = "otp-integration-secret-0123";

type Sent = {
  code: string;
  contact: string;
  channel: "sms" | "email";
  purpose: "login" | "verify";
};

function createClock(start = "2026-01-01T00:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

function harness(
  overrides: Partial<AuthConfig> = {},
  providerResult: { ok: boolean; providerId?: string; error?: string } = {
    ok: true,
    providerId: "provider-1",
  },
) {
  const clock = createClock();
  const db = createRawQl({ adapter: new MemoryAdapter() });
  const sent: Sent[] = [];
  const provider: OtpProvider = {
    async send(input) {
      sent.push(input);
      return providerResult;
    },
  };

  const auth = createAuth({
    db,
    secret: SECRET,
    clock: clock.now,
    ...overrides,
    otp: {
      provider,
      rateLimit: false,
      ...(overrides.otp ?? {}),
    },
  });

  return { auth, db, clock, sent, provider };
}

async function seedUser(auth: ReturnType<typeof harness>["auth"]) {
  const result = await auth.register({
    email: "ada@acme.com",
    phone: "+15550001111",
    password: "password123",
  });
  if (!result.ok) throw new Error(`register failed: ${result.error.message}`);
  return result.data;
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe("OTP request", () => {
  it("sends a code to an existing email user", async () => {
    const { auth, sent } = harness();
    await seedUser(auth);

    const result = await auth.login.otp.request({ contact: "Ada@Acme.com" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.channel).toBe("email");
    expect(result.data.otpId).toBeTruthy();
    expect(result.data.expiresAt).toBeTruthy();
    expect(JSON.stringify(result.data)).not.toContain(sent[0]?.code);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      contact: "ada@acme.com",
      channel: "email",
      purpose: "login",
    });
    expect(sent[0]?.code).toMatch(/^\d{6}$/);
  });

  it("detects SMS contacts and honours explicit channels and purposes", async () => {
    const { auth, sent } = harness();
    await seedUser(auth);

    const sms = await auth.login.otp.request({
      contact: "+15550001111",
      purpose: "verify",
    });

    expect(sms.ok).toBe(true);
    if (sms.ok) expect(sms.data.channel).toBe("sms");
    expect(sent[0]).toMatchObject({ channel: "sms", purpose: "verify" });
  });

  it("uses the configured code length", async () => {
    const { auth, sent } = harness({ otp: { length: 8 } });
    await seedUser(auth);

    await auth.login.otp.request({ contact: "ada@acme.com" });
    expect(sent[0]?.code).toMatch(/^\d{8}$/);
  });

  it("returns the same shape for unknown contacts without sending", async () => {
    const { auth, sent } = harness();
    await seedUser(auth);

    const result = await auth.login.otp.request({ contact: "nobody@acme.com" });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("throttles repeated requests per contact", async () => {
    const { auth } = harness({ otp: { rateLimit: { window: "15m", max: 2 } } });
    await seedUser(auth);

    expect(await auth.login.otp.request({ contact: "ada@acme.com" })).toMatchObject({
      ok: true,
    });
    expect(await auth.login.otp.request({ contact: "ada@acme.com" })).toMatchObject({
      ok: true,
    });

    const limited = await auth.login.otp.request({ contact: "ada@acme.com" });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe("RATE_LIMITED");
  });

  it("validates contacts", async () => {
    const { auth } = harness();
    await seedUser(auth);

    const invalidEmail = await auth.login.otp.request({
      contact: "not-an-email",
      channel: "email",
    });
    const empty = await auth.login.otp.request({ contact: "  " });

    expect(invalidEmail.ok).toBe(false);
    if (!invalidEmail.ok) expect(invalidEmail.error.code).toBe("VALIDATION_FAILED");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("VALIDATION_FAILED");
  });

  it("requires a provider and reports delivery failures", async () => {
    const noProvider = createAuth({
      db: createRawQl({ adapter: new MemoryAdapter() }),
      secret: SECRET,
      otp: { rateLimit: false },
    });
    const missing = await noProvider.login.otp.request({ contact: "a@b.co" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("INTERNAL_ERROR");

    const onOtpFailed = vi.fn();
    const failing = harness({ hooks: { onOtpFailed } }, { ok: false, error: "down" });
    await seedUser(failing.auth);

    const result = await failing.auth.login.otp.request({ contact: "ada@acme.com" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(onOtpFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "send_failed", channel: "email" }),
    );
  });

  it("invokes onOtpSent with provider metadata", async () => {
    const onOtpSent = vi.fn();
    const { auth } = harness({ hooks: { onOtpSent } });
    await seedUser(auth);

    await auth.login.otp.request({ contact: "ada@acme.com" });

    expect(onOtpSent).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "provider-1", channel: "email", purpose: "login" }),
    );
  });
});

describe("OTP verification", () => {
  it("issues tokens and creates a device-bound session", async () => {
    const { auth, sent } = harness();
    const user = await seedUser(auth);
    const request = await auth.login.otp.request({ contact: "ada@acme.com" });
    if (!request.ok) throw new Error("request failed");

    const result = await auth.login.otp.verify({
      otpId: request.data.otpId,
      code: sent[0]?.code ?? "",
      device: { deviceId: "device-1" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.user.id).toBe(user.user.id);
    expect(result.data.accessToken.split(".")).toHaveLength(3);
    expect(result.data.refreshToken).toBeTruthy();

    const verified = await auth.verify({
      accessToken: result.data.accessToken,
      device: { deviceId: "device-1" },
    });
    expect(verified.ok).toBe(true);
  });

  it("supports phone contacts", async () => {
    const { auth, sent } = harness();
    await seedUser(auth);

    const request = await auth.login.otp.request({ contact: "+15550001111" });
    if (!request.ok) throw new Error("request failed");

    const result = await auth.login.otp.verify({
      otpId: request.data.otpId,
      code: sent[0]?.code ?? "",
    });

    expect(result.ok).toBe(true);
  });

  it("rejects unknown, malformed, and reused codes", async () => {
    const { auth, sent } = harness();
    await seedUser(auth);
    const request = await auth.login.otp.request({ contact: "ada@acme.com" });
    if (!request.ok) throw new Error("request failed");

    const unknown = await auth.login.otp.verify({ otpId: "missing", code: "123456" });
    const empty = await auth.login.otp.verify({ otpId: request.data.otpId, code: "" });

    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("OTP_INVALID");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("OTP_INVALID");

    const first = await auth.login.otp.verify({
      otpId: request.data.otpId,
      code: sent[0]?.code ?? "",
    });
    const second = await auth.login.otp.verify({
      otpId: request.data.otpId,
      code: sent[0]?.code ?? "",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("OTP_ALREADY_USED");
  });

  it("counts failed attempts and locks the code", async () => {
    const onOtpFailed = vi.fn();
    const { auth, sent } = harness({
      otp: { maxAttempts: 2 },
      hooks: { onOtpFailed },
    });
    await seedUser(auth);
    const request = await auth.login.otp.request({ contact: "ada@acme.com" });
    if (!request.ok) throw new Error("request failed");

    const bad = wrongCode(sent[0]?.code ?? "");
    const first = await auth.login.otp.verify({ otpId: request.data.otpId, code: bad });
    const second = await auth.login.otp.verify({ otpId: request.data.otpId, code: bad });
    const correct = await auth.login.otp.verify({
      otpId: request.data.otpId,
      code: sent[0]?.code ?? "",
    });

    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("OTP_INVALID");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("OTP_ATTEMPTS_EXCEEDED");
    expect(correct.ok).toBe(false);
    if (!correct.ok) expect(correct.error.code).toBe("OTP_ATTEMPTS_EXCEEDED");

    expect(onOtpFailed).toHaveBeenCalledTimes(2);
  });

  it("rejects expired codes", async () => {
    const { auth, sent, clock } = harness({ otp: { ttl: "1m" } });
    await seedUser(auth);
    const request = await auth.login.otp.request({ contact: "ada@acme.com" });
    if (!request.ok) throw new Error("request failed");

    clock.advance(61_000);

    const result = await auth.login.otp.verify({
      otpId: request.data.otpId,
      code: sent[0]?.code ?? "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OTP_EXPIRED");
  });

  it("rejects correct codes for contacts without a user", async () => {
    const { auth } = harness();
    await seedUser(auth);
    const request = await auth.login.otp.request({ contact: "nobody@acme.com" });
    if (!request.ok) throw new Error("request failed");

    const result = await auth.login.otp.verify({
      otpId: request.data.otpId,
      code: "123456",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OTP_INVALID");
  });

  it("does not allow a code from a failed delivery", async () => {
    const { auth, db, sent } = harness({}, { ok: false, error: "down" });
    await seedUser(auth);
    const request = await auth.login.otp.request({ contact: "ada@acme.com" });
    expect(request.ok).toBe(false);

    const stored = await db.execute<{ id: string }[]>({ op: "list", entity: "otps" });
    const otpId = stored.ok ? stored.data[0]?.id : undefined;

    const result = await auth.login.otp.verify({
      otpId: otpId ?? "",
      code: sent[0]?.code ?? "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OTP_ALREADY_USED");
  });
});
