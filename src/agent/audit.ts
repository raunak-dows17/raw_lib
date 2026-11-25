import type { RawQl } from "../core/engine/engine";
import { toRawLibError } from "../core/errors";
import type { Result } from "../core/types/result";
import type { AuditRecord } from "./types";

export type AuditStoreConfig = {
  db: RawQl;
  /** Entity used for audit rows. Defaults to `agent_audit`. */
  entity?: string;
};

export type AuditListOptions = {
  limit?: number;
  offset?: number;
};

export type AuditStore = {
  record(record: AuditRecord): Promise<Result<unknown>>;
  list(options?: AuditListOptions): Promise<Result<AuditRecord[]>>;
};

/**
 * Stores agent audit records through RawQL. The store bypasses user validators because the
 * record shape is internal, but callers can still query it like any other entity.
 */
export function createAuditStore(config: AuditStoreConfig): AuditStore {
  if (!config?.db) throw new Error("`db` is required");

  const entity = config.entity ?? "agent_audit";

  return {
    async record(record: AuditRecord): Promise<Result<unknown>> {
      try {
        return await config.db.execute({ op: "create", entity, data: record }, { validate: false });
      } catch (error) {
        return { ok: false, error: toRawLibError(error).toJSON() };
      }
    },

    async list(options: AuditListOptions = {}): Promise<Result<AuditRecord[]>> {
      try {
        return await config.db.execute<AuditRecord[]>(
          {
            op: "list",
            entity,
            sort: { createdAt: "desc" },
            page: {
              limit: Math.min(Math.max(options.limit ?? 50, 1), 500),
              offset: Math.max(options.offset ?? 0, 0),
            },
          },
          { validate: false },
        );
      } catch (error) {
        return { ok: false, error: toRawLibError(error).toJSON() };
      }
    },
  };
}
