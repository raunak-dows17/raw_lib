import { RawLibError } from "../errors";
import type { NormalizedSort } from "../types/normalized";
import type { Sort } from "../types/query";

export function compileSort(sort?: Sort): NormalizedSort | undefined {
  if (sort === undefined) return undefined;

  const entries = Array.isArray(sort)
    ? sort
    : Object.entries(sort).map(([field, direction]) => ({ field, direction }));

  if (entries.length === 0) return undefined;

  return entries.map(({ field, direction }) => {
    if (typeof field !== "string" || field.length === 0) {
      throw new RawLibError("VALIDATION_FAILED", "Sort fields must be non-empty strings");
    }
    if (direction !== "asc" && direction !== "desc") {
      throw new RawLibError(
        "VALIDATION_FAILED",
        `Invalid sort direction for \`${field}\`: expected "asc" or "desc"`,
      );
    }
    return { field, direction };
  });
}
