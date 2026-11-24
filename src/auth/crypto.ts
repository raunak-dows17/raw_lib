import { RawLibError } from "../core/errors";

const encoder = new TextEncoder();

export function getCrypto(): Crypto {
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!webcrypto?.subtle) {
    throw new RawLibError("INTERNAL_ERROR", "Web Crypto is not available in this runtime");
  }
  return webcrypto;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

export function randomId(): string {
  const webcrypto = getCrypto();
  if (typeof webcrypto.randomUUID === "function") return webcrypto.randomUUID();
  return bytesToHex(randomBytes(16));
}

export function randomToken(length = 32): string {
  return base64UrlEncode(randomBytes(length));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

export async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof value === "string" ? encoder.encode(value) : toBufferSource(value);
  const digest = await getCrypto().subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

/** Copy into a plain `ArrayBuffer`-backed view so Web Crypto accepts it under TS 6. */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await sha256(value));
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}
