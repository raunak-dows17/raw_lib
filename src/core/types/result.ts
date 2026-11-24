import type { RawLibErrorShape } from "../errors";

export type PageMeta = {
  limit: number;
  offset: number;
  total?: number;
  hasMore: boolean;
};

export type Meta = {
  page?: PageMeta;
  count?: number;
  tookMs?: number;
  adapter?: string;
};

export type Result<T> = { ok: true; data: T; meta?: Meta } | { ok: false; error: RawLibErrorShape };
