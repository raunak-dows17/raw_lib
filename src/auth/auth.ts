import type { RawQl } from "../core/engine/engine";
import type { RawLibErrorShape } from "../core/errors";
import { RawLibError, toRawLibError } from "../core/errors";
import type { Where } from "../core/types/query";
import type { Result } from "../core/types/result";
import { randomId, randomToken, sha256Hex } from "./crypto";
import {
  compareFingerprint,
  type Device,
  type FingerprintPolicy,
  hashDevice,
  type StoredFingerprint,
} from "./fingerprint";
import { defaultPasswordHasher, type PasswordHasher } from "./password";
import { parseDuration, toSeconds } from "./time";
import { type AccessClaims, signAccessToken, verifyAccessToken } from "./tokens";
import type {
  Auth,
  AuthConfig,
  AuthEntityNames,
  AuthHooks,
  AuthSuccess,
  Identifier,
  PublicSession,
  PublicUser,
  Session,
  User,
  VerifySuccess,
} from "./types";

const DEFAULT_ENTITIES: AuthEntityNames = {
  users: "users",
  sessions: "sessions",
  otps: "otps",
};

const DEFAULT_PASSWORD_MIN_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

function failure<T>(error: RawLibErrorShape): Result<T> {
  return { ok: false, error };
}

function publicUser(user: User): PublicUser {
  const copy = { ...user } as Partial<User>;
  delete copy.passwordHash;
  return copy as PublicUser;
}

function publicSession(session: Session): PublicSession {
  const copy = { ...session } as Partial<Session>;
  delete copy.refreshTokenHash;
  delete copy.refreshTokenHistory;
  return copy as PublicSession;
}

function normalizeIdentifier(identifier?: string | null): string | undefined {
  const value = identifier?.trim();
  return value ? value : undefined;
}

function normalizeEmail(email?: string | null): string | undefined {
  const value = normalizeIdentifier(email);
  return value?.toLowerCase();
}

function normalizeUsername(username?: string | null): string | undefined {
  const value = normalizeIdentifier(username);
  return value?.toLowerCase();
}

function describeIdentifier(identifier: Identifier): string | undefined {
  return typeof identifier === "string" ? identifier : undefined;
}

function identifierWhere(identifier: Identifier): Where<any> | null {
  if (typeof identifier === "string") {
    const value = normalizeIdentifier(identifier);
    if (!value) return null;

    const lower = value.toLowerCase();
    return {
      $or: [{ email: lower }, { username: lower }, { phone: value }],
    };
  }

  const clauses: Where<any>[] = [];
  const email = normalizeEmail(identifier.email);
  const username = normalizeUsername(identifier.username);
  const phone = normalizeIdentifier(identifier.phone);

  if (email) clauses.push({ email });
  if (username) clauses.push({ username });
  if (phone) clauses.push({ phone });

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? (clauses[0] as Where<any>) : { $and: clauses };
}

function identityWhere(input: {
  email?: string;
  phone?: string;
  username?: string;
}): Where<any> | null {
  const clauses: Where<any>[] = [];
  const email = normalizeEmail(input.email);
  const username = normalizeUsername(input.username);
  const phone = normalizeIdentifier(input.phone);

  if (email) clauses.push({ email });
  if (username) clauses.push({ username });
  if (phone) clauses.push({ phone });

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? (clauses[0] as Where<any>) : { $or: clauses };
}

/**
 * Build a RawQL-backed authentication service: registration, password login,
 * refresh-token rotation, access-token verification, and session management.
 */
