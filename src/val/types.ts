export type ValidationIssue = {
  path: string;
  message: string;
  code?: string;
};

export type ParseSuccess<T> = { ok: true; value: T };
export type ParseFailure = { ok: false; issues: ValidationIssue[] };
export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

export type StandardPathSegment = PropertyKey | { key: PropertyKey };

export type StandardIssue = {
  message: string;
  path?: ReadonlyArray<StandardPathSegment>;
  code?: string;
};

export type StandardResult<T> =
  | { value: T; issues?: undefined }
  | { issues: ReadonlyArray<StandardIssue>; value?: undefined };

export type StandardSchemaProps<T> = {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (value: unknown) => StandardResult<T> | Promise<StandardResult<T>>;
  readonly types?: { readonly input: T; readonly output: T };
};

export type StandardSchema<T = unknown> = {
  readonly "~standard": StandardSchemaProps<T>;
};

export interface Schema<T> extends StandardSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): ParseResult<T>;
  optional(): Schema<T | undefined>;
  nullable(): Schema<T | null>;
  default(value: T): Schema<T>;
  refine(check: (value: T) => boolean | string, message?: string): Schema<T>;
  transform<U>(fn: (value: T) => U): Schema<U>;
}

export type InferSchema<S> =
  S extends Schema<infer T>
    ? T
    : S extends { readonly "~standard": { readonly types?: { readonly output: infer O } } }
      ? O
      : unknown;

export type Shape = Record<string, Schema<any>>;
export type InferShape<S extends Shape> = { [K in keyof S]: InferSchema<S[K]> };

export function isStandardSchema(value: unknown): value is StandardSchema {
  if (typeof value !== "object" || value === null) return false;
  const standard = (value as { "~standard"?: unknown })["~standard"];
  return (
    typeof standard === "object" &&
    standard !== null &&
    typeof (standard as { validate?: unknown }).validate === "function"
  );
}
