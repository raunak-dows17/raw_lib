# 🧠 raw_lib — A Modular Query & Validation Engine for Node.js

`raw_lib` is a modular, flexible, and database-independent library that enables structured query execution (RawQL) and schema-based validation (RawVal) using a Clean Architecture mindset.

It’s designed to empower backend developers to rapidly implement standardized APIs, reduce boilerplate, and let frontends query exactly what they need — securely and scalably.

---

## 🔥 Why raw_lib?

- ✅ **Database Independent** (MongoDB, SQL, Redis, etc.)
- 🚀 **Structured Query Engine**: Run create, read, update, delete, list, count, and aggregation through unified `RawQlRequest`
- 🔒 **Integrated Validation Engine** (RawVal)
- 🔌 **Pluggable Adapters & Middleware**
- ♻️ **Reusable in CLI, API, or Microservices**
- 🧰 **Written in TypeScript**

---

## 📦 Installation

```bash
npm install raw_lib
```

---

## 📁 Structure

- `rawql/` — Core query execution engine
- `rawval/` — Validation engine (optional)
- `adapters/` — Adapter interfaces & implementations (MongoDB etc.)
- `types/` — Cleanly defined types for request & response

---

## 📘 RawQl: Query Engine

### 🔄 Supported Operations

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

### 📥 `RawQlRequest`

```ts
const request: RawQlRequest = {
  type: "list",
  entity: "User",
  filter: { field: "role", op: "eq", value: "admin" },
  options: {
    page: 1,
    limit: 10,
    sort: [{ field: "createdAt", direction: "desc" }],
    populate: ["profile"], // Mongoose adapter only
  },
};
```

---

### 📤 `RawQlResponse`

```ts
{
  status: true,
  message: "Fetched User list successfully",
  data: {
    type: "paginated",
    items: [...],
    totalItems: 10,
    currentPage: 1,
    totalPages: 1
  }
}
```

---

## 🧩 MongoAdapter (example)

```ts
import { MongoAdapter } from "raw_lib";
import mongoose from "mongoose";

const adapter = new MongoAdapter("mongodb://localhost:27017/mydb");

adapter.registerModel("User", userSchema);
adapter.registerModel("Todo", todoSchema);
```

Then use it in the engine:

```ts
import { RawQlEngine } from "raw_lib";
const engine = new RawQlEngine(adapter);

const response = await engine.execute({
  type: "get",
  entity: "User",
  filter: { field: "username", op: "eq", value: "raunak" },
});
```

---

## 🛡️ Validation (RawVal Engine)

```ts
const validator = new RawValEngine();

validator.register("User", {
  create: {
    username: z.string().min(3),
    email: z.string().email(),
    password: z.string().min(6),
  },
});
```

---

## ⚙️ Middleware Support

```ts
engine.use(async (req) => {
  // Example: Inject userId
  req.data.userId = "xyz123";
});
```

---

## 📦 Works Seamlessly With:

✅ `raw_cli` (Node CLI generator)  
✅ Clean Architecture setups  
✅ Any framework using Express, Fastify, NestJS, etc.

---

## 🚀 Example POST /users/list API

```ts
app.post("/users/list", async (req, res) => {
  const response = await engine.execute(req.body);
  res.json(response);
});
```

---

## 🧠 Example Use Cases

- Replace REST CRUD APIs with structured queries
- Pass only one generic controller per entity (`/users`, `/todos`)
- Decouple frontend from backend changes
- Auto-generate frontend SDKs (future)
- Add permissions/validation with middlewares

---

## 🏁 Roadmap

- [x] Mongoose Adapter
- [x] Zod-based Validation Engine
- [x] Aggregation Pipeline support
- [x] Populate support (Mongoose)
- [ ] Redis Adapter
- [ ] SQL Adapter
- [ ] CLI Integration (`raw_cli`)
- [ ] Socket Adapter (idea stage)

---

## ✍️ Author

Made with ❤️ by **Raunak Pandey**

GitHub: [github.com/raunak-dows17](https://github.com/raunak-dows17)

---

## 📄 License

[MIT License](LICENSE)

Use it. Improve it. Fork it. Break it. We’re just getting started.
