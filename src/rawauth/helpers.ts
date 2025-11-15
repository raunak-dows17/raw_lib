import crypto from "crypto";
import {
  RawQlMultipleResponse,
  RawQlResponse,
  RawQlSingleResponse,
} from "../rawql/config/types/rawql_response";

export function genJti() {
  return crypto.randomBytes(16).toString("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function genOtpCode(digits = 6) {
  const max = 10 ** digits;
  return Math.floor(Math.random() * max)
    .toString()
    .padStart(digits, "0");
}

/**
 * Normalize a success RawQlResponse with a single item
 */

export function successSingle<T>(item: T, message = "OK"): RawQlResponse<T> {
  const data: RawQlSingleResponse<T> = { type: "single", item };

  return { status: true, message, data };
}

/**
 * Normalize a failure RawQlResponse
 */
export function failure(
  message = "error",
  errors?: { field: string; message: string }[]
): RawQlResponse {
  return { status: false, message, data: null, errors };
}

/**
 * Normalize multiple results
 */
export function successMultiple<T>(
  items: T[],
  message = "OK"
): RawQlResponse<T> {
  const data: RawQlMultipleResponse<T> = { type: "multiple", items };
  return { status: true, message, data };
}

/**
 * Fingerprint comparison utility
 * prefer deviceId exact match; fallback to UA/IP heuristics
 */
export function matchFingerPrint(
  session: {
    deviceId: string | null;
    userAgent?: string | null;
    ip?: string | null;
  },
  fingerprint: {
    deviceId: string | null;
    userAgent?: string | null;
    ip?: string | null;
  }
) {
  if (session.deviceId && fingerprint.deviceId) {
    return session.deviceId === fingerprint.deviceId;
  }

  if (session.userAgent && fingerprint.userAgent) {
    return session.userAgent !== fingerprint.userAgent;
  }

  if (session.ip && fingerprint.ip) {
    try {
      const s = session.ip.split(".");
      const f = fingerprint.ip.split(".");

      if (s.length === 4 && f.length === 4) {
        return s[0] === f[0] && s[1] === f[1];
      }
    } catch (error) {
      // ignore
    }
  }

  return true;
}
