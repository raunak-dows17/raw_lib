import RawQlEngine from "../rawql/core/engine/raw_ql_engine";

export interface UserEntity {
  _id?: string;
  email?: string | null;
  phone?: string | null;
  username?: string | null;
  passwordHash?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DeviceSessionEntity {
  _id: string;
  userId?: string | null;
  deviceId?: string | null;
  os?: string | null;
  browser?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  createdAt?: string;
  lastUsedAt?: string;
  updatedAt?: string;
  revoked?: boolean;
  metadeta?: Record<string, any>;
}

export interface OtpCodeEntity {
  _id: string;
  userId?: string | null;
  contact?: string;
  codeHash: string;
  salt: string;
  createdAt?: string | null;
  expiresAt: string;
  attempts: number;
  consumed?: boolean;
}

export type RawAuthConfig = {
  rawql: RawQlEngine;
  jwtSecret: string;
  jwtTtlSeconds?: number;
  bcryptRounds?: number;
  otpTtlSeconds?: number;
  otpMaxAttempts?: number;
};
