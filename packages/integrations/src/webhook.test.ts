import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STRICT_POLICY, type DestinationPolicy } from "./ssrf.js";
import { sendWebhook } from "./webhook.js";

const LOCAL: DestinationPolicy = { allowHttp: true, allowPrivateNetworks: true, allowedPorts: [] };
const seen: Array<{ host: string | undefined; path: string | undefined; body: string }> = [];
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ host: req.headers.host, path: req.url, body });
      if (req.url === "/ok") res.writeHead(204).end();
      else if (req.url === "/busy") res.writeHead(429, { "retry-after": "120" }).end();
      else if (req.url === "/moved") res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      else if (req.url === "/big") res.writeHead(200).end("x".repeat(100_000));
      else if (req.url === "/slow") setTimeout(() => res.writeHead(200).end(), 2000);
      else res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const send = (path: string, over: Partial<Parameters<typeof sendWebhook>[0]> = {}) =>
  sendWebhook({ url: `http://hooks.example.test:${port}${path}`, body: Buffer.from('{"a":1}'), headers: { "content-type": "application/json" }, policy: LOCAL, resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]), ...over });

describe("sendWebhook", () => {
  it("connects to the checked address while keeping the URL's host name", async () => {
    expect(await send("/ok")).toMatchObject({ kind: "response", status: 204 });
    expect(seen.at(-1)).toEqual({ host: `hooks.example.test:${port}`, path: "/ok", body: '{"a":1}' });
  });

  it("reports Retry-After and does not follow redirects", async () => {
    expect(await send("/busy")).toMatchObject({ kind: "response", status: 429, retryAfterMs: 120_000 });
    const before = seen.length;
    expect(await send("/moved")).toMatchObject({ kind: "response", status: 302 });
    expect(seen).toHaveLength(before + 1);
  });

  it("stops reading large responses", async () => {
    expect(await send("/big")).toMatchObject({ kind: "response", status: 200 });
  });

  it("marks a timeout after the request was sent as possibly delivered", async () => {
    expect(await send("/slow", { timeoutMs: 300 })).toMatchObject({ kind: "error", code: "timeout", ambiguous: true });
  });

  it("refuses private destinations under the strict policy, whatever the host name, and before connecting", async () => {
    const before = seen.length;
    const blocked = await send("/ok", { policy: STRICT_POLICY });
    expect(blocked).toMatchObject({ kind: "error", code: "destination_blocked", ambiguous: false });
    expect(seen).toHaveLength(before);
  });

  it("reports refused connections as retryable network errors, not deliveries", async () => {
    expect(await send("/ok", { url: "http://hooks.example.test:1/ok" })).toMatchObject({ kind: "error", code: "connection_refused", ambiguous: false });
  });
});
