import request from "supertest";
import { describe, expect, it } from "vitest";
import type { IdentityProvider } from "@workeasy/auth";
import type { Db } from "@workeasy/database";
import { createLogger } from "@workeasy/observability";
import { createApp } from "./app.js";

// These routes never reach the database or the identity provider.
const unused = new Proxy({}, {
  get() {
    throw new Error("dependency must not be used by this test");
  },
});

const app = createApp({
  logger: createLogger({ service: "api-test", level: "silent" }),
  db: unused as Db,
  identityProvider: unused as IdentityProvider,
  settings: {
    consoleOrigin: "http://localhost:3000",
    sessionSecret: "unit-test-secret-unit-test-secret-0000",
    sessionTtlMs: 60_000,
    secureCookies: false,
  },
});

describe("api app", () => {
  it("reports liveness", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns problem+json for unknown routes", async () => {
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("rejects JSON bodies over the 1 MiB cap", async () => {
    const res = await request(app)
      .post("/health/live")
      .set("content-type", "application/json")
      .send(JSON.stringify({ data: "x".repeat(1024 * 1024 + 1) }));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("does not advertise the framework", async () => {
    const res = await request(app).get("/health/live");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("requires a session for API routes without touching the database", async () => {
    const res = await request(app).get("/api/v1/me");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects a malformed session cookie without a database lookup", async () => {
    const res = await request(app).get("/api/v1/me").set("Cookie", "we_session=not-a-real-token");
    expect(res.status).toBe(401);
  });
});
