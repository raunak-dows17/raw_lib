import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function fail(message) {
  console.error(`\nPackage smoke test failed: ${message}`);
  process.exit(1);
}

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--silent"], { cwd: root, encoding: "utf8" }),
);

const info = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
if (!info) fail("npm pack produced no tarball");

const tarball = join(root, info.filename);
const files = info.files.map((file) => file.path);

const required = [
  "dist/index.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/mongo/index.js",
  "dist/mongo/index.cjs",
  "dist/mongo/index.d.ts",
  "dist/val/index.js",
  "dist/auth/index.js",
  "README.md",
  "MIGRATION.md",
  "CHANGELOG.md",
  "LICENSE",
];

for (const file of required) {
  if (!files.includes(file)) fail(`missing ${file} from the tarball`);
}

if (files.some((file) => file.startsWith("src/") || file.startsWith("tests/"))) {
  fail("source or test files leaked into the tarball");
}

const directory = mkdtempSync(join(tmpdir(), "raw-lib-smoke-"));

try {
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "raw-lib-smoke", private: true, type: "module" }, null, 2),
  );

  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball, "mongodb@^7"], {
    cwd: directory,
  });

  writeFileSync(
    join(directory, "esm.mjs"),
    `import { createRawQl, MemoryAdapter } from "raw_lib";
import { rawval, v } from "raw_lib/val";
import { createAuth } from "raw_lib/auth";
import { mongo, toMongoFilter } from "raw_lib/mongo";

const db = createRawQl({
  adapter: new MemoryAdapter(),
  validate: rawval({ users: { create: v.object({ email: v.string().email() }) } }),
});

const created = await db.execute({ op: "create", entity: "users", data: { email: "a@b.co" } });
if (!created.ok) throw new Error(created.error.message);

const auth = createAuth({ db, secret: "smoke-secret-0123456789" });
const registered = await auth.register({ email: "smoke@acme.com", password: "password123" });
if (!registered.ok) throw new Error(registered.error.message);

const verified = await auth.verify({ accessToken: registered.data.accessToken });
if (!verified.ok) throw new Error(verified.error.message);

const filter = toMongoFilter({ kind: "comparison", field: "id", op: "eq", value: "u1" }, "id");
if (JSON.stringify(filter) !== '{"_id":"u1"}') throw new Error("unexpected mongo filter");
if (typeof mongo !== "function") throw new Error("mongo adapter missing");

console.log("ESM smoke passed");
`,
  );

  run(process.execPath, [join(directory, "esm.mjs")], { cwd: directory });

  writeFileSync(
    join(directory, "cjs.cjs"),
    `const { createRawQl, MemoryAdapter } = require("raw_lib");
const { rawval, v } = require("raw_lib/val");
const { createAuth } = require("raw_lib/auth");
const { mongo } = require("raw_lib/mongo");

(async () => {
  const db = createRawQl({
    adapter: new MemoryAdapter(),
    validate: rawval({ users: { create: v.object({ email: v.string().email() }) } }),
  });

  const auth = createAuth({ db, secret: "smoke-secret-0123456789" });
  const registered = await auth.register({ email: "smoke@acme.com", password: "password123" });
  if (!registered.ok) throw new Error(registered.error.message);
  if (typeof mongo !== "function") throw new Error("mongo adapter missing");

  console.log("CJS smoke passed");
})();
`,
  );

  run(process.execPath, [join(directory, "cjs.cjs")], { cwd: directory });

  writeFileSync(
    join(directory, "index.ts"),
    `import { createRawQl, MemoryAdapter, type Result } from "raw_lib";
import { rawval, v, type Schema } from "raw_lib/val";
import { createAuth, type Auth } from "raw_lib/auth";
import { mongo, type MongoAdapterOptions } from "raw_lib/mongo";

const db = createRawQl({ adapter: new MemoryAdapter() });
const schema: Schema<{ email: string }> = v.object({ email: v.string().email() });
const validator = rawval({ users: { create: schema } });
const auth: Auth = createAuth({ db, secret: "smoke-secret-0123456789" });
const options: MongoAdapterOptions = { uri: "mongodb://localhost:27017/test" };

export async function check(): Promise<Result<unknown>> {
  return db.execute({ op: "count", entity: "users" });
}

export { auth, validator, options, mongo };
`,
  );

  run(
    join(root, "node_modules", ".bin", "tsc"),
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "index.ts",
    ],
    { cwd: directory },
  );

  console.log("\nPackage smoke test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
