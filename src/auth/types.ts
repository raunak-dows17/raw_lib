import type { Result } from "../core/types/result";
import type { Device, FingerprintConfig } from "./fingerprint";
import type { PasswordConfig } from "./password";
import type { AccessClaims } from "./tokens";

export type User = {
  id: string;
  email?: string | null;
  phone?: string | null;
  username?: string | null;
  passwordHash?: string | null;
  roles?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type PublicUser = Omit<User, "passwordHash">;

export type Session = {
  id: string;
  userId: string;
  familyId: string;
  deviceIdHash?: string | null;
  userAgentHash?: string | null;
  ip?: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  refreshTokenHash: string;
  refreshTokenExpiresAt: string;
  refreshTokenHistory?: string[];
  rotation: number;
  metadata?: Record<string, unknown>;
};

export type PublicSession = Omit<Session, "refreshTokenHash" | "refreshTokenHistory">;

export type AuthSuccess = {
  user: PublicUser;
  session: PublicSession;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
};

export type VerifySuccess = {
  user: PublicUser;
  session: PublicSession;
  claims: AccessClaims;
};

export type RegisterInput = {
  email?: string;
  phone?: string;
  username?: string;
  password: string;
  roles?: string[];
  device?: Device;
  metadata?: Record<string, unknown>;
};

export type Identifier = string | { email?: string; phone?: string; username?: string };

export type PasswordLoginInput = {
  identifier: Identifier;
  password: string;
  device?: Device;
};

export type RefreshInput = {
  refreshToken: string;
  device?: Device;
};

export type VerifyInput = {
  accessToken: string;
  device?: Device;
};

export type LogoutInput = {
  refreshToken?: string;
  sessionId?: string;
};

export type LogoutAllInput = {
  userId: string;
};

export type SessionListInput = {
  userId: string;
  limit?: number;
  offset?: number;
};

export type SessionRevokeInput = {
  sessionId: string;
};

export type AuthHooks = {
  onLogin?: (context: { user: PublicUser; session: PublicSession }) => void | Promise<void>;
  onLoginFailed?: (context: {
    identifier?: string;
    reason: string;
    ip?: string;
  }) => void | Promise<void>;
  onSessionRevoked?: (context: { session: PublicSession; reason: string }) => void | Promise<void>;
  onRefreshReuse?: (context: { session: PublicSession }) => void | Promise<void>;
};

export type AuthEntityNames = {
  users: string;
  sessions: string;
  otps: string;
};

export type AuthConfig = {
  db: import("../core/engine/engine").RawQl;
  /** HMAC signing secret. Must be at least 16 bytes. */
  secret: string | Uint8Array;
  entities?: Partial<AuthEntityNames>;
  /** Access token lifetime. Defaults to `15m`. */
  accessTtl?: string | number;
  /** Refresh token/session lifetime. Defaults to `30d`. */
  refreshTtl?: string | number;
  password?: PasswordConfig;
  fingerprint?: FingerprintConfig;
  hooks?: AuthHooks;
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
  /** Rotated refresh hashes retained for reuse detection. Defaults to 20. */
  refreshHistoryLimit?: number;
};

export type Auth = {
  register(input: RegisterInput): Promise<Result<AuthSuccess>>;
  login: {
    password(input: PasswordLoginInput): Promise<Result<AuthSuccess>>;
  };
  refresh(input: RefreshInput): Promise<Result<AuthSuccess>>;
  verify(input: VerifyInput): Promise<Result<VerifySuccess>>;
  logout(input: LogoutInput): Promise<Result<{ revoked: boolean }>>;
  logoutAll(input: LogoutAllInput): Promise<Result<{ revoked: number }>>;
  sessions: {
    list(input: SessionListInput): Promise<Result<PublicSession[]>>;
    revoke(input: SessionRevokeInput): Promise<Result<PublicSession>>;
  };
};
