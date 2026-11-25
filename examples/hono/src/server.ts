import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createRawQl, MemoryAdapter } from "raw_lib";
import { createAuth } from "raw_lib/auth";

type User = {
  id: string;
  email?: string | null;
  username?: string | null;
  roles?: string[];
  createdAt?: string;
};

const db = createRawQl({
  adapter: new MemoryAdapter(),
  entities: { users: {}, sessions: {}, otps: {} },
});

const auth = createAuth({
  db,
  secret: process.env.AUTH_SECRET ?? "dev-only-secret-change-me",
  fingerprint: { policy: "strict" },
});

const app = new Hono();

function deviceOf(c: { req: { header: (name: string) => string | undefined } }, deviceId?: string) {
  return {
    deviceId: deviceId ?? c.req.header("x-device-id"),
    userAgent: c.req.header("user-agent"),
    ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
  };
}

function bearer(c: { req: { header: (name: string) => string | undefined } }): string {
  const value = c.req.header("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function statusFor(code: string): 400 | 401 | 403 | 404 | 409 | 429 | 500 {
  if (code === "VALIDATION_FAILED") return 400;
  if (code === "FORBIDDEN") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  if (code === "RATE_LIMITED") return 429;
  if (code === "INTERNAL_ERROR" || code === "ADAPTER_ERROR") return 500;
  return 401;
}

app.post("/auth/register", async (c) => {
  const body = await c.req.json<{
    email?: string;
    username?: string;
    password?: string;
    deviceId?: string;
  }>();

  const result = await auth.register({
    email: body.email,
    username: body.username,
    password: body.password ?? "",
    device: deviceOf(c, body.deviceId),
  });

  if (!result.ok) return c.json({ error: result.error }, statusFor(result.error.code));
  return c.json(result.data, 201);
});

app.post("/auth/login", async (c) => {
  const body = await c.req.json<{
    identifier?: string;
    password?: string;
    deviceId?: string;
  }>();

  const result = await auth.login.password({
    identifier: body.identifier ?? "",
    password: body.password ?? "",
    device: deviceOf(c, body.deviceId),
  });

  if (!result.ok) return c.json({ error: result.error }, statusFor(result.error.code));
  return c.json(result.data);
});

app.post("/auth/refresh", async (c) => {
  const body = await c.req.json<{ refreshToken?: string }>();
  const result = await auth.refresh({
    refreshToken: body.refreshToken ?? "",
    device: deviceOf(c),
  });

  if (!result.ok) return c.json({ error: result.error }, statusFor(result.error.code));
  return c.json(result.data);
});

app.post("/auth/logout", async (c) => {
  const body = await c.req.json<{ refreshToken?: string }>();
  const result = await auth.logout({ refreshToken: body.refreshToken });

  if (!result.ok) return c.json({ error: result.error }, statusFor(result.error.code));
  return c.json(result.data);
});

app.get("/me", async (c) => {
  const result = await auth.verify({
    accessToken: bearer(c),
    device: deviceOf(c),
  });

  if (!result.ok) return c.json({ error: result.error }, statusFor(result.error.code));

  return c.json({
    user: result.data.user,
    session: result.data.session,
    expiresAt: new Date(result.data.claims.exp * 1_000).toISOString(),
  });
});

app.get("/users", async (c) => {
  const verified = await auth.verify({
    accessToken: bearer(c),
    device: deviceOf(c),
  });

  if (!verified.ok) {
    return c.json({ error: verified.error }, statusFor(verified.error.code));
  }

  const result = await db.entity<User>("users").list({
    select: ["id", "email", "username", "roles", "createdAt"],
    sort: { createdAt: "desc" },
    page: {
      limit: Math.min(Number(c.req.query("limit") ?? 20), 100),
      offset: Math.max(Number(c.req.query("offset") ?? 0), 0),
    },
  });

  if (!result.ok) return c.json({ error: result.error }, statusFor(result.error.code));
  return c.json(result.data);
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Hono example listening on http://localhost:${info.port}`);
});
