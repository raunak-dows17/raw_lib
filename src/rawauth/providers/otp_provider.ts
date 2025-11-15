export type OtpDeliveryOptions = {
  contact: string;
  channel: "sms" | "email";
  subject?: string;
  template?: string;
  variables?: Record<string, any>;
};

export interface OtpProvider {
  send(
    plainColde: string,
    opts: OtpDeliveryOptions
  ): Promise<{ ok: boolean; providerId?: string; error?: string }>;
}
