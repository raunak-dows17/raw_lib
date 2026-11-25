import { RawLibError } from "../core/errors";

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DURATION_PATTERN = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g;

/** Parse a human duration such as `15m`, `30d`, or `1h30m` into milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new RawLibError("VALIDATION_FAILED", `Invalid duration: ${value}`);
    }
    return Math.floor(value);
  }

  const input = value.trim();
  if (!input) throw new RawLibError("VALIDATION_FAILED", "Duration must not be empty");

  let total = 0;
  let consumed = 0;

  DURATION_PATTERN.lastIndex = 0;
  for (;;) {
    const match = DURATION_PATTERN.exec(input);
    if (!match) break;
    if (match.index !== consumed) break;
    const amount = Number(match[1]);
    const unit = UNITS[match[2] as string] as number;
    total += amount * unit;
    consumed += match[0].length;
  }

  if (consumed !== input.length || consumed === 0) {
    throw new RawLibError("VALIDATION_FAILED", `Invalid duration: ${value}`);
  }

  return Math.floor(total);
}

export function toSeconds(milliseconds: number): number {
  return Math.max(1, Math.floor(milliseconds / 1_000));
}
