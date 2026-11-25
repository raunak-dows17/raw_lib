import type { OtpProvider } from "../types";

export type SendGridOptions = {
  apiKey: string;
  /** Verified sender address. */
  from: string;
  subject?: string;
  /** Override the plain-text body. */
  message?: (code: string) => string;
  fetch?: typeof globalThis.fetch;
};

/** SendGrid email delivery through the v3 Mail Send API. */
export function sendgrid(options: SendGridOptions): OtpProvider {
  const send = options.fetch ?? globalThis.fetch;
  const subject = options.subject ?? "Your verification code";
  const message = options.message ?? ((code: string) => `Your verification code is ${code}.`);

  return {
    async send({ code, contact, channel }) {
      if (channel !== "email") {
        return { ok: false, error: "sendgrid only supports email delivery" };
      }

      if (typeof send !== "function") {
        return { ok: false, error: "fetch is not available in this runtime" };
      }

      try {
        const response = await send("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: contact }] }],
            from: { email: options.from },
            subject,
            content: [{ type: "text/plain", value: message(code) }],
          }),
        });

        if (!response.ok) {
          return { ok: false, error: `sendgrid responded with ${response.status}` };
        }

        const providerId = response.headers.get("x-message-id") ?? undefined;
        return { ok: true, ...(providerId ? { providerId } : {}) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "sendgrid request failed",
        };
      }
    },
  };
}
