import { RawQlRequest } from "../config/types/rawql_request";
import { RawQlResponse } from "../config/types/rawql_response";
import { RawQlAdapter } from "./rawql_adapter";

export class InMemoryAdapter implements RawQlAdapter {
  private db: Record<string, any[]> = {};

  constructor(initialData: Record<string, any[]> = {}) {
    this.db = initialData;
  }

  async execute<T = any>(request: RawQlRequest): Promise<RawQlResponse<T>> {
    switch (request.type) {
      case "list":
        return this.list(request);
      case "create":
        return this.create(request);
      case "update":
        return this.update(request);
      case "delete":
        return this.delete(request);
      case "count":
        return this.count(request);
      case "aggregate":
        return this.aggregate(request);
      default:
        throw new Error(`Unsupported request type: ${request.type}`);
    }
  }

  private async create<T>(req: RawQlRequest): Promise<RawQlResponse<T>> {
    const collection = this.db[req.entity] || [];
    const newItem = { id: String(Date.now()), ...req.data };
    collection.push(newItem);
    this.db[req.entity] = collection;

    return {
      status: true,
      message: `Created ${req.entity} successfully`,
      data: { type: "single", item: newItem as T },
    };
  }

  private async list<T>(req: RawQlRequest): Promise<RawQlResponse<T>> {
    const collection = this.db[req.entity] || [];

    return {
      status: true,
      message: `Fetched ${req.entity} list successfully`,
      data: { type: "multiple", items: collection },
    };
  }

  private async get<T>(req: RawQlRequest): Promise<RawQlResponse<T>> {
    const collection = this.db[req.entity] || [];
    const item = collection.find((i) => i.id === req.id);

    if (!item) {
      return {
        status: false,
        message: `${req.entity} not found`,
        data: null,
      };
    }

    return {
      status: true,
      message: `Fetched ${req.entity} successfully`,
      data: { type: "single", item },
    };
  }

  private async update<T>(req: RawQlRequest): Promise<RawQlResponse<T>> {
    const collection = this.db[req.entity] || [];
    const index = collection.findIndex((i) => i.id === req.id);

    if (index === -1) {
      return {
        status: false,
        message: `${req.entity} not found`,
        data: null,
      };
    }

    collection[index] = { ...collection[index], ...req.data };

    return {
      status: true,
      message: `Updated ${req.entity} successfully`,
      data: { type: "single", item: collection[index] },
    };
  }

  private async delete<T>(req: RawQlRequest): Promise<RawQlResponse<T>> {
    const collection = this.db[req.entity] || [];
    const index = collection.findIndex((i) => i.id === req.id);

    if (index === -1) {
      return {
        status: false,
        message: `${req.entity} not found`,
        data: null,
      };
    }

    const deleted = collection.splice(index, 1)[0];

    return {
      status: true,
      message: `Deleted ${req.entity} successfully`,
      data: { type: "single", item: deleted },
    };
  }

  private async count<T>(req: RawQlRequest): Promise<RawQlResponse<T>> {
    const collection = this.db[req.entity] || [];
    return {
      status: true,
      message: `Counted ${req.entity} successfully`,
      data: {
        type: "single",
        item: { count: collection.length } as T,
      },
    };
  }

  private async aggregate<T>(req: RawQlRequest): Promise<RawQlResponse<T>> {
    // Basic placeholder for aggregate
    return {
      status: true,
      message: `Aggregate for ${req.entity} executed (placeholder)`,
      data: { type: "multiple", items: [] },
    };
  }
}
