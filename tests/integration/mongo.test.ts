import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth";
import { createRawQl } from "../../src/index";
import { MongoAdapter, mongo } from "../../src/mongo";
import { contractSeed, runAdapterContractTests } from "../contract/adapter-contract";

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

function uniqueDbName(): string {
  return `rawlib_${randomUUID().replace(/-/g, "")}`;
}

runAdapterContractTests("mongodb", async () => {
  const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
  const db = createRawQl({ adapter });

  await db.execute({ op: "create", entity: "users", data: contractSeed.users });
  await db.execute({ op: "create", entity: "posts", data: contractSeed.posts });

  return { db, close: () => adapter.close() };
});

describe("mongodb adapter specifics", () => {
  it("requires a uri or an existing client", () => {
    expect(() => new MongoAdapter({})).toThrowError(/uri/);
  });

  it("derives the database name from the uri", async () => {
    const adapter = mongo({ uri: `${server.getUri()}from_uri` });
    const db = createRawQl({ adapter });

    const created = await db.execute<{ id: string }>({
      op: "create",
      entity: "things",
      data: { name: "x" },
    });
    const found = await db.execute<{ id: string; name: string }>({
      op: "get",
      entity: "things",
      where: { id: created.ok ? created.data.id : "" },
    });

    expect(found.ok && found.data?.name).toBe("x");
    await adapter.close();
  });

  it("maps generated ObjectIds to string ids", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({ adapter });

    const created = await db.execute<{ id: string }>({
      op: "create",
      entity: "users",
      data: { name: "Ada" },
    });

    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(typeof created.data.id).toBe("string");
      expect(created.data.id).toMatch(/^[0-9a-f]{24}$/);
    }

    await adapter.close();
  });

  it("round-trips explicit 24-hex ids as ObjectIds", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({ adapter });
    const id = "507f1f77bcf86cd799439011";

    const created = await db.execute<{ id: string }>({
      op: "create",
      entity: "users",
      data: { id, name: "Ada" },
    });
    const found = await db.execute<{ id: string; name: string }>({
      op: "get",
      entity: "users",
      where: { id },
    });

    expect(created.ok && created.data.id).toBe(id);
    expect(found.ok && found.data?.name).toBe("Ada");

    await adapter.close();
  });

  it("supports a custom idField", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({
      adapter,
      entities: { users: { idField: "userId" } },
    });

    const created = await db.execute<{ userId: string; name: string }>({
      op: "create",
      entity: "users",
      data: { name: "Ada" },
    });
    const found = await db.execute<{ userId: string; name: string }>({
      op: "get",
      entity: "users",
      where: { userId: created.ok ? created.data.userId : "" },
    });

    expect(created.ok && created.data.userId).toBeTruthy();
    expect(found.ok && found.data?.name).toBe("Ada");

    await adapter.close();
  });

  it("supports _id as the configured idField", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({ adapter, entities: { users: { idField: "_id" } } });

    const created = await db.execute<{ _id: string }>({
      op: "create",
      entity: "users",
      data: { name: "Ada" },
    });
    const found = await db.execute<{ _id: string; name: string }>({
      op: "get",
      entity: "users",
      where: { _id: created.ok ? created.data._id : "" },
    });

    expect(found.ok && found.data?.name).toBe("Ada");

    await adapter.close();
  });

  it("escapes regular expression characters in text filters", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({ adapter });

    await db.execute({
      op: "create",
      entity: "docs",
      data: [
        { id: "1", title: "v1.0" },
        { id: "2", title: "v1x0" },
      ],
    });

    const result = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "docs",
      where: { title: { contains: "." } },
    });

    expect(result.ok && result.data.map((row) => row.id)).toEqual(["1"]);
    await adapter.close();
  });

  it("filters with $not", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({ adapter });

    await db.execute({
      op: "create",
      entity: "users",
      data: [
        { id: "1", role: "admin" },
        { id: "2", role: "member" },
      ],
    });

    const result = await db.execute<{ id: string }[]>({
      op: "list",
      entity: "users",
      where: { $not: { role: "admin" } },
    });

    expect(result.ok && result.data.map((row) => row.id)).toEqual(["2"]);
    await adapter.close();
  });

  it("updates and deletes every matching row", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({ adapter });

    await db.execute({
      op: "create",
      entity: "users",
      data: [
        { id: "1", role: "admin", active: false },
        { id: "2", role: "admin", active: false },
        { id: "3", role: "member", active: false },
      ],
    });

    const updated = await db.execute({
      op: "update",
      entity: "users",
      where: { role: "admin" },
      data: { active: true },
    });
    const deleted = await db.execute({
      op: "delete",
      entity: "users",
      where: { active: true },
    });
    const count = await db.execute<number>({ op: "count", entity: "users" });

    expect(updated.ok).toBe(true);
    expect(deleted.ok).toBe(true);
    expect(count.ok && count.data).toBe(1);
    await adapter.close();
  });

  it("counts non-null values in grouped counts", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({ adapter });

    await db.execute({
      op: "create",
      entity: "docs",
      data: [
        { id: "1", group: "a", value: 1 },
        { id: "2", group: "a" },
        { id: "3", group: "a", value: null },
      ],
    });

    const result = await db.execute<{ _id: string; filled: number }[]>({
      op: "aggregate",
      entity: "docs",
      pipeline: [
        {
          $group: {
            by: "group",
            fields: { filled: { op: "count", field: "value" } },
          },
        },
      ],
    });

    expect(result.ok && result.data).toEqual([{ _id: "a", filled: 1 }]);
    await adapter.close();
  });

  it("does not claim cursor pagination or transactions", () => {
    const adapter = mongo({ uri: "mongodb://localhost:27017/test" });
    expect(adapter.capabilities.has("page.offset")).toBe(true);
    expect(adapter.capabilities.has("page.cursor")).toBe(false);
    expect(adapter.capabilities.has("transactions")).toBe(false);
  });

  it("reuses an external client without closing it", async () => {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(server.getUri());
    await client.connect();

    const adapter = mongo({ client, dbName: uniqueDbName() });
    const db = createRawQl({ adapter });

    await db.execute({ op: "create", entity: "users", data: { id: "1" } });
    await adapter.close();

    expect(await client.db("admin").command({ ping: 1 })).toMatchObject({ ok: 1 });
    await client.close();
  });

  it("returns typed adapter errors when the connection fails", async () => {
    const adapter = mongo({
      uri: "mongodb://127.0.0.1:1/nope",
      clientOptions: { serverSelectionTimeoutMS: 200 },
    });
    const db = createRawQl({ adapter });

    const result = await db.execute({ op: "count", entity: "users" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ADAPTER_ERROR");
  });
});

