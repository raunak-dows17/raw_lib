export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "UNSUPPORTED_CAPABILITY"
  | "ADAPTER_ERROR"
  | "TIMEOUT"
  | "INTERNAL_ERROR"
  | "INVALID_CREDENTIALS"
  | "TOKEN_EXPIRED"
  | "TOKEN_INVALID"
  | "SESSION_REVOKED"
  | "FINGERPRINT_MISMATCH"
  | "OTP_EXPIRED"
  | "OTP_INVALID"
  | "OTP_ATTEMPTS_EXCEEDED"
  | "OTP_ALREADY_USED";

export type RawLibErrorShape = {
  code: ErrorCode;
  message: string;
  details?: unknown;
};

export class RawLibError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RawLibError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, RawLibError.prototype);
  }

  toJSON(): RawLibErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function isRawLibError(value: unknown): value is RawLibError {
  return value instanceof RawLibError;
}

export function toRawLibError(
  value: unknown,
  fallbackCode: ErrorCode = "INTERNAL_ERROR",
): RawLibError {
  if (isRawLibError(value)) return value;
  if (value instanceof Error) {
    return new RawLibError(fallbackCode, value.message, undefined, { cause: value });
  }
  return new RawLibError(fallbackCode, String(value));
}
