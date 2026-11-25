import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
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

const app = Fastify({ logger: true });

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function deviceOf(request: FastifyRequest, deviceId?: string) {
  return {
    deviceId: deviceId ?? header(request, "x-device-id"),
    userAgent: header(request, "user-agent"),
    ip: request.ip,
  };
}

function bearer(request: FastifyRequest): string {
  const value = header(request, "authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function statusFor(code: string): number {
  if (code === "VALIDATION_FAILED") return 400;
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  if (code === "RATE_LIMITED") return 429;
  if (code === "FORBIDDEN") return 403;
  if (code === "INTERNAL_ERROR" || code === "ADAPTER_ERROR") return 500;
  return 401;
}

function send(
  reply: FastifyReply,
  result: { ok: boolean; data?: unknown; error?: { code: string } },
  status = 200,
) {
  if (result.ok) return reply.code(status).send(result.data);
  return reply
    .code(statusFor(result.error?.code ?? "INTERNAL_ERROR"))
    .send({ error: result.error });
}

app.post("/auth/register", async (request, reply) => {
  const body = (request.body ?? {}) as {
    email?: string;
    username?: string;
    password?: string;
    deviceId?: string;
  };

  const result = await auth.register({
    email: body.email,
    username: body.username,
    password: body.password ?? "",
    device: deviceOf(request, body.deviceId),
  });

  return send(reply, result, 201);
});

app.post("/auth/login", async (request, reply) => {
  const body = (request.body ?? {}) as {
    identifier?: string;
    password?: string;
    deviceId?: string;
  };

  const result = await auth.login.password({
    identifier: body.identifier ?? "",
    password: body.password ?? "",
    device: deviceOf(request, body.deviceId),
  });

  return send(reply, result);
});

app.post("/auth/refresh", async (request, reply) => {
  const body = (request.body ?? {}) as { refreshToken?: string };
  const result = await auth.refresh({
    refreshToken: body.refreshToken ?? "",
    device: deviceOf(request),
  });

  return send(reply, result);
});

app.post("/auth/logout", async (request, reply) => {
  const body = (request.body ?? {}) as { refreshToken?: string };
  const result = await auth.logout({ refreshToken: body.refreshToken });
  return send(reply, result);
});

app.get("/me", async (request, reply) => {
  const result = await auth.verify({
    accessToken: bearer(request),
    device: deviceOf(request),
  });

  if (!result.ok) return send(reply, result);

  return {
    user: result.data.user,
    session: result.data.session,
    expiresAt: new Date(result.data.claims.exp * 1_000).toISOString(),
  };
});

app.get("/users", async (request, reply) => {
  const verified = await auth.verify({
    accessToken: bearer(request),
    device: deviceOf(request),
  });

  if (!verified.ok) return send(reply, verified);

  const query = request.query as { limit?: string; offset?: string };
  const result = await db.entity<User>("users").list({
    select: ["id", "email", "username", "roles", "createdAt"],
    sort: { createdAt: "desc" },
    page: {
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Math.max(Number(query.offset ?? 0), 0),
    },
  });

  return send(reply, result);
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`Fastify example listening on http://localhost:${port}`);
