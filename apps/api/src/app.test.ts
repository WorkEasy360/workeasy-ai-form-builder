import { Writable } from "node:stream";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { IdentityProvider } from "@workeasy/auth";
import type { Db } from "@workeasy/database";
import { createLogger } from "@workeasy/observability";
import { createApp, type AppDependencies } from "./app.js";
import { ProblemSchema, ReadyResponseSchema } from "./contract/schemas.js";
import type { ReadinessCheck } from "./http/health.js";

// These tests never reach a real database or identity provider.
const unused = new Proxy(
  {},
  {
    get() {
      throw new Error("dependency must not be used by this test");
    },
  },
);

const settings = {
  consoleOrigin: "http://localhost:3000",
  respondentOrigin: "http://localhost:3001",
  sessionSecret: "unit-test-secret-unit-test-secret-0000",
  sessionTtlMs: 60_000,
  secureCookies: false,
};

function build(overrides: Partial<AppDependencies> = {}) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const app = createApp({
    logger: createLogger({ service: "api-test", level: "info", destination }),
    db: unused as Db,
    publicDb: unused as Db,
    identityProvider: unused as IdentityProvider,
    respondentIdentityProvider: unused as IdentityProvider,
    settings,
    readinessChecks: { database: () => Promise.resolve() },
    isDraining: () => false,
    ...overrides,
  });
  const logs = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { app, logs, raw: () => lines.join("") };
}

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  const body = ProblemSchema.parse(res.body);
  expect(body.code).toBe(code);
  expect(body.requestId).toBe(res.headers["x-request-id"]);
  return body;
}

describe("request IDs", () => {
  it("gives every response a unique X-Request-Id", async () => {
    const { app } = build();
    const first = await request(app).get("/health/live");
    const second = await request(app).get("/health/live");
    expect(first.headers["x-request-id"]).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
    expect(second.headers["x-request-id"]).not.toBe(first.headers["x-request-id"]);
  });

  it("never echoes a client-supplied request ID as its own", async () => {
    const { app, logs } = build();
    const res = await request(app).get("/health/live").set("X-Request-Id", "edge-1234567890");
    expect(res.headers["x-request-id"]).not.toBe("edge-1234567890");
    expect(logs().at(-1)).toMatchObject({ requestId: res.headers["x-request-id"], upstreamRequestId: "edge-1234567890" });
    const injected = await request(app).get("/health/live").set("X-Request-Id", "bad id\" injected");
    expect(injected.status).toBe(200);
    expect(logs().at(-1)?.upstreamRequestId).toBeUndefined();
  });
});

describe("error model", () => {
  it("returns problem+json with the request ID for unknown routes", async () => {
    expectProblem(await request(freshApp()).get("/does-not-exist"), 404, "NOT_FOUND");
  });

  it("distinguishes malformed JSON from oversized bodies", async () => {
    expectProblem(
      await request(freshApp()).put("/api/v1/me").set("content-type", "application/json").send('{"broken":'),
      400,
      "MALFORMED_JSON",
    );
    expectProblem(
      await request(freshApp())
        .post("/health/live")
        .set("content-type", "application/json")
        .send(JSON.stringify({ data: "x".repeat(1024 * 1024 + 1) })),
      413,
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("requires a session for API routes without touching the database", async () => {
    const res = await request(freshApp()).get("/api/v1/me");
    expectProblem(res, 401, "UNAUTHENTICATED");
    expect(res.headers["cache-control"]).toBe("no-store");
    expectProblem(await request(freshApp()).get("/api/v1/me").set("Cookie", "we_session=not-a-real-token"), 401, "UNAUTHENTICATED");
  });

  it("turns unexpected failures into a generic 500 and logs them with the request ID", async () => {
    const { app, logs, raw } = build();
    // A well-formed token reaches the database, which this test makes unavailable.
    const token = "A".repeat(43);
    const res = await request(app).get("/api/v1/me").set("Cookie", `we_session=${token}`);
    const body = expectProblem(res, 500, "INTERNAL");
    expect(body.title).toBe("Something went wrong");
    expect(JSON.stringify(res.body)).not.toContain("dependency must not be used");
    const errorLog = logs().find((l) => l.msg === "unhandled request error");
    expect(errorLog).toMatchObject({ requestId: res.headers["x-request-id"], err: { type: "Error" } });
    expect(raw()).not.toContain(token);
  });

  it("does not advertise the framework", async () => {
    expect((await request(freshApp()).get("/health/live")).headers["x-powered-by"]).toBeUndefined();
  });
});

describe("request logging", () => {
  it("logs one line per request with the route template, status and duration", async () => {
    const { app, logs } = build();
    const res = await request(app).get("/api/v1/organizations/9f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d/forms?q=private%20search");
    expect(res.status).toBe(401);
    const line = logs().find((l) => l.msg === "request completed");
    expect(line).toMatchObject({ method: "GET", status: 401, requestId: res.headers["x-request-id"] });
    expect(typeof line?.durationMs).toBe("number");
  });

  it("never logs query strings, cookies or authorization codes", async () => {
    const { app, raw } = build({
      identityProvider: {
        beginLogin: () => Promise.reject(new Error("unused")),
        completeLogin: () => Promise.reject(new Error("unused")),
      },
    });
    await request(app).get("/auth/callback?code=SECRET-AUTH-CODE&state=SECRET-STATE").set("Cookie", "we_login=SECRET-COOKIE");
    await request(app).get("/does-not-exist/SECRET-PATH-TOKEN?email=asha@example.com");
    const output = raw();
    for (const secret of ["SECRET-AUTH-CODE", "SECRET-STATE", "SECRET-COOKIE", "SECRET-PATH-TOKEN", "asha@example.com"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('"route":"/auth/callback"');
    expect(output).toContain('"route":"(unmatched)"');
  });
});

describe("health checks", () => {
  const ready = (checks: Record<string, ReadinessCheck>, isDraining = () => false) => build({ readinessChecks: checks, isDraining }).app;

  it("reports liveness without checking dependencies", async () => {
    const res = await request(ready({ database: () => Promise.reject(new Error("down")) })).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("is ready when every essential dependency responds", async () => {
    const res = await request(ready({ database: () => Promise.resolve() })).get("/health/ready");
    expect(res.status).toBe(200);
    expect(ReadyResponseSchema.parse(res.body)).toEqual({ status: "ready", checks: { database: "ok" } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("is not ready when a dependency fails, without exposing the error", async () => {
    const res = await request(ready({ database: () => Promise.reject(new Error("password authentication failed")) })).get(
      "/health/ready",
    );
    const body = expectProblem(res, 503, "NOT_READY");
    expect(body.checks).toEqual({ database: "unavailable" });
    expect(JSON.stringify(res.body)).not.toContain("password");
  });

  it("is not ready when a dependency hangs past the timeout", async () => {
    const res = await request(ready({ database: () => new Promise(() => undefined) })).get("/health/ready");
    expect(expectProblem(res, 503, "NOT_READY").checks).toEqual({ database: "timeout" });
  }, 10_000);

  it("is not ready while draining for shutdown", async () => {
    const res = await request(ready({ database: () => Promise.resolve() }, () => true)).get("/health/ready");
    expect(expectProblem(res, 503, "NOT_READY").checks).toEqual({ lifecycle: "draining" });
  });
});

function freshApp() {
  return build().app;
}
