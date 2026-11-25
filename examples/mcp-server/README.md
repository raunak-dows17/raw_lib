# raw_lib MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
guarded `raw_lib/agent` tools to Claude Desktop, Cursor, and other MCP clients.

Tools:

- `describe_entity`
- `query`
- `aggregate`
- `explain`

The policy is enforced in code: only `list`, `get`, `count`, and `aggregate` are allowed, tenant
scope is injected server-side, and user emails are redacted before results leave the process.
The demo runs on the in-memory adapter with seeded data, so there is no database to install.

## Run

```bash
cd examples/mcp-server
npm install
npm run dev
```

The process speaks MCP over stdio. Environment variables:

| Variable         | Default      | Purpose                            |
| ---------------- | ------------ | ---------------------------------- |
| `RAW_LIB_TENANT` | `t1`         | Tenant injected into every query   |
| `RAW_LIB_ACTOR`  | `mcp-client` | Actor recorded in the tool context |

## Claude Desktop / Cursor

Add this to the client's MCP configuration (use absolute paths):

```json
{
  "mcpServers": {
    "raw-lib": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/raw_lib/examples/mcp-server/src/server.ts"],
      "env": {
        "RAW_LIB_TENANT": "t1"
      }
    }
  }
}
```

Then ask:

> Use the raw-lib tools to describe `users`, then list the enterprise accounts.

> Which users have paid orders, and what is the total paid amount?

Try a cross-tenant or write request; the tool returns a typed `FORBIDDEN` error instead of
executing it.

## Production notes

- Replace `MemoryAdapter` with `mongo()` or your adapter.
- Keep the process read-only unless you add an approval callback and a write-capable policy.
- Terminate stdio behind your own authenticated launcher; never expose the process directly.
- Audit each tool call with `createAuditStore` from `raw_lib/agent`.
