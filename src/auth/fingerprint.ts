import { sha256Hex } from "./crypto";

export type FingerprintPolicy = "strict" | "loose" | "off";

export type Device = {
  deviceId?: string;
  userAgent?: string;
  ip?: string;
};

export type StoredFingerprint = {
  deviceIdHash: string | null;
  userAgentHash: string | null;
};

export type FingerprintConfig = {
  /** How strictly a session is bound to its device. Defaults to `strict`. */
  policy?: FingerprintPolicy;
  /** Reject session creation when no `deviceId` is supplied. Defaults to `false`. */
  requireDeviceId?: boolean;
};

/** Hash the identifying parts of a device so raw values are never stored. */
export async function hashDevice(device?: Device): Promise<StoredFingerprint> {
  return {
    deviceIdHash: device?.deviceId ? await sha256Hex(device.deviceId) : null,
    userAgentHash: device?.userAgent ? await sha256Hex(device.userAgent) : null,
  };
}

function constantTimeStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export type FingerprintVerdict = "ok" | "mismatch";

/**
 * Compare a stored session fingerprint with the current device.
 *
 * Sessions that were created without any fingerprint stay unbound. Once a session is
 * bound, a missing or different device can never silently pass (`off` is the only
 * opt-out). This mirrors the "never fail open" rule from the threat model.
 */
export function compareFingerprint(
  stored: StoredFingerprint,
  provided: StoredFingerprint,
  policy: FingerprintPolicy = "strict",
): FingerprintVerdict {
  if (policy === "off") return "ok";

  const storedDevice = stored.deviceIdHash ?? null;
  const storedUserAgent = stored.userAgentHash ?? null;

  // Nothing was bound at session creation, so there is nothing to enforce.
  if (!storedDevice && !storedUserAgent) return "ok";

  const deviceMatches =
    Boolean(storedDevice && provided.deviceIdHash) &&
    constantTimeStringEqual(storedDevice as string, provided.deviceIdHash as string);

  const userAgentMatches =
    Boolean(storedUserAgent && provided.userAgentHash) &&
    constantTimeStringEqual(storedUserAgent as string, provided.userAgentHash as string);

  if (policy === "strict") {
    if (storedDevice) return deviceMatches ? "ok" : "mismatch";
    return userAgentMatches ? "ok" : "mismatch";
  }

  return deviceMatches || userAgentMatches ? "ok" : "mismatch";
}
