import {
  RawQlResponse,
  RawQlSingleResponse,
} from "../../rawql/config/types/rawql_response";
import RawQlEngine from "../../rawql/core/engine/raw_ql_engine";
import { failure, matchFingerPrint, nowIso, successSingle } from "../helpers";
import { sign, verify } from "jsonwebtoken";
import { DeviceSessionEntity } from "../types";

export class TokenService {
  constructor(
    private rawql: RawQlEngine,
    private jwtSecret: string,
    private jwtTtlSeconds?: number
  ) {}

  issue(sessionId: string): RawQlResponse<{ token: string }> {
    try {
      const token = sign({ jti: sessionId }, this.jwtSecret, {
        expiresIn: this.jwtTtlSeconds,
      });
      return successSingle<{ token: string }>({ token });
    } catch (error: any) {
      return failure(error?.message || "token.issue error");
    }
  }

  /**
   * Verify token -> load session -> fingerprint check -> update lastUsedAt
   * Returns RawQlResponse<DeviceSessionEntity>
   */
  async verify(
    token: string,
    fingerprint: {
      deviceId: string | null;
      userAgent: string | null;
      ip: string | null;
    }
  ): Promise<RawQlResponse<DeviceSessionEntity>> {
    try {
      let decoded: any;

      try {
        decoded = verify(token, this.jwtSecret) as any;
      } catch (error: any) {
        throw error;
      }

      const jti = decoded?.jti;

      if (!jti) throw new Error("Invalid token");

      const res = await this.rawql.execute<DeviceSessionEntity>({
        type: "get",
        entity: "deviceSessions",
        id: jti,
      });

      if (!res.status) throw new Error(res.message);

      const session = (res.data as RawQlSingleResponse<DeviceSessionEntity>)
        .item;

      if (!session) throw new Error("Session not found");
      if (session.revoked) throw new Error("Session revoked");

      const ok = matchFingerPrint(
        {
          deviceId: session.deviceId ?? null,
          ip: session.ip ?? null,
          userAgent: session.userAgent ?? null,
        },
        fingerprint
      );

      if (!ok) throw new Error("Fingerprint mismatch");

      await this.rawql.execute<DeviceSessionEntity>({
        type: "update",
        entity: "deviceSessions",
        id: session._id,
        data: {
          lastUsedAt: nowIso(),
        } as DeviceSessionEntity,
      });

      return successSingle<DeviceSessionEntity>(session, "Token verified");
    } catch (error: any) {
      return failure(error?.message || "token.verify error");
    }
  }
}
