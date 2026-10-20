import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createObjectStore } from "./storage.js";

/** OPS-03: on AWS the store talks to Amazon S3 with the instance role's credentials. */
const buckets = { quarantineBucket: "acme-quarantine", cleanBucket: "acme-files", exportsBucket: "acme-exports" };
const saved = { ...process.env };

describe("object store on Amazon S3", () => {
  beforeEach(() => {
    // Stands in for the instance role: the SDK's default chain reads these.
    process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLEROLE";
    process.env.AWS_SECRET_ACCESS_KEY = "role-secret";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("presigns uploads for S3's own address, with the default credential chain, when no endpoint or keys are set", async () => {
    const store = createObjectStore({ region: "eu-west-1", ...buckets });
    const url = new URL(await store.presignUpload("u/123", "text/plain", 10, 300));
    expect(url.origin).toBe("https://acme-quarantine.s3.eu-west-1.amazonaws.com");
    expect(url.pathname).toBe("/u/123");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^AKIAEXAMPLEROLE\//);
  });

  it("keeps path-style URLs and static keys for self-hosted storage", async () => {
    const store = createObjectStore({ region: "us-east-1", endpoint: "http://127.0.0.1:9000", publicEndpoint: "https://files.example.test", accessKeyId: "local", secretAccessKey: "secret", ...buckets });
    const url = new URL(await store.presignUpload("u/123", "text/plain", 10, 300));
    expect(`${url.origin}${url.pathname}`).toBe("https://files.example.test/acme-quarantine/u/123");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^local\//);
  });
});
