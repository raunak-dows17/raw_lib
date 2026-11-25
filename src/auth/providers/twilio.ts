import type { OtpProvider } from "../types";

export type TwilioOptions = {
  accountSid: string;
  authToken: string;
  from: string;
  /** Override the message body. */
  message?: (code: string) => string;
  fetch?: typeof globalThis.fetch;
};

/**
 * Twilio SMS delivery through the Messages REST API. Uses `fetch` so it works on
 * Node 18+, edge runtimes, and in tests with an injected implementation.
 */
export function twilio(options: TwilioOptions): OtpProvider {
  const send = options.fetch ?? globalThis.fetch;
  const message = options.message ?? ((code: string) => `Your verification code is ${code}`);

  return {
    async send({ code, contact, channel }) {
      if (channel !== "sms") {
        return { ok: false, error: "twilio only supports sms delivery" };
      }

      if (typeof send !== "function") {
        return { ok: false, error: "fetch is not available in this runtime" };
      }

      const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
        options.accountSid,
      )}/Messages.json`;

      try {
        const response = await send(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`${options.accountSid}:${options.authToken}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: contact,
            From: options.from,
            Body: message(code),
          }),
        });

        if (!response.ok) {
          return { ok: false, error: `twilio responded with ${response.status}` };
        }

        const payload = (await response.json().catch(() => ({}))) as { sid?: string };
        return { ok: true, ...(payload.sid ? { providerId: payload.sid } : {}) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "twilio request failed",
        };
      }
    },
  };
}