export function createAuth(config: AuthConfig): Auth {
  if (!config?.db) {
    throw new RawLibError("VALIDATION_FAILED", "`db` is required");
  }

  const secret = config.secret;
  const secretLength = typeof secret === "string" ? secret.length : (secret?.length ?? 0);
  if (secretLength < 16) {
    throw new RawLibError("VALIDATION_FAILED", "`secret` must be at least 16 bytes");
  }

  const db: RawQl = config.db;
  const entities: AuthEntityNames = { ...DEFAULT_ENTITIES, ...config.entities };
  const hasher: PasswordHasher = config.password?.hasher ?? defaultPasswordHasher;
  const minLength = config.password?.minLength ?? DEFAULT_PASSWORD_MIN_LENGTH;
  const fingerprintPolicy: FingerprintPolicy = config.fingerprint?.policy ?? "strict";
  const requireDeviceId = config.fingerprint?.requireDeviceId ?? false;
  const hooks: AuthHooks = config.hooks ?? {};
  const clock = config.clock ?? (() => new Date());
  const refreshHistoryLimit = config.refreshHistoryLimit ?? 20;

  const accessTtlMs = parseDuration(config.accessTtl ?? "15m");
  const refreshTtlMs = parseDuration(config.refreshTtl ?? "30d");
  const accessTtlSeconds = toSeconds(accessTtlMs);

  let dummyHash: Promise<string> | undefined;

  const now = (): Date => clock();
  const nowIso = (): string => now().toISOString();

  function safeHook(fn: (() => void | Promise<void>) | undefined): Promise<void> {
    if (!fn) return Promise.resolve();
    return Promise.resolve()
      .then(fn)
      .catch(() => undefined);
  }

  async function mitigateTiming(password: string): Promise<void> {
    dummyHash ??= hasher.hash("raw_lib_dummy_password_for_timing");
    try {
      await hasher.verify(password, await dummyHash);
    } catch {
      // A dummy comparison must never change the outcome.
    }
  }

  function assertPassword(password: string): void {
    if (typeof password !== "string") {
      throw new RawLibError("VALIDATION_FAILED", "`password` must be a string");
    }
    if (password.length < minLength) {
      throw new RawLibError(
        "VALIDATION_FAILED",
        `Password must be at least ${minLength} characters`,
      );
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new RawLibError("VALIDATION_FAILED", "Password is too long");
    }
  }

  async function findUser(where: Where<any>): Promise<User | null> {
    const result = await db.execute<User | null>({
      op: "get",
      entity: entities.users,
      where,
    });

    if (!result.ok) throw new RawLibError(result.error.code, result.error.message);

    return result.data ?? null;
  }

  async function findUserById(id: string): Promise<User | null> {
    return findUser({ id });
  }

  async function findSession(where: Where<any>): Promise<Session | null> {
    const result = await db.execute<Session | null>({
      op: "get",
      entity: entities.sessions,
      where,
    });

    if (!result.ok) throw new RawLibError(result.error.code, result.error.message);

    return result.data ?? null;
  }

  async function findSessionByHistory(hash: string): Promise<Session | null> {
    const result = await db.execute<Session[]>({
      op: "list",
      entity: entities.sessions,
      where: { refreshTokenHistory: { in: [hash] } },
      page: { limit: 1 },
    });

    if (!result.ok) return null;
    return result.data[0] ?? null;
  }

  function assertLiveSession(session: Session): void {
    if (session.revokedAt) {
      throw new RawLibError("SESSION_REVOKED", "Session has been revoked");
    }

    if (Date.parse(session.expiresAt) <= now().getTime()) {
      throw new RawLibError("TOKEN_EXPIRED", "Session has expired");
    }
  }

  async function assertDevice(session: Session, device?: Device): Promise<void> {
    const provided = await hashDevice(device);
    const stored: StoredFingerprint = {
      deviceIdHash: session.deviceIdHash ?? null,
      userAgentHash: session.userAgentHash ?? null,
    };

    if (compareFingerprint(stored, provided, fingerprintPolicy) === "mismatch") {
      throw new RawLibError("FINGERPRINT_MISMATCH", "Device fingerprint does not match");
    }
  }

  async function issueAccessToken(
    user: User,
    session: Session,
  ): Promise<{ accessToken: string; accessExpiresAt: string }> {
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + accessTtlMs);

    const accessToken = await signAccessToken({
      secret,
      claims: {
        sub: user.id,
        sid: session.id,
        roles: user.roles,
      },
      ttlSeconds: accessTtlSeconds,
      now: Math.floor(issuedAt.getTime() / 1_000),
    });

    return { accessToken, accessExpiresAt: expiresAt.toISOString() };
  }

  async function revokeSession(session: Session, reason: string): Promise<void> {
    const revokedAt = nowIso();
    await db.execute({
      op: "update",
      entity: entities.sessions,
      where: { id: session.id },
      data: { revokedAt },
    });

    session.revokedAt = revokedAt;
    await safeHook(() => hooks.onSessionRevoked?.({ session: publicSession(session), reason }));
  }

  async function revokeFamily(familyId: string, reason: string): Promise<void> {
    const active = await db.execute<Session[]>({
      op: "list",
      entity: entities.sessions,
      where: { familyId, revokedAt: { isNull: true } },
    });

    if (!active.ok || active.data.length === 0) return;

    await db.execute({
      op: "update",
      entity: entities.sessions,
      where: { familyId, revokedAt: { isNull: true } },
      data: { revokedAt: nowIso() },
    });

    for (const session of active.data) {
      session.revokedAt = nowIso();
      await safeHook(() => hooks.onSessionRevoked?.({ session: publicSession(session), reason }));
    }
  }

  async function createSession(user: User, device?: Device): Promise<AuthSuccess> {
    if (requireDeviceId && !device?.deviceId) {
      throw new RawLibError("FINGERPRINT_MISMATCH", "A device id is required");
    }

    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + refreshTtlMs).toISOString();
    const fingerprint = await hashDevice(device);
    const refreshToken = randomToken(32);

    const session: Session = {
      id: randomId(),
      userId: user.id,
      familyId: randomId(),
      deviceIdHash: fingerprint.deviceIdHash,
      userAgentHash: fingerprint.userAgentHash,
      ip: device?.ip ?? null,
      createdAt: createdAt.toISOString(),
      lastUsedAt: createdAt.toISOString(),
      expiresAt,
      revokedAt: null,
      refreshTokenHash: await sha256Hex(refreshToken),
      refreshTokenExpiresAt: expiresAt,
      refreshTokenHistory: [],
      rotation: 0,
    };

    const inserted = await db.execute<Session>({
      op: "create",
      entity: entities.sessions,
      data: session,
    });

    if (!inserted.ok) throw new RawLibError(inserted.error.code, inserted.error.message);

    const { accessToken, accessExpiresAt } = await issueAccessToken(user, session);

    await safeHook(() =>
      hooks.onLogin?.({ user: publicUser(user), session: publicSession(session) }),
    );

    return {
      user: publicUser(user),
      session: publicSession(session),
      accessToken,
      refreshToken,
      accessExpiresAt,
    };
  }

  async function run<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await operation();
    } catch (error) {
      return failure<T>(toRawLibError(error).toJSON());
    }
  }

  return {
    register(input) {
      return run(async () => {
        assertPassword(input.password);

        const email = normalizeEmail(input.email);
        const username = normalizeUsername(input.username);
        const phone = normalizeIdentifier(input.phone);

        const where = identityWhere({ email, username, phone });
        if (!where) {
          throw new RawLibError("VALIDATION_FAILED", "Provide an email, phone, or username");
        }

        const existing = await db.execute<unknown[]>({
          op: "list",
          entity: entities.users,
          where,
          page: { limit: 1 },
        });

        if (!existing.ok) return failure(existing.error);
        if (existing.data.length > 0) {
          throw new RawLibError("CONFLICT", "Identifier is already registered");
        }

        const timestamp = nowIso();
        const doc: Record<string, unknown> = {
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(username ? { username } : {}),
          passwordHash: await hasher.hash(input.password),
          roles: input.roles ?? [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        const created = await db.execute<User>({
          op: "create",
          entity: entities.users,
          data: doc,
        });

        if (!created.ok) return failure(created.error);

        // Never let metadata shadow the canonical fields.
        const user: User = {
          ...created.data,
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(username ? { username } : {}),
          passwordHash: doc.passwordHash as string,
          roles: input.roles ?? [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        return { ok: true, data: await createSession(user, input.device) };
      });
    },

    login: {
      password(input) {
        return run(async () => {
          const where = identifierWhere(input.identifier);
          if (!where) {
            throw new RawLibError("VALIDATION_FAILED", "Provide an email, phone, or username");
          }

          const user = await findUser(where);

          if (!user?.passwordHash) {
            await mitigateTiming(input.password);
            await safeHook(() =>
              hooks.onLoginFailed?.({
                identifier: describeIdentifier(input.identifier),
                reason: "invalid_credentials",
                ip: input.device?.ip,
              }),
            );
            throw new RawLibError("INVALID_CREDENTIALS", "Invalid credentials");
          }

          const valid = await hasher.verify(input.password, user.passwordHash);

          if (!valid) {
            await safeHook(() =>
              hooks.onLoginFailed?.({
                identifier: describeIdentifier(input.identifier),
                reason: "invalid_credentials",
                ip: input.device?.ip,
              }),
            );
            throw new RawLibError("INVALID_CREDENTIALS", "Invalid credentials");
          }

          return { ok: true, data: await createSession(user, input.device) };
        });
      },
    },

    refresh(input) {
      return run(async () => {
        if (typeof input.refreshToken !== "string" || !input.refreshToken) {
          throw new RawLibError("TOKEN_INVALID", "Invalid refresh token");
        }

        const hash = await sha256Hex(input.refreshToken);
        const session = await findSession({ refreshTokenHash: hash });

        if (!session) {
          const reused = await findSessionByHistory(hash);

          if (reused) {
            await revokeFamily(reused.familyId, "refresh_reuse");
            await safeHook(() => hooks.onRefreshReuse?.({ session: publicSession(reused) }));
            throw new RawLibError("TOKEN_INVALID", "Refresh token has already been used");
          }

          throw new RawLibError("TOKEN_INVALID", "Invalid refresh token");
        }

        assertLiveSession(session);
        await assertDevice(session, input.device);

        const user = await findUserById(session.userId);
        if (!user) throw new RawLibError("TOKEN_INVALID", "Invalid refresh token");

        const refreshedAt = now();
        const expiresAt = new Date(refreshedAt.getTime() + refreshTtlMs).toISOString();
        const refreshToken = randomToken(32);
        const refreshTokenHash = await sha256Hex(refreshToken);

        const history = [...(session.refreshTokenHistory ?? []), session.refreshTokenHash].slice(
          -refreshHistoryLimit,
        );

        const updated: Session = {
          ...session,
          refreshTokenHash,
          refreshTokenHistory: history,
          refreshTokenExpiresAt: expiresAt,
          expiresAt,
          rotation: (session.rotation ?? 0) + 1,
          lastUsedAt: refreshedAt.toISOString(),
        };

        const result = await db.execute({
          op: "update",
          entity: entities.sessions,
          where: { id: session.id },
          data: {
            refreshTokenHash,
            refreshTokenHistory: history,
            refreshTokenExpiresAt: expiresAt,
            expiresAt,
            rotation: updated.rotation,
            lastUsedAt: updated.lastUsedAt,
          },
        });

        if (!result.ok) return failure(result.error);

        const { accessToken, accessExpiresAt } = await issueAccessToken(user, updated);

        return {
          ok: true,
          data: {
            user: publicUser(user),
            session: publicSession(updated),
            accessToken,
            refreshToken,
            accessExpiresAt,
          },
        };
      });
    },

    verify(input) {
      return run<VerifySuccess>(async () => {
        const claims = await verifyAccessToken({
          secret,
          token: input.accessToken,
          now: Math.floor(now().getTime() / 1_000),
        });

        const session = await findSession({ id: claims.sid });
        if (!session) throw new RawLibError("TOKEN_INVALID", "Invalid access token");

        assertLiveSession(session);
        await assertDevice(session, input.device);

        const user = await findUserById(claims.sub);
        if (!user) throw new RawLibError("TOKEN_INVALID", "Invalid access token");

        const lastUsedAt = nowIso();
        await db.execute({
          op: "update",
          entity: entities.sessions,
          where: { id: session.id },
          data: { lastUsedAt },
        });

        session.lastUsedAt = lastUsedAt;

        return {
          ok: true,
          data: {
            user: publicUser(user),
            session: publicSession(session),
            claims,
          },
        };
      });
    },

    logout(input) {
      return run<{ revoked: boolean }>(async () => {
        let session: Session | null = null;

        if (input.sessionId) {
          session = await findSession({ id: input.sessionId });
        } else if (input.refreshToken) {
          const hash = await sha256Hex(input.refreshToken);
          session =
            (await findSession({ refreshTokenHash: hash })) ?? (await findSessionByHistory(hash));
        } else {
          throw new RawLibError("VALIDATION_FAILED", "Provide a refresh token or a session id");
        }

        if (!session || session.revokedAt) {
          return { ok: true, data: { revoked: false } };
        }

        await revokeSession(session, "logout");
        return { ok: true, data: { revoked: true } };
      });
    },

    logoutAll(input) {
      return run(async () => {
        const active = await db.execute<Session[]>({
          op: "list",
          entity: entities.sessions,
          where: { userId: input.userId, revokedAt: { isNull: true } },
        });

        if (!active.ok) return failure(active.error);
        if (active.data.length === 0) return { ok: true, data: { revoked: 0 } };

        await db.execute({
          op: "update",
          entity: entities.sessions,
          where: { userId: input.userId, revokedAt: { isNull: true } },
          data: { revokedAt: nowIso() },
        });

        for (const session of active.data) {
          session.revokedAt = nowIso();
          await safeHook(() =>
            hooks.onSessionRevoked?.({
              session: publicSession(session),
              reason: "logout_all",
            }),
          );
        }

        return { ok: true, data: { revoked: active.data.length } };
      });
    },

    sessions: {
      list(input) {
        return run<PublicSession[]>(async () => {
          const result = await db.execute<Session[]>({
            op: "list",
            entity: entities.sessions,
            where: { userId: input.userId },
            sort: { lastUsedAt: "desc" },
            page: { limit: input.limit ?? 50, offset: input.offset ?? 0 },
          });

          if (!result.ok) return failure(result.error);

          return {
            ok: true,
            data: result.data.map(publicSession),
            ...(result.meta ? { meta: result.meta } : {}),
          };
        });
      },

      revoke(input) {
        return run<PublicSession>(async () => {
          const session = await findSession({ id: input.sessionId });
          if (!session) {
            throw new RawLibError("NOT_FOUND", "Session not found");
          }

          if (!session.revokedAt) {
            await revokeSession(session, "revoked");
          }

          return { ok: true, data: publicSession(session) };
        });
      },
    },
  };
}

export type {
  AccessClaims,
  Auth,
  AuthConfig,
  AuthSuccess,
  PublicSession,
  PublicUser,
  Session,
  User,
};
