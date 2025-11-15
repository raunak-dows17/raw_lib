# 🧠 raw_lib — Modular Query, Validation & Authentication Engine for Node.js

`raw_lib` is a modular backend framework built around three core systems:

- **RawQL** → Structured query engine
- **RawVal** → Schema validation engine
- **RawAuth** → Authentication & session security engine

All three are framework-agnostic, database-independent, and follow Clean Architecture principles.

It’s designed for serious backend work:

- predictable structure
- strict type-safety
- reusable logic
- cross-framework compatibility
- minimal boilerplate

---

# 🔥 Why raw_lib?

- 🧩 **Modular & Extensible** — use only RawQL, or RawAuth, or all combined
- 🗄️ **Database Independent** — MongoDB, SQL, Redis, you choose
- 🔧 **Strict Query System** — replace ad-hoc CRUD with structured `RawQlRequest`
- 🔐 **Built-in Authentication System** (RawAuth)
- 🛡️ **Built-in Validation System** (RawVal)
- 🚀 **Adapter-driven architecture**
- 🧰 **Written in TypeScript**
- ♻️ **Works in Express, Fastify, Hono, NestJS, Cloudflare Workers**

---

# 📦 Installation

```bash
npm install raw_lib
```

---

# 📁 Core Modules

```
rawql/       => Structured Query Engine
rawval/      => Validation Engine
rawauth/     => Authentication Engine
adapters/    => Mongo / Redis / Future SQL adapters
types/       => Clean request & response types
```

---

# 🔷 RawQL — Structured Query Engine

RawQL standardizes backend data access through a **typed request format**.

### Supported Operations

```ts
export type RawQlOperation =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "count"
  | "aggregate";
```

---

### 📨 RawQlRequest

```ts
const request: RawQlRequest = {
  type: "list",
  entity: "users",
  filter: { field: "role", op: "eq", value: "admin" },
  options: {
    page: 1,
    limit: 10,
    sort: [{ field: "createdAt", direction: "desc" }],
  },
};
```

---

### 📬 RawQlResponse

```ts
{
  status: true,
  message: "Fetched users successfully",
  data: {
    type: "paginated",
    items: [...],
    totalItems: 42,
    currentPage: 1,
    totalPages: 5
  }
}
```

---

# 🧩 RawQL MongoAdapter Example

```ts
import MongoAdapter from "raw_lib/rawql/adapters/mongo_adapter";
import { RawQlEngine } from "raw_lib/rawql";

const adapter = new MongoAdapter("mongodb://localhost/mydb");

// Register Mongoose schemas
adapter.registerModel("users", userSchema);
adapter.registerModel("todos", todoSchema);

const engine = new RawQlEngine(adapter);

const response = await engine.execute({
  type: "get",
  entity: "users",
  filter: { field: "username", op: "eq", value: "raunak" },
});
```

---

# 🛡️ RawVal — Validation Engine

```ts
import { RawValEngine } from "raw_lib/rawval";
import { z } from "zod";

const val = new RawValEngine();

val.register("users", {
  create: {
    username: z.string().min(3),
    email: z.string().email(),
    password: z.string().min(6),
  },
});
```

Validation is fully optional but recommended.

---

# 🔐 RawAuth — Authentication & Device Session Engine

RawAuth is a **database-agnostic authentication module** that plugs directly into RawQL and handles:

- 🔑 Password login
- ✉️ Email & phone OTP login
- 📱 Device-based session tracking
- 🪪 Short-lived JWT issuing
- 🕵️ Token verification with fingerprint matching
- 🚫 Revoking sessions / logout
- 🔒 OTP storage with hashing + expiry
- 🧪 Provider-agnostic OTP delivery (SMS/Email via Twilio, SendGrid, etc.)

### RawAuth does _not_ touch the database directly.

It calls **RawQL**, which calls your adapter (Mongo/SQL/Redis…).

---

## ⚙️ RawAuth Usage Example (Mongo + Express)

```ts
import express from "express";
import MongoAdapter from "raw_lib/rawql/adapters/mongo_adapter";
import { RawAuthEngine } from "raw_lib/rawauth";
import { registerModels } from "./models/registerModels";

const mongo = new MongoAdapter("mongodb://localhost:27017/rawlib");
registerModels(mongo); // users, deviceSessions, otpCodes schemas

const rawql = { execute: (req) => mongo.execute(req) };

const auth = new RawAuthEngine({
  rawql,
  jwtSecret: process.env.JWT_SECRET,
});

const app = express();
app.use(express.json());

// fingerprint helper
const fp = (req) => ({
  deviceId: req.headers["x-device-id"],
  userAgent: req.headers["user-agent"],
  ip: req.ip,
});

// password login
app.post("/auth/login", async (req, res) => {
  const resp = await auth.loginWithPassword({
    identifier: req.body.identifier,
    password: req.body.password,
    fingerprint: fp(req),
  });
  res.json(resp);
});

// verify token
app.get("/protected", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const resp = await auth.verifyToken(token, fp(req));
  res.status(resp.status ? 200 : 401).json(resp);
});
```

---

## 🔢 OTP Flow Example

```ts
app.post("/auth/otp/send", async (req, res) => {
  const resp = await auth.sendOtp(req.body.contact);
  res.json(resp); // returns { status, data: { otpId } }
});

app.post("/auth/otp/verify", async (req, res) => {
  const resp = await auth.verifyOtp(req.body.otpId, req.body.code);
  res.json(resp);
});
```

You can plug in a real provider:

- Twilio SMS
- SendGrid Email
- AWS SES
- Firebase Phone Auth

RawAuth stays the same — only the provider changes.

---

# 🧠 Example Use Cases

- Build Firebase-like backend with database & auth abstraction
- Strict and predictable authentication without framework lock-in
- Enforce device-based session integrity
- Replace REST CRUD with structured RawQL queries
- Use one generic controller to process all entity actions
- Create backend SDKs for frontend apps
- Build internal tools with full type safety

---

# 🚀 Roadmap

## RawQL

- [x] MongoDB Adapter
- [ ] SQL Adapter
- [ ] Redis Adapter
- [ ] GraphQL Transport Layer
- [ ] Socket Adapter

## RawVal

- [x] Base Validation Engine
- [ ] Auto-schema generation
- [ ] DTO generator for frontend

## RawAuth

- [x] User + Device Session Model
- [x] Password login
- [x] OTP login
- [x] JWT issuing
- [x] Token verification + fingerprint check
- [ ] OAuth providers (Google, Apple, GitHub)
- [ ] RBAC / Roles integration with RawQL
- [ ] Multi-tenant auth

---

# ✍️ Author

Made with ❤️ by **Raunak Pandey**

GitHub: [https://github.com/raunak-dows17](https://github.com/raunak-dows17)

---

# 📄 License

MIT — free for commercial and open-source use.

---
