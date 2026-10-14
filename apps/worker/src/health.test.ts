import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthServer } from "./health.js";

const servers: Array<{ close(): void }> = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start(lastIterationAt: number, now: number) {
  const server = createHealthServer({ lastIterationAt: () => lastIterationAt, maxStalenessMs: 15_000, now: () => now });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("worker health endpoint", () => {
  it("is live while the loop keeps iterating", async () => {
    const base = await start(1_000_000, 1_010_000);
    const res = await fetch(`${base}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("reports a stalled loop", async () => {
    const base = await start(1_000_000, 1_020_000);
    const res = await fetch(`${base}/health/live`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "stalled" });
  });

  it("serves nothing else", async () => {
    const base = await start(1_000_000, 1_000_000);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/health/live`, { method: "POST" })).status).toBe(404);
  });
});
