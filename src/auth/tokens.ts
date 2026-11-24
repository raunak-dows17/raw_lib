import { RawLibError } from "../core/errors";
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  getCrypto,
  randomId,
  toBufferSource,
} from "./crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type AccessClaims = {
  sub: string;
  sid: string;
  jti: string;
  iat: number;
  exp: number;
  roles?: string[];
  [key: string]: unknown;
};

export type SignAccessTokenInput = {
  secret: string | Uint8Array;
  claims: Pick<AccessClaims, "sub" | "sid"> & Partial<Pick<AccessClaims, "jti" | "roles">>;
  ttlSeconds: number;
  /** Override the issue time, in seconds since the epoch. */
  now?: number;
};

export type VerifyAccessTokenInput = {
  secret: string | Uint8Array;
  token: string;
  /** Override the current time, in seconds since the epoch. */
  now?: number;
  /** Clock skew allowance, in seconds. Defaults to 0. */
  clockToleranceSeconds?: number;
};

function toKey(secret: string | Uint8Array): Uint8Array {
  if (typeof secret === "string") return encoder.encode(secret);
  return secret;
}

async function hmacKey(secret: string | Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return getCrypto().subtle.importKey(
    "raw",
    toBufferSource(toKey(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function encodeSegment(value: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(decoder.decode(base64UrlDecode(segment)));
  } catch {
    throw new RawLibError("TOKEN_INVALID", "Malformed token segment");
  }
}

/** Issue a compact HS256 JWT using Web Crypto (edge-safe, no dependencies). */
export async function signAccessToken(input: SignAccessTokenInput): Promise<string> {
  const iat = input.now ?? Math.floor(Date.now() / 1_000);
  const exp = iat + Math.max(1, Math.floor(input.ttlSeconds));

  const header = { alg: "HS256", typ: "JWT" };
  const payload: AccessClaims = {
    ...input.claims,
    jti: input.claims.jti ?? randomId(),
    iat,
    exp,
  };

  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await getCrypto().subtle.sign(
    "HMAC",
    await hmacKey(input.secret, ["sign"]),
    toBufferSource(encoder.encode(signingInput)),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Verify an HS256 JWT and return its claims. Throws typed auth errors. */
export async function verifyAccessToken(input: VerifyAccessTokenInput): Promise<AccessClaims> {
  const parts = input.token.split(".");
  if (parts.length !== 3) {
    throw new RawLibError("TOKEN_INVALID", "Malformed access token");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = decodeSegment(encodedHeader) as { alg?: unknown; typ?: unknown };
  if (header?.alg !== "HS256") {
    throw new RawLibError("TOKEN_INVALID", "Unsupported token algorithm");
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64UrlDecode(encodedSignature);

  const valid = await getCrypto().subtle.verify(
    "HMAC",
    await hmacKey(input.secret, ["verify"]),
    toBufferSource(signature),
    toBufferSource(encoder.encode(signingInput)),
  );

  if (!valid) {
    throw new RawLibError("TOKEN_INVALID", "Invalid token signature");
  }

  const payload = decodeSegment(encodedPayload) as Partial<AccessClaims>;

  if (
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.jti !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    throw new RawLibError("TOKEN_INVALID", "Invalid token claims");
  }

  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const tolerance = input.clockToleranceSeconds ?? 0;

  if (payload.exp + tolerance <= now) {
    throw new RawLibError("TOKEN_EXPIRED", "Access token has expired");
  }

  if (payload.iat - tolerance > now) {
    throw new RawLibError("TOKEN_INVALID", "Access token was issued in the future");
  }

  return payload as AccessClaims;
}

export function isSignatureValid(left: Uint8Array, right: Uint8Array): boolean {
  return constantTimeEqual(left, right);
}
