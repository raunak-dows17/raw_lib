import { Twilio } from "twilio";
import { OtpDeliveryOptions, OtpProvider } from "./otp_provider";

export default class TwilioProvider implements OtpProvider {
  client: Twilio;
  fromPhone: string;

  constructor(accountSid: string, authToken: string, fromPhone: string) {
    this.client = new Twilio(accountSid, authToken);
    this.fromPhone = fromPhone;
  }

  async send(
    code: string,
    opts: OtpDeliveryOptions
  ): Promise<{ ok: boolean; providerId?: string; error?: string }> {
    if (opts.channel !== "sms")
      return { ok: false, error: "TwilioProvider only supports sms channel" };
    try {
      const message = await this.client.messages.create({
        body: `Your Verification Code is ${code}. It Expires in 5 minutes.`,
        from: this.fromPhone,
        to: opts.contact,
      });

      return { ok: true, providerId: message.sid };
    } catch (error: any) {
      return {
        ok: false,
        error: error?.message || "TwilioProvider send error",
      };
    }
  }
}
