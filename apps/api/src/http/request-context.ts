import { randomBytes } from "node:crypto";
import type { RequestHandler, Response } from "express";
import type { Logger } from "@workeasy/observability";

/** Incoming IDs from a trusted edge are recorded only if they are plainly safe to log. */
const UPSTREAM_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function newRequestId(): string {
  return `req_${randomBytes(12).toString("base64url")}`;
}

/**
 * Assigns every request an opaque ID (returned as X-Request-Id and in every
 * problem response), a child logger carrying it, and one completion log line.
 * The line records the route *template*, never the concrete path, query
 * string, headers or body, so tokens and answers cannot reach the logs.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const requestId = newRequestId();
    const upstream = req.get("x-request-id");
    const log = logger.child({
      requestId,
      ...(upstream && UPSTREAM_ID_PATTERN.test(upstream) ? { upstreamRequestId: upstream } : {}),
    });
    res.locals.requestId = requestId;
    res.locals.log = log;
    res.set("X-Request-Id", requestId);

    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : "(unmatched)";
      const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 10_000) / 100;
      const fields = { method: req.method, route, status: res.statusCode, durationMs };
      if (res.statusCode >= 500) log.error(fields, "request failed");
      else log.info(fields, "request completed");
    });
    next();
  };
}

export function requestIdOf(res: Response): string | undefined {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : undefined;
}

export function requestLog(res: Response, fallback: Logger): Logger {
  return (res.locals.log as Logger | undefined) ?? fallback;
}
