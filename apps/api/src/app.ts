import express, { type ErrorRequestHandler, type Express } from "express";
import type { Logger } from "@workeasy/observability";

/** JSON body cap for non-upload routes (docs/05 §1). */
const JSON_BODY_LIMIT = "1mb";

export interface AppDependencies {
  logger: Logger;
}

export function createApp({ logger }: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Liveness only reports process health; dependency readiness arrives in FND-05.
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use((_req, res) => {
    res
      .status(404)
      .type("application/problem+json")
      .json({ type: "urn:workeasy:error:not_found", title: "Not found", status: 404, code: "NOT_FOUND" });
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status = typeof err === "object" && err !== null && "status" in err ? Number(err.status) : 500;
    if (status >= 500) logger.error({ err }, "unhandled request error");
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    res
      .status(safeStatus)
      .type("application/problem+json")
      .json(
        safeStatus === 413
          ? { type: "urn:workeasy:error:payload_too_large", title: "Request is too large", status: 413, code: "PAYLOAD_TOO_LARGE" }
          : safeStatus < 500
            ? { type: "urn:workeasy:error:bad_request", title: "Bad request", status: safeStatus, code: "BAD_REQUEST" }
            : { type: "urn:workeasy:error:internal", title: "Something went wrong", status: 500, code: "INTERNAL" },
      );
  };
  app.use(onError);

  return app;
}
