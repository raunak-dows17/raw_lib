import type { AdapterResult } from "../types/adapter";
import type { NormalizedQuery } from "../types/normalized";
import type { Meta, Result } from "../types/result";

export function mapAdapterResult<T>(
  result: AdapterResult<T>,
  query: NormalizedQuery,
  adapter: string,
  startedAt: number,
): Result<T> {
  const tookMs = Date.now() - startedAt;

  switch (result.kind) {
    case "items": {
      const meta: Meta = { tookMs, adapter };

      if (query.page) {
        const hasMore =
          result.total !== undefined
            ? query.page.offset + result.items.length < result.total
            : result.items.length === query.page.limit;

        meta.page = {
          limit: query.page.limit,
          offset: query.page.offset,
          hasMore,
          ...(result.total !== undefined ? { total: result.total } : {}),
        };
      }

      return { ok: true, data: result.items as T, meta };
    }

    case "item":
      return { ok: true, data: result.item as T, meta: { tookMs, adapter } };

    case "count":
      return { ok: true, data: result.count as T, meta: { tookMs, adapter, count: result.count } };

    case "ack": {
      if (result.matched === 0) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No ${query.entity.name} matched the query`,
          },
        };
      }

      return { ok: true, data: { id: result.id ?? null } as T, meta: { tookMs, adapter } };
    }
  }
}
