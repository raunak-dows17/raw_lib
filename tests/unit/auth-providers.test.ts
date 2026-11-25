import { describe, expect, it } from "vitest";
import { otpRouter, sendgrid, twilio } from "../../src/auth/providers";

type Call = { url: string; init: RequestInit };

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  };

  return { calls, fetch: fetch as typeof globalThis.fetch };
}

describe("twilio provider", () => {
  it("sends an SMS through the Messages API", async () => {
    const { calls, fetch } = fakeFetch(
      () =>
        new Response(JSON.stringify({ sid: "SM123" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = twilio({
      accountSid: "AC123",
      authToken: "token",
      from: "+15550000000",
      fetch,
    });

    const result = await provider.send({
      code: "123456",
      contact: "+15551112222",
      channel: "sms",
      purpose: "login",
    });

    expect(result).toEqual({ ok: true, providerId: "SM123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/Accounts/AC123/Messages.json");

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa("AC123:token")}`);

    const body = calls[0]?.init.body as URLSearchParams;
    expect(body.get("To")).toBe("+15551112222");
    expect(body.get("From")).toBe("+15550000000");
    expect(body.get("Body")).toContain("123456");
  });

  it("supports a custom message body", async () => {
    const { calls, fetch } = fakeFetch(() => new Response("{}", { status: 201 }));
    const provider = twilio({
      accountSid: "AC123",
      authToken: "token",
      from: "+1",
      message: (code) => `Code: ${code}`,
      fetch,
    });

    await provider.send({
      code: "999999",
      contact: "+2",
      channel: "sms",
      purpose: "login",
    });

    const body = calls[0]?.init.body as URLSearchParams | undefined;
    expect(body?.get("Body")).toBe("Code: 999999");
  });

  it("returns typed failures", async () => {
    const failing = twilio({
      accountSid: "AC123",
      authToken: "token",
      from: "+1",
      fetch: fakeFetch(() => new Response("nope", { status: 500 })).fetch,
    });
    const throwing = twilio({
      accountSid: "AC123",
      authToken: "token",
      from: "+1",
      fetch: (async () => {
        throw new Error("network down");
      }) as typeof globalThis.fetch,
    });

    await expect(
      failing.send({ code: "1", contact: "+2", channel: "sms", purpose: "login" }),
    ).resolves.toEqual({ ok: false, error: "twilio responded with 500" });

    await expect(
      throwing.send({ code: "1", contact: "+2", channel: "sms", purpose: "login" }),
    ).resolves.toEqual({ ok: false, error: "network down" });
  });

  it("rejects non-SMS channels without calling the API", async () => {
    const { calls, fetch } = fakeFetch(() => new Response("{}"));
    const provider = twilio({ accountSid: "AC", authToken: "t", from: "+1", fetch });

    const result = await provider.send({
      code: "1",
      contact: "a@b.co",
      channel: "email",
      purpose: "login",
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("sendgrid provider", () => {
  it("sends an email through the Mail Send API", async () => {
    const { calls, fetch } = fakeFetch(
      () =>
        new Response(null, {
          status: 202,
          headers: { "x-message-id": "msg-1" },
        }),
    );
    const provider = sendgrid({
      apiKey: "SG.key",
      from: "noreply@acme.com",
      fetch,
    });

    const result = await provider.send({
      code: "123456",
      contact: "ada@acme.com",
      channel: "email",
      purpose: "login",
    });

    expect(result).toEqual({ ok: true, providerId: "msg-1" });
    expect(calls[0]?.url).toBe("https://api.sendgrid.com/v3/mail/send");

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer SG.key");

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.personalizations[0].to[0].email).toBe("ada@acme.com");
    expect(body.from.email).toBe("noreply@acme.com");
    expect(body.content[0].value).toContain("123456");
  });

  it("returns typed failures and rejects other channels", async () => {
    const failing = sendgrid({
      apiKey: "key",
      from: "noreply@acme.com",
      fetch: fakeFetch(() => new Response("no", { status: 400 })).fetch,
    });

    await expect(
      failing.send({
        code: "1",
        contact: "a@b.co",
        channel: "email",
        purpose: "login",
      }),
    ).resolves.toEqual({ ok: false, error: "sendgrid responded with 400" });

    await expect(
      failing.send({ code: "1", contact: "+1", channel: "sms", purpose: "login" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("handles network failures", async () => {
    const provider = sendgrid({
      apiKey: "key",
      from: "noreply@acme.com",
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof globalThis.fetch,
    });

    await expect(
      provider.send({ code: "1", contact: "a@b.co", channel: "email", purpose: "login" }),
    ).resolves.toEqual({ ok: false, error: "offline" });
  });
});

describe("otpRouter", () => {
  it("routes by channel", async () => {
    const calls: string[] = [];
    const sms = {
      async send() {
        calls.push("sms");
        return { ok: true };
      },
    };
    const email = {
      async send() {
        calls.push("email");
        return { ok: true };
      },
    };
    const router = otpRouter({ sms, email });

    await router.send({ code: "1", contact: "+1", channel: "sms", purpose: "login" });
    await router.send({ code: "1", contact: "a@b.co", channel: "email", purpose: "login" });

    expect(calls).toEqual(["sms", "email"]);
  });

  it("fails when a channel has no provider", async () => {
    const router = otpRouter({ sms: { send: async () => ({ ok: true }) } });

    await expect(
      router.send({ code: "1", contact: "a@b.co", channel: "email", purpose: "login" }),
    ).resolves.toEqual({ ok: false, error: "no provider configured for email" });
  });
});
