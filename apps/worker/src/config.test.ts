import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  DATABASE_WORKER_URL: "postgres://worker@localhost/db",
  OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
  OBJECT_STORAGE_ACCESS_KEY: "a",
  OBJECT_STORAGE_SECRET_KEY: "s",
  OBJECT_STORAGE_BUCKET_QUARANTINE: "quarantine",
  OBJECT_STORAGE_BUCKET_CLEAN: "clean",
  OBJECT_STORAGE_BUCKET_EXPORTS: "exports",
  INTEGRATION_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("worker AI settings", () => {
  it("are off by default, and empty values from .env count as unset", () => {
    expect(loadConfig(base)).toMatchObject({ AI_PROVIDER: "disabled" });
    const config = loadConfig({ ...base, AI_PROVIDER: "stub", AI_MODEL: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "" });
    expect(config).toMatchObject({ AI_PROVIDER: "stub" });
    expect(config.AI_MODEL).toBeUndefined();
    expect(config.OPENAI_API_KEY).toBeUndefined();
  });

  it("refuse private webhook destinations in production", () => {
    expect(loadConfig({ ...base, WEBHOOK_ALLOW_PRIVATE_NETWORKS: "true" })).toMatchObject({ WEBHOOK_ALLOW_PRIVATE_NETWORKS: true });
    expect(() => loadConfig({ ...base, NODE_ENV: "production", WEBHOOK_ALLOW_PRIVATE_NETWORKS: "true" })).toThrow(/local development only/);
  });

  it("refuse the stub provider in production and unknown providers anywhere", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AI_PROVIDER: "stub" })).toThrow(/stub/);
    expect(() => loadConfig({ ...base, AI_PROVIDER: "someone-else" })).toThrow(/AI_PROVIDER/);
  });
});
