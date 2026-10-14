import { Router } from "express";
import { sendProblem } from "./problem.js";

/** A readiness check resolves when the dependency can serve requests. */
export type ReadinessCheck = () => Promise<unknown>;

export const READINESS_TIMEOUT_MS = 2000;

function withTimeout(check: ReadinessCheck, timeoutMs: number): Promise<"ok" | "timeout" | "unavailable"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    check().then(
      () => {
        clearTimeout(timer);
        resolve("ok");
      },
      () => {
        clearTimeout(timer);
        resolve("unavailable");
      },
    );
  });
}

/**
 * Liveness reports only that the process serves HTTP. Readiness checks the
 * dependencies essential to serving requests (docs/06 §6): not AI, email or
 * the identity provider, whose outages must not take the API out of rotation.
 * While draining for shutdown the API reports not ready.
 */
export function healthRouter(checks: Record<string, ReadinessCheck>, isDraining: () => boolean, timeoutMs = READINESS_TIMEOUT_MS): Router {
  const router = Router();

  router.get("/live", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ status: "ok" });
  });

  router.get("/ready", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (isDraining()) {
      sendProblem(res, 503, "NOT_READY", "Shutting down", { checks: { lifecycle: "draining" } });
      return;
    }
    const entries = Object.entries(checks);
    const results = await Promise.all(entries.map(async ([name, check]) => [name, await withTimeout(check, timeoutMs)] as const));
    const status = Object.fromEntries(results);
    if (results.every(([, result]) => result === "ok")) res.json({ status: "ready", checks: status });
    else sendProblem(res, 503, "NOT_READY", "A required dependency is unavailable", { checks: status });
  });

  return router;
}
