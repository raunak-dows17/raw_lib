import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  randomBytes,
  toBufferSource,
} from "./crypto";

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
  /** True when the stored hash uses weaker parameters than the current defaults. */
  needsRehash?(stored: string): boolean;
};

export type PasswordConfig = {
  hasher?: PasswordHasher;
  /** Minimum accepted password length. Defaults to 8. */
  minLength?: number;
};

type NodeCrypto = typeof import("node:crypto");

let nodeCrypto: NodeCrypto | null | undefined;

// A variable specifier keeps edge bundlers from trying to resolve a Node builtin.
const NODE_CRYPTO = "node:crypto";

async function loadNodeCrypto(): Promise<NodeCrypto | null> {
  if (nodeCrypto !== undefined) return nodeCrypto;

  try {
    nodeCrypto = (await import(NODE_CRYPTO)) as NodeCrypto;
  } catch {
    nodeCrypto = null;
  }

  return nodeCrypto;
}

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const PBKDF2_ITERATIONS = 210_000;

function scryptAsync(crypto: NodeCrypto, password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 96 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(new Uint8Array(key));
      },
    );
  });
}

function encodeScrypt(salt: Uint8Array, key: Uint8Array): string {
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, base64UrlEncode(salt), base64UrlEncode(key)].join(
    "$",
  );
}

function decodeScrypt(stored: string) {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !key) return null;

  return {
    params: { N: Number(n), r: Number(r), p: Number(p) },
    salt: base64UrlDecode(salt),
    key: base64UrlDecode(key),
  };
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!webcrypto?.subtle) throw new Error("Web Crypto is not available");

  const keyMaterial = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", salt: toBufferSource(salt), iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH * 8,
  );

  return new Uint8Array(bits);
}

/**
 * Default password hasher: `scrypt` (N=2^15, r=8, p=1) when Node's crypto module is
 * available, otherwise PBKDF2-SHA256 through Web Crypto. Both formats carry their
 * parameters so hashes stay verifiable across runtimes.
 */
export const defaultPasswordHasher: PasswordHasher = {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const crypto = await loadNodeCrypto();

    if (crypto) {
      const key = await scryptAsync(crypto, password, salt);
      return encodeScrypt(salt, key);
    }

    const key = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
    return ["pbkdf2", PBKDF2_ITERATIONS, base64UrlEncode(salt), base64UrlEncode(key)].join("$");
  },

  async verify(password: string, stored: string): Promise<boolean> {
    if (stored.startsWith("scrypt$")) {
      const parsed = decodeScrypt(stored);
      if (!parsed) return false;

      const crypto = await loadNodeCrypto();
      if (!crypto) return false;

      const key = await new Promise<Uint8Array>((resolve, reject) => {
        crypto.scrypt(
          password,
          parsed.salt,
          parsed.key.length,
          { ...parsed.params, maxmem: 96 * 1024 * 1024 },
          (error, derived) => {
            if (error) reject(error);
            else resolve(new Uint8Array(derived));
          },
        );
      });

      return constantTimeEqual(key, parsed.key);
    }

    if (stored.startsWith("pbkdf2$")) {
      const [scheme, iterations, salt, key] = stored.split("$");
      if (scheme !== "pbkdf2" || !iterations || !salt || !key) return false;

      const derived = await pbkdf2(password, base64UrlDecode(salt), Number(iterations));
      return constantTimeEqual(derived, base64UrlDecode(key));
    }

    return false;
  },

  needsRehash(stored: string): boolean {
    if (!stored.startsWith("scrypt$")) return false;
    const parsed = decodeScrypt(stored);
    if (!parsed) return true;

    return parsed.params.N < SCRYPT_N || parsed.params.r < SCRYPT_R || parsed.params.p < SCRYPT_P;
  },
};
