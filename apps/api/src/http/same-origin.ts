import type { RequestHandler } from "express";
import { sendProblem } from "./problem.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense for cookie-authenticated mutations (docs/06 §2): unsafe methods
 * must come from the console origin, shown by the Origin header (or Referer
 * when a browser omits Origin). SameSite=Lax cookies are the second layer.
 */
export function requireSameOrigin(allowedOrigin: string): RequestHandler {
  const expected = new URL(allowedOrigin).origin;
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get("origin");
    let actual: string | undefined;
    if (origin && origin !== "null") {
      actual = origin;
    } else {
      const referer = req.get("referer");
      if (referer) {
        try {
          actual = new URL(referer).origin;
        } catch {
          actual = undefined;
        }
      }
    }
    if (actual !== expected) {
      sendProblem(res, 403, "CROSS_ORIGIN_REQUEST", "This request must come from the Workeasy Forms console");
      return;
    }
    next();
  };
}
