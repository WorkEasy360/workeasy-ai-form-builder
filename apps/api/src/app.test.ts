import request from "supertest";
import { describe, expect, it } from "vitest";
import { createLogger } from "@workeasy/observability";
import { createApp } from "./app.js";

const app = createApp({ logger: createLogger({ service: "api-test", level: "silent" }) });

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
});
