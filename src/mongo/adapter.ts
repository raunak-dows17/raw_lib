import { type Db, type Document, MongoClient, type MongoClientOptions } from "mongodb";
import { RawLibError, toRawLibError } from "../core/errors";
import type { Adapter, AdapterResult } from "../core/types/adapter";
import type { Capability } from "../core/types/capability";
import type { NormalizedQuery } from "../core/types/normalized";
import { isPlainObject } from "../core/utils";
import {
  extractId,
  mapAggregateDocuments,
  mapDocument,
  prepareDocument,
  preparePatch,
  toMongoFilter,
  toMongoPipeline,
  toMongoProjection,
  toMongoSort,
} from "./convert";

export type MongoAdapterOptions = {
  /** MongoDB connection string. Required unless `client` is provided. */
  uri?: string;
  /** Database name. Defaults to the database in the URI, then `raw_lib`. */
  dbName?: string;
  /** Reuse an existing client instead of creating one. The adapter will not close it. */
  client?: MongoClient;
  /** Options passed to a client created by the adapter. */
  clientOptions?: MongoClientOptions;
};

const CAPABILITIES: Capability[] = [
  "filter.logical",
  "filter.comparison",
  "filter.array",
  "filter.text",
  "filter.presence",
  "sort",
  "select",
  "page.offset",
  "pipeline.match",
  "pipeline.group",
  "pipeline.sort",
  "pipeline.limit",
  "pipeline.skip",
  "pipeline.project",
  "pipeline.lookup",
  "pipeline.unwind",
  "pipeline.addFields",
  "pipeline.count",
  "atomic.update",
];

export class MongoAdapter implements Adapter {
  readonly name = "mongodb";
  readonly capabilities = new Set<Capability>(CAPABILITIES);

  private readonly uri?: string;
  private readonly dbName?: string;
  private readonly clientOptions?: MongoClientOptions;
  private readonly ownsClient: boolean;
  private client?: MongoClient;
  private db?: Db;
  private connecting?: Promise<Db>;

  constructor(options: MongoAdapterOptions = {}) {
    if (!options.client && !options.uri) {
      throw new RawLibError(
        "VALIDATION_FAILED",
        "mongo() requires a `uri` or an existing `client`",
      );
    }

    this.uri = options.uri;
    this.dbName = options.dbName;
    this.clientOptions = options.clientOptions;
    this.client = options.client;
    this.ownsClient = !options.client;
  }

  async connect(): Promise<void> {
    await this.ensureDb();
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client?.close();
    }
    this.client = this.ownsClient ? undefined : this.client;
    this.db = undefined;
    this.connecting = undefined;
  }

  async execute<T>(query: NormalizedQuery): Promise<AdapterResult<T>> {
    const db = await this.ensureDb();
    const collection = db.collection(query.entity.collection);
    const idField = query.entity.idField;

    switch (query.op) {
      case "list": {
        const filter = toMongoFilter(query.where, idField);
        const total = await collection.countDocuments(filter);
        const projection = query.select ? toMongoProjection(query.select, idField) : undefined;

        let cursor = collection.find(filter, projection ? { projection } : undefined);
        if (query.sort) cursor = cursor.sort(toMongoSort(query.sort, idField));
        if (query.page) cursor = cursor.skip(query.page.offset).limit(query.page.limit);

        const docs = await cursor.toArray();
        const items =
          query.select?.length === 0
            ? docs.map(() => ({}))
            : docs.map((doc) => mapDocument(doc, idField));

        return { kind: "items", items: items as T[], total };
      }

      case "get": {
        const filter = toMongoFilter(query.where, idField);
        const projection = query.select ? toMongoProjection(query.select, idField) : undefined;
        const doc = await collection.findOne(filter, projection ? { projection } : undefined);

        return {
          kind: "item",
          item: doc ? (mapDocument(doc, idField) as T) : null,
        };
      }

      case "create": {
        if (query.data === undefined) {
          throw new RawLibError("VALIDATION_FAILED", "`create` requires `data`");
        }

        const many = Array.isArray(query.data);
        const input: unknown[] = many ? (query.data as unknown[]) : [query.data];
        const docs: Record<string, unknown>[] = input.map((item) => {
          if (!isPlainObject(item)) {
            throw new RawLibError(
              "VALIDATION_FAILED",
              "`create` data must be an object or an array of objects",
            );
          }
          return prepareDocument(item, idField);
        });

        if (many) {
          if (docs.length === 0) return { kind: "items", items: [] };
          const result = await collection.insertMany(docs);
          const inserted = docs.map((doc, index) => ({
            ...doc,
            _id: result.insertedIds[index],
          }));
          return {
            kind: "items",
            items: inserted.map((doc) => mapDocument(doc, idField)) as T[],
          };
        }

        const result = await collection.insertOne(docs[0] as Document);
        const inserted = { ...(docs[0] as Document), _id: result.insertedId };
        return { kind: "item", item: mapDocument(inserted, idField) as T };
      }

      case "update": {
        const filter = toMongoFilter(query.where, idField);
        const first = await collection.findOne(filter, { projection: { _id: 1, [idField]: 1 } });

        if (!first) return { kind: "ack", matched: 0 };

        if (!isPlainObject(query.data)) {
          throw new RawLibError("VALIDATION_FAILED", "`update` data must be an object");
        }

        const patch = preparePatch(query.data, idField);

        if (Object.keys(patch).length === 0) {
          return { kind: "ack", matched: 1, id: extractId(first, idField) };
        }

        const result = await collection.updateMany(filter, { $set: patch });

        return {
          kind: "ack",
          matched: result.matchedCount,
          id: extractId(first, idField),
        };
      }

      case "delete": {
        const filter = toMongoFilter(query.where, idField);
        const first = await collection.findOne(filter, { projection: { _id: 1, [idField]: 1 } });

        if (!first) return { kind: "ack", matched: 0 };

        const result = await collection.deleteMany(filter);
        return {
          kind: "ack",
          matched: result.deletedCount,
          id: extractId(first, idField),
        };
      }

      case "count": {
        const filter = toMongoFilter(query.where, idField);
        return { kind: "count", count: await collection.countDocuments(filter) };
      }

      case "aggregate": {
        const pipeline = query.pipeline ?? [];
        const docs = await collection.aggregate(toMongoPipeline(pipeline, idField)).toArray();
        const keepGroupId = pipeline.some((step) => "$group" in step || "$count" in step);

        return {
          kind: "items",
          items: mapAggregateDocuments(docs, idField, keepGroupId) as T[],
        };
      }
    }
  }

  private async ensureDb(): Promise<Db> {
    if (this.db) return this.db;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = this.client ?? new MongoClient(this.uri as string, this.clientOptions);
      this.client = client;

      await client.connect();

      const db = client.db(this.dbName ?? parseDbName(this.uri) ?? "raw_lib");
      this.db = db;
      return db;
    })().catch((error) => {
      this.connecting = undefined;
      throw toRawLibError(error, "ADAPTER_ERROR");
    });

    return this.connecting;
  }
}

export function mongo(options: MongoAdapterOptions): MongoAdapter {
  return new MongoAdapter(options);
}

function parseDbName(uri?: string): string | undefined {
  if (!uri) return undefined;

  try {
    const path = new URL(uri).pathname.replace(/^\//, "");
    return path.length > 0 ? decodeURIComponent(path) : undefined;
  } catch {
    return undefined;
  }
}