describe("mongodb auth integration", () => {
  it("runs password auth, rotation, and reuse revocation", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({ adapter });
    const auth = createAuth({ db, secret: "mongo-auth-secret-0123456789" });

    const registered = await auth.register({
      email: "Mongo@Acme.com",
      password: "password123",
      device: { deviceId: "device-1" },
    });

    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const login = await auth.login.password({
      identifier: "mongo@acme.com",
      password: "password123",
      device: { deviceId: "device-1" },
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const verified = await auth.verify({
      accessToken: login.data.accessToken,
      device: { deviceId: "device-1" },
    });
    expect(verified.ok).toBe(true);

    const refreshed = await auth.refresh({
      refreshToken: login.data.refreshToken,
      device: { deviceId: "device-1" },
    });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;

    const replay = await auth.refresh({ refreshToken: login.data.refreshToken });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("TOKEN_INVALID");

    const afterReuse = await auth.refresh({ refreshToken: refreshed.data.refreshToken });
    expect(afterReuse.ok).toBe(false);
    if (!afterReuse.ok) expect(afterReuse.error.code).toBe("SESSION_REVOKED");

    const sessions = await auth.sessions.list({ userId: registered.data.user.id });
    expect(sessions.ok && sessions.data.length).toBe(2);

    await adapter.close();
  });
});

describe("mongodb otp integration", () => {
  it("requests, consumes, and locks one-time codes", async () => {
    const adapter = mongo({ uri: server.getUri(), dbName: uniqueDbName() });
    const db = createRawQl({ adapter });
    let delivered = "";
    const auth = createAuth({
      db,
      secret: "mongo-otp-secret-0123456789",
      otp: {
        provider: {
          async send(input) {
            delivered = input.code;
            return { ok: true, providerId: "fake" };
          },
        },
        rateLimit: false,
      },
    });

    await auth.register({ email: "otp@acme.com", password: "password123" });

    const request = await auth.login.otp.request({ contact: "otp@acme.com" });
    expect(request.ok).toBe(true);
    if (!request.ok) return;

    const verify = await auth.login.otp.verify({
      otpId: request.data.otpId,
      code: delivered,
    });
    expect(verify.ok).toBe(true);

    const replay = await auth.login.otp.verify({
      otpId: request.data.otpId,
      code: delivered,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("OTP_ALREADY_USED");

    await adapter.close();
  });
});
