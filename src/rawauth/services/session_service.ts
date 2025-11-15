import { RawQlResponse } from "../../rawql/config/types/rawql_response";
import RawQlEngine from "../../rawql/core/engine/raw_ql_engine";
import { failure, genJti, nowIso } from "../helpers";
import { DeviceSessionEntity } from "../types";

/**
 * SessionService: focused small wrapper around rawql for deviceSessions
 *
 * All methods return RawQlResponse-like objects (never throw).
 */

export class SessionService {
  constructor(private rawql: RawQlEngine) {}

  async create(
    userId: string,
    fingerprint: Partial<DeviceSessionEntity>,
    metadeta: Record<string, any> = {}
  ): Promise<RawQlResponse<number | DeviceSessionEntity>> {
    try {
      return await this.rawql.execute<DeviceSessionEntity>({
        type: "create",
        entity: "deviceSessions",
        data: {
          _id: genJti(),
          userId,
          deviceId: fingerprint.deviceId || null,
          os: fingerprint.os || null,
          browser: fingerprint.browser || null,
          ip: fingerprint.ip || null,
          userAgent: fingerprint.userAgent || null,
          createdAt: nowIso(),
          lastUsedAt: nowIso(),
          revoked: false,
          metadeta,
        } as DeviceSessionEntity,
      });
    } catch (error: any) {
      return failure(error?.message || "Failed to create device session");
    }
  }

  async getById(
    id: string
  ): Promise<RawQlResponse<number | DeviceSessionEntity>> {
    try {
      return await this.rawql.execute<DeviceSessionEntity>({
        type: "get",
        entity: "deviceSessions",
        id,
      });
    } catch (error: any) {
      return failure(error?.message || "session.get error");
    }
  }

  async listByUser(
    userId: string
  ): Promise<RawQlResponse<number | DeviceSessionEntity>> {
    try {
      return await this.rawql.execute<DeviceSessionEntity>({
        type: "list",
        entity: "deviceSessions",
        filter: { field: "userId", op: "eq", value: userId },
        options: { limit: 100 },
      });
    } catch (error: any) {
      return failure(error?.message || "session.listByUser error");
    }
  }

  async revokeById(
    id: string
  ): Promise<RawQlResponse<number | DeviceSessionEntity>> {
    try {
      return await this.rawql.execute<DeviceSessionEntity>({
        type: "update",
        entity: "deviceSessions",
        id,
        data: { revoked: true, updatedAt: nowIso() } as DeviceSessionEntity,
      });
    } catch (error: any) {
      return failure(error?.message || "session.revokeById error");
    }
  }
}
