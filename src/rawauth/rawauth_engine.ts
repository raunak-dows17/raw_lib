import { compare } from "bcrypt";
import {
  RawQlResponse,
  RawQlSingleResponse,
} from "../rawql/config/types/rawql_response";
import RawQlEngine from "../rawql/core/engine/raw_ql_engine";
import { failure, nowIso, successMultiple, successSingle } from "./helpers";
import { OtpService } from "./services/otp_service";
import { SessionService } from "./services/session_service";
import { TokenService } from "./services/token_service";
import { DeviceSessionEntity, RawAuthConfig, UserEntity } from "./types";

/**
 * RawAuthEngine - orchestrates high level flows.
 * Returns RawQlResponse objects exclusively (never throws).
 */
export class RawAuthEngine {
  private rawql: RawQlEngine;
  private cfg: RawAuthConfig;
  private sessionService: SessionService;
  private otpService: OtpService;
  private tokenService: TokenService;

  constructor(cfg: RawAuthConfig) {
    this.rawql = cfg.rawql;
    this.cfg = cfg;
    this.sessionService = new SessionService(this.rawql);
    this.otpService = new OtpService(
      this.rawql,
      cfg.otpTtlSeconds,
      cfg.otpMaxAttempts
    );
    this.tokenService = new TokenService(
      this.rawql,
      cfg.jwtSecret,
      cfg.jwtTtlSeconds
    );
  }

  // ---------------------
  // User helpers (return RawQlResponse)
  // ---------------------
  private async findUserByIdentifier(identifier: {
    email?: string;
    phone?: string;
    username?: string;
  }): Promise<RawQlResponse<UserEntity>> {
    try {
      if (identifier.email) {
        const r = (await this.rawql.execute<UserEntity>({
          type: "get",
          entity: "users",
          filter: { field: "email", op: "eq", value: identifier.email },
        })) as RawQlResponse<UserEntity>;

        if (r.status && r.data && r.data.type === "single") {
          return r;
        }
      }

      if (identifier.phone) {
        const r = (await this.rawql.execute<UserEntity>({
          type: "get",
          entity: "users",
          filter: { field: "phone", op: "eq", value: identifier.phone },
        })) as RawQlResponse<UserEntity>;

        if (r.status && r.data && r.data.type === "single") {
          return r;
        }
      }

      if (identifier.username) {
        const r = (await this.rawql.execute<UserEntity>({
          type: "get",
          entity: "users",
          filter: { field: "username", op: "eq", value: identifier.username },
        })) as RawQlResponse<UserEntity>;

        if (r.status && r.data && r.data.type === "single") {
          return r;
        }
      }

      throw new Error("User not found");
    } catch (error: any) {
      return failure(error.message ?? "findUser error");
    }
  }

  private async createUser(
    userPatch: Partial<UserEntity>
  ): Promise<RawQlResponse<UserEntity>> {
    try {
      return (await this.rawql.execute<UserEntity>({
        type: "create",
        entity: "User",
        data: { ...userPatch, createdAt: nowIso(), updatedAt: nowIso() },
      })) as RawQlResponse<UserEntity>;
    } catch (error: any) {
      return failure(error.message || "createUser error");
    }
  }

  // ---------------------
  // Public flows
  // ---------------------

  /**
   * loginWithPassword -> returns RawQlResponse<{ token, session, user }>
   * token is returned inside single.item object
   */
  async loginWithPassword(params: {
    identifiers: { email?: string; username?: string; phone?: string };
    passwords: string;
    fingerPrint?: any;
    ip?: string;
    userAgent?: string;
  }): Promise<
    RawQlResponse<{
      token: string;
      session: DeviceSessionEntity;
      user: UserEntity;
    }>
  > {
    try {
      const found = await this.findUserByIdentifier(params.identifiers);
      if (!found.status) throw new Error("Invalid Credentials");
      const user = (found.data as RawQlSingleResponse<UserEntity>).item;
      if (!user.passwordHash) throw new Error("Invalid Credentials");
      const ok = await compare(params.passwords, user.passwordHash);
      if (!ok) throw new Error("Invalid Credentials");

      const sessionRes = await this.sessionService.create(user._id!, {
        ...params.fingerPrint,
        ip: params.ip,
        userAgent: params.userAgent,
      });
      if (!sessionRes.status)
        throw new Error(sessionRes.message || "Session creation failed");
      const session = (
        sessionRes.data as RawQlSingleResponse<DeviceSessionEntity>
      ).item;

      const tokenRes = this.tokenService.issue(session._id);
      if (!tokenRes.status)
        throw new Error(tokenRes.message || "Token issuance failed");
      const token = (tokenRes.data as RawQlSingleResponse<{ token: string }>)
        .item;

      return successSingle<{
        token: string;
        session: DeviceSessionEntity;
        user: UserEntity;
      }>({ token: token.token, session, user }, "Login Successful");
    } catch (error: any) {
      return failure(error?.message || "loginWithPassword error");
    }
  }

  /**
   * passwordless login: find or create user, create session, issue token
   */
  async passwordLessLogin(params: {
    contact: { email?: string; phone?: string };
    createUserIfNotExists?: boolean;
    fingerPrint?: any;
    ip?: string;
    userAgent?: string;
  }): Promise<
    RawQlResponse<{
      token: string;
      session: DeviceSessionEntity;
      user: UserEntity;
    }>
  > {
    try {
      const found = await this.findUserByIdentifier(params.contact);
      let userRes = found;

      if (!found.status && params.createUserIfNotExists) {
        userRes = await this.createUser(params.contact);
      }

      if (!userRes.status || !userRes.data)
        throw new Error("User retrieval/creation failed");

      const user = (userRes.data as RawQlSingleResponse<UserEntity>).item;
      const sessionRes = await this.sessionService.create(user._id!, {
        ...params.fingerPrint,
        ip: params.ip,
        userAgent: params.userAgent,
      });
      if (!sessionRes.status)
        throw new Error(sessionRes.message || "Session creation failed");
      const session = (
        sessionRes.data as RawQlSingleResponse<DeviceSessionEntity>
      ).item;

      const tokenRes = this.tokenService.issue(session._id);
      if (!tokenRes.status)
        throw new Error(tokenRes.message || "Token issuance failed");
      const token = (tokenRes.data as RawQlSingleResponse<{ token: string }>)
        .item;

      return successSingle<{
        token: string;
        session: DeviceSessionEntity;
        user: UserEntity;
      }>(
        { token: token.token, session, user },
        "Passwordless Login Successful"
      );
    } catch (error: any) {
      return failure(error?.message || "passwordLessLogin error");
    }
  }

  async sendOtp(contact: string, revealCode = false) {
    return this.otpService.sendOtp(contact, revealCode);
  }

  async verifyOtp(otpId: string, code: string) {
    return this.otpService.verifyOtp(otpId, code);
  }

  async verifyToken(token: string, fingerprint: any) {
    return this.tokenService.verify(token, fingerprint);
  }

  async logout(sessionId: string) {
    return this.sessionService.revokeById(sessionId);
  }

  async listSessions(userId: string) {
    return this.sessionService.listByUser(userId);
  }

  async revokeSession(sessionId: string) {
    return this.sessionService.revokeById(sessionId);
  }
}
