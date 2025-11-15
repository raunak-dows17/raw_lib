import { randomBytes } from "crypto";
import {
  RawQlResponse,
  RawQlSingleResponse,
} from "../../rawql/config/types/rawql_response";
import RawQlEngine from "../../rawql/core/engine/raw_ql_engine";
import {
  failure,
  genJti,
  genOtpCode,
  sha256Hex,
  successSingle,
} from "../helpers";
import { OtpCodeEntity } from "../types";
import { RawQlRequest } from "../../rawql/config/types/rawql_request";
import { OtpProvider } from "../providers/otp_provider";

export class OtpService {
  constructor(
    private rawql: RawQlEngine,
    private otpTtlSeconds: number = 300,
    private otpMaxAttempts: number = 5,
    private provider?: OtpProvider
  ) {}

  /**
   * Creates an OTP row in DB. Returns RawQlResponse with the created OTP record (single).
   * NOTE: in production do NOT return the code. For testing you can pass { revealCode: true } in options.
   */
  async sendOtp(
    contact: string,
    revealCode = false
  ): Promise<RawQlResponse<{ otpId: string; code?: string }>> {
    try {
      const code = genOtpCode(6);
      const salt = randomBytes(8).toString("hex");
      const codeHash = sha256Hex(code + salt);
      const expiresAt = new Date(
        Date.now() + this.otpTtlSeconds * 1000
      ).toISOString();

      const otp: OtpCodeEntity = {
        _id: genJti(),
        contact,
        codeHash,
        salt,
        expiresAt,
        attempts: 0,
        consumed: false,
      };

      const req: RawQlRequest = {
        type: "create",
        entity: "otpCodes",
        data: otp,
      };

      const res = await this.rawql.execute<OtpCodeEntity>(req);

      if (!res.status) throw new Error(res.message);

      const body: any = { otpId: otp._id };
      if (revealCode) body.code = code;

      if (this.provider) {
        const delivery = await this.provider.send(code, {
          contact,
          channel: contact.includes("@") ? "email" : "sms",
        });

        if (!delivery.ok) {
          throw new Error(`OTP delivery failed: ${delivery.error}`);
        }
      }

      return successSingle<{ otpId: string; code?: string }>(
        body,
        "OTP created"
      );
    } catch (error: any) {
      return failure(error?.message || "otp.create error");
    }
  }

  /**
   * Verifies OTP by id and code.
   * Returns RawQlResponse<{ ok: true, userId?: string }>
   */

  async verifyOtp(
    otpId: string,
    code: string
  ): Promise<RawQlResponse<{ ok: true; userId?: string | null }>> {
    try {
      const req: RawQlRequest = {
        type: "get",
        entity: "otpCodes",
        id: otpId,
      };

      const res = await this.rawql.execute<OtpCodeEntity>(req);
      if (!res.status) throw new Error(res.message);
      const otpRow = (res.data as RawQlSingleResponse<OtpCodeEntity>).item;

      if (otpRow.consumed) throw new Error("OTP already used");
      if (new Date(otpRow.expiresAt) < new Date())
        throw new Error("OTP expired");
      if ((otpRow.attempts || 0) >= this.otpMaxAttempts)
        throw new Error("OTP max attempts exceeded");

      const ok = sha256Hex(code + otpRow.salt) === otpRow.codeHash;

      if (!ok) {
        await this.rawql.execute<OtpCodeEntity>({
          type: "update",
          entity: "otpCodes",
          id: otpId,
          data: {
            attempts: (otpRow.attempts || 0) + 1,
          } as OtpCodeEntity,
        });

        throw new Error("Invalid Otp");
      }

      await this.rawql.execute<OtpCodeEntity>({
        type: "update",
        entity: "otpCodes",
        id: otpRow._id,
        data: {
          attempts: (otpRow.attempts || 0) + 1,
          consumed: true,
        } as OtpCodeEntity,
      });

      return successSingle<{ ok: true; userId?: string | null }>(
        { ok: true, userId: otpRow.userId },
        "OTP verified"
      );
    } catch (error: any) {
      return failure(error?.message || "otp.verify error");
    }
  }
}
