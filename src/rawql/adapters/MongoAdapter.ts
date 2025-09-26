import {
  connect,
  disconnect,
  model,
  Model,
  mongo,
  PipelineStage,
  Schema,
} from "mongoose";
import { RawQlAdapter, RawQlAdapterOperations } from "./rawql_adapter";
import {
  FilterOperations,
  RawQlFilter,
  RawQlGroup,
  RawQlPipelineStep,
  RawQlRequest,
} from "../config/types/rawql_request";
import {
  RawQlResponse,
  RawQlResponseData,
} from "../config/types/rawql_response";

export default class MongoAdapter
  implements RawQlAdapter, Partial<RawQlAdapterOperations> {
  private models: Map<String, Model<any>> = new Map();

  constructor(uri: string) {
    connect(uri);
  }

  registerModel<T>(name: string, schema: Schema<T>) {
    this.models.set(name, model<T>(name, schema));
  }

  private getModel<T>(entity: string): Model<T> {
    const model = this.models.get(entity);
    if (!model) {
      throw new Error(`Model for entity ${entity} is not registered`);
    }
    return model;
  }

  private convertFilter(filter?: RawQlFilter): Record<string, any> {
    if (!filter) return {};

    const mongoFilter: Record<string, any> = {};

    if (this.isFieldFilter(filter)) {
      if (filter.field && filter.op && filter.value != undefined) {
        switch (filter.op) {
          case "eq":
            mongoFilter[filter.field] = { $eq: filter.value };
            break;
          case "ne":
            mongoFilter[filter.field] = { $ne: filter.value };
            break;
          case "gt":
            mongoFilter[filter.field] = { $gt: filter.value };
            break;
          case "gte":
            mongoFilter[filter.field] = { $gte: filter.value };
            break;
          case "lt":
            mongoFilter[filter.field] = { $lt: filter.value };
            break;
          case "lte":
            mongoFilter[filter.field] = { $lte: filter.value };
            break;
          case "in":
            mongoFilter[filter.field] = { $in: filter.value };
            break;
          case "nin":
            mongoFilter[filter.field] = { $nin: filter.value };
            break;
          case "search":
            mongoFilter[filter.field] = { $regex: filter.value, "$options": "i" };
          case "startsWith":
            mongoFilter[filter.field] = { $regex: /^filter.value/i };
          case "endsWith":
            mongoFilter[filter.field] = { $regex: `${filter.value}$` };
          default:
            throw new Error(`Unsupported filter operation: ${filter.op}`);
        }
      }
    }

    if (this.isLogicalFilter(filter)) {
      if (filter.and) {
        mongoFilter["$and"] = filter.and?.map((f: RawQlFilter) =>
          this.convertFilter(f)
        );
      }

      if (filter.or) {
        mongoFilter["$or"] = filter.or?.map((f: RawQlFilter) =>
          this.convertFilter(f)
        );
      }

      if (filter.not) {
        mongoFilter["$not"] = this.convertFilter(filter.not);
      }
    }

    return mongoFilter;
  }

  private isFieldFilter(
    filter: RawQlFilter
  ): filter is { field: string; op: FilterOperations; value: any } {
    return (filter as any).field !== undefined;
  }

  private isLogicalFilter(
    filter: RawQlFilter
  ): filter is { and?: RawQlFilter[]; or?: RawQlFilter[]; not?: RawQlFilter } {
    return (
      (filter as any).and !== undefined ||
      (filter as any).or !== undefined ||
      (filter as any).not !== undefined
    );
  }

  private convertPipeline(pipeline: RawQlPipelineStep[]): PipelineStage[] {
    return pipeline.map((step) => {
      if ("match" in step) {
        return { $match: this.convertFilter(step.match) };
      } else if ("group" in step) {
        return { $group: this.convertGroup(step.group) };
      } else if ("sort" in step) {
        return { $sort: this.convertSort(step.sort) };
      } else if ("limit" in step) {
        return { $limit: step.limit };
      } else if ("skip" in step) {
        return { $skip: step.skip };
      } else if ("project" in step) {
        return { $project: step.project };
      }
      throw new Error(`Unknown pipeline step: ${JSON.stringify(step)}`);
    });
  }

  private convertGroup(group: RawQlGroup): any {
    const mongooseGroup: any = { _id: group._id };

    Object.entries(
      group.fields as Record<
        string,
        { op: "count" | "sum" | "avg" | "min" | "max"; field?: string }
      >
    ).forEach(([fieldName, fieldConfig]) => {
      const mongooseOp = this.convertAggregateOp(fieldConfig.op);
      mongooseGroup[fieldName] = {
        [mongooseOp]: fieldConfig.field ? `$${fieldConfig.field}` : 1,
      };
    });

    return mongooseGroup;
  }

  private convertAggregateOp(
    op: "count" | "sum" | "avg" | "min" | "max"
  ): string {
    const opMap = {
      count: "$count",
      sum: "$sum",
      avg: "$avg",
      min: "$min",
      max: "$max",
    } as const;
    return opMap[op];
  }

  private convertSort(
    sort: { field: string; direction: "asc" | "desc" }[]
  ): Record<string, 1 | -1> {
    const mongooseSort: Record<string, 1 | -1> = {};
    sort.forEach((s) => {
      mongooseSort[s.field] = s.direction === "asc" ? 1 : -1;
    });
    return mongooseSort;
  }

  async execute<T = any>(
    request: RawQlRequest
  ): Promise<RawQlResponse<T | number>> {
    switch (request.type) {
      case "list":
        return this.list<T>(request);
      case "get":
        return this.get<T>(request);
      case "create":
        return this.create<T>(request);
      case "update":
        return this.update<T>(request);
      case "delete":
        return this.delete<T>(request);
      case "count":
        return this.count<T>(request);
      case "aggregate":
        return this.aggregate<T>(request);
      default:
        return {
          status: false,
          message: `Unsupported request type: ${request.type}`,
          data: null,
        };
    }
  }

  async list<T>(request: RawQlRequest): Promise<RawQlResponse<T>> {
    const model = this.getModel<T>(request.entity);
    const filter = this.convertFilter(request.filter);

    const query = model.find(filter);

    const limit = request.options?.limit ?? 10;
    const page = request.options?.page ?? 1;
    const skip = (page - 1) * limit;

    if (request.options?.limit) query.limit(request.options.limit);
    if (request.options?.page) query.skip(skip);
    if (request.options?.select) query.select(request.options.select.join(" "));
    if (request.options?.sort)
      query.sort(this.convertSort(request.options.sort));

    const items = await query.lean().exec();
    const totalItems = await model.countDocuments(filter).exec();

    const responseData = {
      type: "paginated",
      items,
      totalItems,
      currentPage: Math.floor(skip / limit) + 1,
      nextPage: skip + limit < totalItems ? Math.floor(skip / limit) + 2 : null,
      prevPage: skip - limit >= 0 ? Math.floor(skip / limit) : null,
      totalPages: Math.ceil(totalItems / limit),
    } as RawQlResponseData<T>;
    return {
      status: true,
      message: `Fetched ${request.entity} list successfully`,
      data: responseData,
    };
  }

  async get<T>(request: RawQlRequest): Promise<RawQlResponse<T>> {
    try {
      const model = this.getModel<T>(request.entity);

      const query =
        request.id ? model.findById<T>(request.id) : model.findOne<T>(this.convertFilter(request.filter));


      if (request.options?.select) query.select(request.options.select.join(" "));


      const item = await query.lean().exec();

      const responseData = {
        type: "single",
        item,
      } as RawQlResponseData<T>;

      return {
        status: true,
        message: `Fetched ${request.entity} successfully`,
        data: responseData,
      };
    } catch (e: any) {
      return {
        status: false,
        message: e.message,
        data: null,
      }
    }
  }

  async create<T>(request: RawQlRequest): Promise<RawQlResponse<T>> {
    const model = this.getModel<T>(request.entity);

    const item = await model.create<T>(request.data as T);

    const responseData = {
      type: "single",
      item,
    } as RawQlResponseData<T>;

    return {
      status: true,
      message: `${request.entity} created successfully`,
      data: responseData,
    };
  }

  async update<T>(request: RawQlRequest): Promise<RawQlResponse<T>> {
    const model = this.getModel<T>(request.entity);

    const query = request.id ? model.findByIdAndUpdate<T>(request.id, request.data, { new: true }) : model.findOneAndUpdate(request.filter, request.data, { new: true });

    if (request.options?.select) query.select(request.options.select.join(" "));

    const item = await query.lean().exec() as T;

    const responseData: RawQlResponseData<T> = {
      type: "single",
      item,
    };

    return {
      status: true,
      message: `${request.entity} updated successfully`,
      data: responseData,
    };
  }

  async delete<T>(request: RawQlRequest): Promise<RawQlResponse<T>> {
    const model = this.getModel<T>(request.entity);
    await model.findByIdAndDelete(request.id).exec();

    return {
      status: true,
      message: `Deleted ${request.entity} successfully`,
      data: null,
    };
  }

  async count<T>(request: RawQlRequest): Promise<RawQlResponse<number>> {
    const model = this.getModel<T>(request.entity);
    const count = await model.countDocuments(request.filter || {}).exec();

    return {
      status: true,
      message: `Counted ${request.entity} successfuly`,
      data: {
        type: "single",
        item: count,
      },
    };
  }

  async aggregate<T>(request: RawQlRequest): Promise<RawQlResponse<T>> {
    const model = this.getModel<T>(request.entity);

    if (!request.pipeline) {
      return {
        status: false,
        message: "Missing 'pipeline' in aggregate request",
        data: null,
      };
    }

    if (!Array.isArray(request?.pipeline)) {
      return {
        status: false,
        message: "Missing 'pipeline' array in aggregate request",
        data: null,
      };
    }

    const items = await model
      .aggregate(this.convertPipeline(request.pipeline))
      .exec();

    return {
      status: true,
      message: `Aggregated ${request.entity} successfully`,
      data: {
        type: "multiple",
        items,
      },
    };
  }

  close(): Promise<void> {
    return disconnect();
  }
}
