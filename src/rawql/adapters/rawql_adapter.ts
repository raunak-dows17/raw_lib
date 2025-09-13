import { RawQlRequest } from "../config/types/rawql_request";
import { RawQlResponse } from "../config/types/rawql_response";

/**
 * Base contract for any RawQL adapter.
 *
 * Each adapter (Mongo, SQL, Postgress, Redis, etc...) must implement this
 * interface so that RawQL can query it in a unified way.
 */
export interface RawQlAdapter {
  /**
   * Universal entry point to execute any RawQL request.
   * @param request RawQl Request object
   * @returns RawQl Response objecct
   */
  execute<T = any>(request: RawQlRequest): Promise<RawQlResponse<T | any>>;

  /**
   * Closes the adapter resources (like db connections).
   */
  close?(): Promise<void>;
}

/**
 * Extended per-operation contract for adapters.
 *
 * This enforces clarity and guatantees across adapters.
 * Adapters can throw "Not Supported" for unsupported ops.
 */
export interface RawQlAdapterOperations {
  create<T = any>(request: RawQlRequest): Promise<RawQlResponse<T>>;
  list<T = any>(request: RawQlRequest): Promise<RawQlResponse<T>>;
  get<T = any>(request: RawQlRequest): Promise<RawQlResponse<T>>;
  update<T = any>(request: RawQlRequest): Promise<RawQlResponse<T>>;
  delete<T = any>(request: RawQlRequest): Promise<RawQlResponse<T>>;
  count<T = any>(request: RawQlRequest): Promise<RawQlResponse<number>>;
  aggregate<T = any>(request: RawQlRequest): Promise<RawQlResponse<T>>;
}
