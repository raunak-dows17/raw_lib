import RawValEngine from "../../../rawval/core/engine";
import {
  RawQlAdapter,
  RawQlAdapterOperations,
} from "../../adapters/rawql_adapter";
import { RawQlRequest } from "../../config/types/rawql_request";
import { RawQlResponse } from "../../config/types/rawql_response";

export default class RawQlEngine {
  private adapter: RawQlAdapter;
  private validator?: RawValEngine;
  private middlewares: Array<(req: RawQlRequest) => Promise<void>> = [];

  constructor(adapter: RawQlAdapter, validator?: RawValEngine) {
    this.adapter = adapter;
    this.validator = validator;
  }

  /**
   * Executes a RawQl request by delgating to the adapter.
   *
   * @param request RawQl Request object
   * @returns RawQl Response object
   */
  async execute<T = any>(
    request: RawQlRequest
  ): Promise<RawQlResponse<T | number>> {
    try {
      // this.logRequest(request);

      this.validate(request);

      const normalized = this.normalize(request);

      for (const mw of this.middlewares) {
        await Promise.resolve(mw(normalized));
      }

      if (this.validator) {
        let toValidate: any;

        if (normalized.type === "create" || normalized.type === "update") {
          toValidate = normalized.data ?? {};
        } else if (normalized.type === "list") {
          toValidate = normalized.options ?? {};
        } else if (normalized.type === "aggregate") {
          toValidate = normalized.data ?? normalized.pipeline ?? {};
        } else {
          toValidate = { id: normalized.id, filter: normalized.filter };
        }

        const result = await this.validator.validate(
          normalized.entity,
          normalized.type,
          toValidate
        );

        if (!result.valid) {
          return {
            status: false,
            message: `Validaton failed`,
            data: null,
            errors: result.errors ?? [
              { field: "_unknown", message: "Validation failed" },
            ],
          };
        }
      }

      const response = await this.dispatch<T>(request);
      // this.logResponse(response);

      return response;
    } catch (error: any) {
      const validationDetails =
        error && error.validation ? error.validation : null;

      console.log("Validation", error.message);
      return {
        status: false,
        message: error.message || "RawQl Engine Execution Error",
        data: null,
        ...(validationDetails ? { errors: validationDetails } : {}),
      };
    }
  }

  /**
   * Register or replace validator at runtime
   */
  setValidator(validator: RawValEngine) {
    this.validator = validator;
  }

  /**
   * Swap the current adapter dynamically.
   */
  setAdapter(adapter: RawQlAdapter) {
    this.adapter = adapter;
  }

  /**
   * Add global middleware (e.g. auth, validation, chaching).
   */
  use(middleware: (req: RawQlRequest) => Promise<void>) {
    this.middlewares.push(middleware);
  }

  /**
   * Close resources gracefully
   */
  async close(): Promise<void> {
    if (this.adapter.close) {
      await this.adapter.close();
    }
  }

  // ------------------
  // Internal helpers
  // ------------------

  private validate(req: RawQlRequest) {
    if (!req.entity) {
      throw new Error("`entity` (string) is required");
    }
    if (!req.type) {
      throw new Error("`type` (operation) is required");
    }

    switch (req.type) {
      case "delete":
        if (!req.id) {
          throw new Error(`\`${req.type}\` requires a string \`id\``);
        }
        break;
    }

    if (req.options && typeof req.options !== "object") {
      throw new Error("`options` must be an object if provided");
    }
  }

  private normalize(req: RawQlRequest): RawQlRequest {
    // Shallow clone to allow middleware-safe mutations
    const out: RawQlRequest = { ...req };

    if (out.type === "list") {
      out.options = out.options || { limit: 10 };
      if (typeof out.options?.limit !== "number" || out.options.limit <= 0) {
        out.options.limit = 10;
      }
      if (typeof out.options.skip !== "number" || out.options.skip < 0) {
        out.options.skip = 0;
      }
      if (out.options.sort && !Array.isArray(out.options.sort)) {
        out.options.sort = [out.options.sort as any];
      }
      if (out.options.select && !Array.isArray(out.options.select)) {
        out.options.select = [String(out.options.select)];
      }
    }

    if (out.filter == null) {
      out.filter = undefined;
    }

    return out;
  }

  /**
   * Dispatch to adapter:
   * - Prefer per-operation methods if implemented
   * - Otherwise fall back to adapter.execute()
   */
  private async dispatch<T>(
    req: RawQlRequest
  ): Promise<RawQlResponse<T | number>> {
    const ops = this.adapter as RawQlAdapter & Partial<RawQlAdapterOperations>;

    switch (req.type) {
      case "create":
        if (ops.create) return ops.create<T>(req);
        break;
      case "list":
        if (ops.list) return ops.list<T>(req);
        break;
      case "get":
        if (ops.get) return ops.get<T>(req);
        break;
      case "update":
        if (ops.update) return ops.update<T>(req);
        break;
      case "delete":
        if (ops.delete) return ops.delete<T>(req);
        break;
      case "count":
        if (ops.count) return ops.count<T>(req);
        break;
      case "aggregate":
        if (ops.aggregate) return ops.aggregate<T>(req);
        break;
      default:
        throw new Error(`Unsupported operation type: ${req.type as string}`);
    }

    if (this.adapter.execute) {
      return this.adapter.execute<T>(req);
    }

    throw new Error(
      `Adapter does not support '${req.type}' and no generic execute() found`
    );
  }

  private logRequest(request: RawQlRequest) {
    console.log(`[RawQL Engine] Executing request: ${JSON.stringify(request)}`);
  }

  private logResponse(response: RawQlResponse) {
    console.log(
      `[RawQL Engine] Received response: ${JSON.stringify(response)}`
    );
  }
}
