import { createServer, type Server } from "node:http";

export interface WorkerHealthOptions {
  /** Epoch milliseconds of the loop's latest iteration. */
  lastIterationAt: () => number;
  /** How old the latest iteration may be before the worker counts as stuck. */
  maxStalenessMs: number;
  now?: () => number;
}

/**
 * Minimal liveness endpoint for container orchestration: GET /health/live is
 * 200 while the polling loop keeps iterating and 503 when it is stuck. The
 * worker serves no other HTTP; everything else is 404.
 */
export function createHealthServer({ lastIterationAt, maxStalenessMs, now = Date.now }: WorkerHealthOptions): Server {
  return createServer((req, res) => {
    const headers = { "content-type": "application/json", "cache-control": "no-store" };
    if (req.method !== "GET" || req.url !== "/health/live") {
      res.writeHead(404, headers).end(JSON.stringify({ status: "not_found" }));
      return;
    }
    const ageMs = now() - lastIterationAt();
    const live = ageMs <= maxStalenessMs;
    res.writeHead(live ? 200 : 503, headers).end(JSON.stringify({ status: live ? "ok" : "stalled" }));
  });
}
