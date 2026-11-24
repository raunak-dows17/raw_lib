import express, { type Request, type Response } from "express";
import { createRawQl, MemoryAdapter, type Result } from "raw_lib";
import { createAuth } from "raw_lib/auth";
import { rawval, v } from "raw_lib/val";

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
  validate: rawval({
    users: {
      update: v.object({ username: v.string().min(3) }).partial(),
    },
  }),
});

const auth = createAuth({
  db,
  secret: process.env.AUTH_SECRET ?? "dev-only-secret-change-me",
  accessTtl: "15m",
  refreshTtl: "30d",
  fingerprint: { policy: "strict" },
});

const app = express();
app.use(express.json());

function deviceOf(request: Request, deviceId?: string) {
  return {
    deviceId: deviceId ?? request.header("x-device-id"),
    userAgent: request.header("user-agent"),
    ip: request.ip,
  };
}

function bearer(request: Request): string {
  const header = request.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function statusFor(code: string): number {
  switch (code) {
    case "VALIDATION_FAILED":
      return 400;
    case "INVALID_CREDENTIALS":
    case "TOKEN_INVALID":
    case "TOKEN_EXPIRED":
    case "SESSION_REVOKED":
    case "FINGERPRINT_MISMATCH":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    default:
      return 500;
  }
}

function respond(response: Response, result: Result<unknown>, status = 200): void {
  if (result.ok) {
    response.status(status).json(result.data);
    return;
  }

  response.status(statusFor(result.error.code)).json({ error: result.error });
}

app.post("/auth/register", async (request, response) => {
  const { email, password, username, deviceId } = request.body ?? {};

  const result = await auth.register({
    email,
    username,
    password,
    device: deviceOf(request, deviceId),
  });

  respond(response, result, 201);
});

app.post("/auth/login", async (request, response) => {
  const { identifier, password, deviceId } = request.body ?? {};

  const result = await auth.login.password({
    identifier,
    password,
    device: deviceOf(request, deviceId),
  });

  respond(response, result);
});

app.post("/auth/refresh", async (request, response) => {
  const { refreshToken } = request.body ?? {};

  const result = await auth.refresh({
    refreshToken,
    device: deviceOf(request),
  });

  respond(response, result);
});

app.post("/auth/logout", async (request, response) => {
  const { refreshToken } = request.body ?? {};
  const result = await auth.logout({ refreshToken });
  respond(response, result);
});

app.get("/me", async (request, response) => {
  const result = await auth.verify({
    accessToken: bearer(request),
    device: deviceOf(request),
  });

  if (!result.ok) {
    respond(response, result);
    return;
  }

  response.json({
    user: result.data.user,
    session: result.data.session,
    expiresAt: new Date(result.data.claims.exp * 1_000).toISOString(),
  });
});

app.get("/users", async (request, response) => {
  const verified = await auth.verify({
    accessToken: bearer(request),
    device: deviceOf(request),
  });

  if (!verified.ok) {
    respond(response, verified);
    return;
  }

  const limit = Math.min(Number(request.query.limit ?? 20), 100);
  const offset = Math.max(Number(request.query.offset ?? 0), 0);

  const result = await db.entity<User>("users").list({
    select: ["id", "email", "username", "roles", "createdAt"],
    sort: { createdAt: "desc" },
    page: { limit, offset },
  });

  respond(response, result);
});

app.patch("/users/me", async (request, response) => {
  const verified = await auth.verify({
    accessToken: bearer(request),
    device: deviceOf(request),
  });

  if (!verified.ok) {
    respond(response, verified);
    return;
  }

  const result = await db.entity<User>("users").update({
    where: { id: verified.data.user.id },
    data: request.body ?? {},
  });

  respond(response, result);
});

app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
  console.error(error);
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Unexpected error" } });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Express example listening on http://localhost:${port}`);
});
