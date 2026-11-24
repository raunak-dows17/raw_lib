import type { OtpChannel, OtpProvider } from "../types";

export type OtpRouterOptions = {
  sms?: OtpProvider;
  email?: OtpProvider;
};

/** Route OTP delivery to a channel-specific provider. */
export function otpRouter(options: OtpRouterOptions): OtpProvider {
  return {
    async send(input) {
      const provider = options[input.channel as OtpChannel];
      if (!provider) {
        return { ok: false, error: `no provider configured for ${input.channel}` };
      }

      return provider.send(input);
    },
  };
}
