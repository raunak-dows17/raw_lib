export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function getPath(source: unknown, path: string): unknown {
  if (source !== null && typeof source === "object" && path in (source as object)) {
    return (source as Record<string, unknown>)[path];
  }

  let current: unknown = source;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = target;

  for (let index = 0; index < parts.length - 1; index++) {
    const key = parts[index] as string;
    const next = current[key];
    if (!isPlainObject(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[parts[parts.length - 1] as string] = value;
}

export function deletePath(target: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let current: Record<string, unknown> | undefined = target;

  for (let index = 0; index < parts.length - 1; index++) {
    const next: unknown = current?.[parts[index] as string];
    if (!isPlainObject(next)) return;
    current = next;
  }

  if (current) {
    delete current[parts[parts.length - 1] as string];
  }
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]))
    );
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => valuesEqual(left[key], right[key]))
    );
  }

  return false;
}

export function compareValues(left: unknown, right: unknown): number {
  if (left instanceof Date) left = left.getTime();
  if (right instanceof Date) right = right.getTime();

  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  if (left === right) return 0;

  const leftString = String(left);
  const rightString = String(right);
  return leftString < rightString ? -1 : leftString > rightString ? 1 : 0;
}
