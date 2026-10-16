import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { DestinationBlockedError, resolveDestination, type DestinationPolicy, type Resolver } from "./ssrf.js";

export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Responses are read only this far; destinations need not send anything back. */
const MAX_RESPONSE_BYTES = 4096;
/** A Retry-After longer than this is shortened to it. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export type WebhookResult =
  | { kind: "response"; status: number; retryAfterMs?: number | undefined; durationMs: number }
  /** No response. `ambiguous` when the request was fully sent first: it may have arrived. */
  | { kind: "error"; code: string; ambiguous: boolean; durationMs: number };

export interface WebhookRequest {
  url: string;
  body: Buffer;
  headers: Record<string, string>;
  policy: DestinationPolicy;
  resolve?: Resolver;
  timeoutMs?: number;
}

function retryAfterMs(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * POSTs one webhook. The destination host is resolved and checked first,
 * and the connection is made to that checked address (TLS still verifies the
 * URL's host name). Redirects come back as responses and are not followed.
 */
export async function sendWebhook(request: WebhookRequest): Promise<WebhookResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const url = new URL(request.url);
  let pinned: { address: string; family: 4 | 6 };
  try {
    pinned = await resolveDestination(url.hostname, request.policy, request.resolve);
  } catch (err) {
    return { kind: "error", code: err instanceof DestinationBlockedError ? "destination_blocked" : "dns_failed", ambiguous: false, durationMs: elapsed() };
  }
  // Every connection attempt gets the checked address, whatever the DNS says now.
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
  const client = url.protocol === "https:" ? https : http;
  return new Promise<WebhookResult>((resolve) => {
    let sent = false;
    let settled = false;
    const done = (result: WebhookResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = client.request(
      url,
      {
        method: "POST",
        headers: { ...request.headers, "content-length": String(request.body.length) },
        lookup,
        agent: false,
      },
      (res) => {
        let read = 0;
        res.on("data", (chunk: Buffer) => {
          read += chunk.length;
          if (read > MAX_RESPONSE_BYTES) res.destroy();
        });
        const finish = () => done({ kind: "response", status: res.statusCode ?? 0, retryAfterMs: retryAfterMs(res.headers["retry-after"]), durationMs: elapsed() });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      },
    );
    const timer = setTimeout(() => {
      done({ kind: "error", code: "timeout", ambiguous: sent, durationMs: elapsed() });
      req.destroy();
    }, request.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
    req.on("finish", () => {
      sent = true;
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code === "ECONNREFUSED" ? "connection_refused" : err.code?.startsWith("ERR_TLS") || err.code?.includes("CERT") ? "tls_failed" : "network_error";
      done({ kind: "error", code, ambiguous: sent && code === "network_error", durationMs: elapsed() });
    });
    req.end(request.body);
  });
}
