import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import MongoAdapter from "../src/rawql/adapters/MongoAdapter";
import { RawQlRequest } from "../src/rawql/config/types/rawql_request";
import {
  RawQlMultipleResponse,
  RawQlPaginatedResponse,
  RawQlResponseData,
  RawQlSingleResponse,
} from "../src/rawql/config/types/rawql_response";

interface User {
  _id?: string;
  name: string;
  email: string;
  age: number;
}

describe("MongoAdapter", () => {
  let mongoServer: MongoMemoryServer;
  let adapter: MongoAdapter;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    adapter = new MongoAdapter(uri);

    // Register a sample User model
    adapter.registerModel(
      "User",
      new Schema<User>({
        name: String,
        email: String,
        age: Number,
      })
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  test("create() should create a new user", async () => {
    const request: RawQlRequest = {
      type: "create",
      entity: "User",
      data: { name: "Alice", email: "alice@example.com", age: 25 },
    };

    const res = await adapter.execute<User>(request);

    expect(res.status).toBe(true);
    expect(res.data?.type).toBe("single");
    expect((res.data as any)?.item.name).toBe("Alice");
  });

  test("list() should return paginated users", async () => {
    // Create multiple users
    await adapter.execute({
      type: "create",
      entity: "User",
      data: { name: "Bob", email: "bob@example.com", age: 30 },
    });
    await adapter.execute({
      type: "create",
      entity: "User",
      data: { name: "Charlie", email: "charlie@example.com", age: 35 },
    });

    const request: RawQlRequest = {
      type: "list",
      entity: "User",
      options: { limit: 2, page: 1 },
    };

    const res = await adapter.execute(request);

    expect(res.status).toBe(true);
    expect(res.data?.type).toBe("paginated");
    expect((res.data as any)?.items.length).toBeLessThanOrEqual(2);
  });

  test("get() should retrieve a user by filter", async () => {
    const request: RawQlRequest = {
      type: "get",
      entity: "User",
      filter: { field: "name", op: "eq", value: "Alice" },
    };

    const res = await adapter.execute(request);

    expect(res.status).toBe(true);
    expect(res.data?.type).toBe("single");
    expect((res.data as any).item.name).toBe("Alice");
  });

  test("count() should return correct user count", async () => {
    const request: RawQlRequest = {
      type: "count",
      entity: "User",
      filter: { field: "age", op: "gt", value: 20 },
    };

    const res = await adapter.execute<number>(request);

    expect(res.status).toBe(true);
    expect((res.data as any).item).toBeGreaterThan(0);
  });
});
