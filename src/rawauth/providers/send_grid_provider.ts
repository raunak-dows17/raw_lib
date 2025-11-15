import sgMail from "@sendgrid/mail";
import { OtpProvider, OtpDeliveryOptions } from "./otp_provider";

export default class SendgridProvider implements OtpProvider {
  fromEmail: string;
  constructor(apiKey: string, fromEmail: string) {
    sgMail.setApiKey(apiKey);
    this.fromEmail = fromEmail;
  }

  async send(code: string, opts: OtpDeliveryOptions) {
    if (opts.channel !== "email")
      return {
        ok: false,
        error: "SendGrid provider configured for email only",
      };
    try {
      await sgMail.send({
        to: opts.contact,
        from: this.fromEmail,
        subject: opts.subject ?? "Your verification code",
        text: `Your verification code is ${code}. It expires in 5 minutes.`,
        html: `<p>Your verification code is <strong>${code}</strong>. It expires in 5 minutes.</p>`,
      });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message ?? String(err) };
    }
  }
}
