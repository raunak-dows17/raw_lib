import { bytesToHex, getCrypto, toBufferSource } from "./crypto";

const encoder = new TextEncoder();

async function hmac(secret: string | Uint8Array, value: string): Promise<string> {
  const key = await getCrypto().subtle.importKey(
    "raw",
    toBufferSource(typeof secret === "string" ? encoder.encode(secret) : secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await getCrypto().subtle.sign(
    "HMAC",
    key,
    toBufferSource(encoder.encode(value)),
  );

  return bytesToHex(new Uint8Array(signature));
}

/** Hash a contact identifier with the auth secret so stored values are not enumerable. */
export function hashContact(secret: string | Uint8Array, contact: string): Promise<string> {
  return hmac(secret, `contact:${contact}`);
}

/** Salted HMAC-SHA256 digest of an OTP code. */
export function hashOtpCode(
  secret: string | Uint8Array,
  salt: string,
  code: string,
): Promise<string> {
  return hmac(secret, `otp:${salt}:${code}`);
}

/** Generate a uniformly distributed numeric code of the requested length. */
export function generateOtpCode(length: number): string {
  if (!Number.isInteger(length) || length < 4 || length > 10) {
    throw new RangeError("OTP length must be an integer between 4 and 10");
  }

  const webcrypto = getCrypto();
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 10) * 10;
  let code = "";

  while (code.length < length) {
    webcrypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value >= limit) continue;
    code += String(value % 10);
  }

  return code;
}

/** Compare two hex digests without early exit. */
export function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
