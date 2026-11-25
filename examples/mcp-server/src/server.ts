import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRawQl, MemoryAdapter } from "raw_lib";
import { type AgentEntities, defineAgentTools, normalizePolicy } from "raw_lib/agent";
import { z } from "zod";

const seed = {
  users: [
    { id: "u1", tenantId: "t1", name: "Ada", email: "ada@acme.com", plan: "enterprise" },
    { id: "u2", tenantId: "t1", name: "Linus", email: "linus@acme.com", plan: "pro" },
    { id: "u3", tenantId: "t1", name: "Grace", email: "grace@acme.com", plan: "pro" },
    { id: "u4", tenantId: "t2", name: "Margaret", email: "margaret@other.com", plan: "free" },
  ],
  orders: [
    { id: "o1", tenantId: "t1", userId: "u1", total: 500, status: "paid" },
    { id: "o2", tenantId: "t1", userId: "u2", total: 120, status: "open" },
    { id: "o3", tenantId: "t1", userId: "u3", total: 80, status: "paid" },
    { id: "o4", tenantId: "t2", userId: "u4", total: 20, status: "paid" },
  ],
};

const entities: AgentEntities = {
  users: {
    description: "Customer accounts for the current tenant",
    fields: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      plan: { type: "string", values: ["free", "pro", "enterprise"] },
      tenantId: { type: "string" },
    },
  },
  orders: {
    description: "Orders placed by users",
    fields: {
      id: { type: "string" },
      userId: { type: "string" },
      total: { type: "number" },
      status: { type: "string", values: ["open", "paid", "refunded"] },
      tenantId: { type: "string" },
    },
  },
};

const db = createRawQl({
  adapter: new MemoryAdapter({ seed }),
  entities: {
    users: { collection: "users" },
    orders: { collection: "orders" },
  },
});

const context = {
  actor: process.env.RAW_LIB_ACTOR ?? "mcp-client",
  tenant: process.env.RAW_LIB_TENANT ?? "t1",
};

const policy = normalizePolicy(
  {
    allowOps: ["list", "get", "count", "aggregate"],
    redactFields: { users: ["email"] },
    tenantScope: (ctx) => ({ tenantId: ctx.tenant }),
  },
  entities,
);

const toolkit = defineAgentTools({ db, policy, entities });
let callId = 0;

async function run(name: string, args: Record<string, unknown>) {
  const execution = await toolkit.execute(
    { id: `mcp-${++callId}`, name, arguments: args },
    { runId: `mcp-run-${callId}`, context },
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(execution.payload, null, 2),
      },
    ],
    ...(execution.result.ok ? {} : { isError: true }),
  };
}

const queryShape = z.object({
  op: z.enum(["list", "get", "count", "aggregate"]),
  entity: z.string(),
  where: z.record(z.string(), z.unknown()).optional(),
  sort: z.unknown().optional(),
  select: z.array(z.string()).optional(),
  page: z
    .object({ limit: z.number().int().optional(), offset: z.number().int().optional() })
    .optional(),
  pipeline: z.array(z.record(z.string(), z.unknown())).optional(),
});

const server = new McpServer({ name: "raw-lib-agent", version: "2.1.0" });

server.registerTool(
  "describe_entity",
  {
    description: "Describe an entity's fields, relations, and allowed operations.",
    inputSchema: { entity: z.string() },
  },
  async ({ entity }) => run("describe_entity", { entity }),
);

server.registerTool(
  "query",
  {
    description:
      "Run a read-only typed raw_lib query. Tenant scope and field redaction are enforced server-side.",
    inputSchema: { query: queryShape },
  },
  async ({ query }) => run("query", { query }),
);

server.registerTool(
  "aggregate",
  {
    description:
      "Run a read-only aggregation pipeline over an entity. Supported stages: $match, $group, $sort, $limit, $skip, $project, $lookup, $unwind, $addFields, $count.",
    inputSchema: {
      entity: z.string(),
      pipeline: z.array(z.record(z.string(), z.unknown())),
    },
  },
  async ({ entity, pipeline }) => run("aggregate", { entity, pipeline }),
);

server.registerTool(
  "explain",
  {
    description: "Compile a query without executing it and return the normalized plan.",
    inputSchema: { query: queryShape },
  },
  async ({ query }) => run("explain", { query }),
);

await server.connect(new StdioServerTransport());
