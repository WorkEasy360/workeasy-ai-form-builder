import express, { type ErrorRequestHandler, type Express } from "express";
import type { IdentityProvider } from "@workeasy/auth";
import type { Db } from "@workeasy/database";
import type { Logger } from "@workeasy/observability";
import { sendProblem } from "./http/problem.js";
import { apiV1Router } from "./routes/api-v1.js";
import { authRouter } from "./routes/auth.js";

/** JSON body cap for non-upload routes (docs/05 §1). */
const JSON_BODY_LIMIT = "1mb";

export interface AppSettings {
  /** Public console origin: OIDC redirect base and the only origin allowed to mutate with cookies. */
  consoleOrigin: string;
  /** Key material for the encrypted login-transaction cookie. */
  sessionSecret: string;
  sessionTtlMs: number;
  secureCookies: boolean;
}

export interface AppDependencies {
  logger: Logger;
  db: Db;
  identityProvider: IdentityProvider;
  settings: AppSettings;
}

export function createApp(deps: AppDependencies): Express {
  const { logger } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Liveness only reports process health; dependency readiness arrives in FND-05.
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/auth", authRouter(deps));
  app.use("/api/v1", apiV1Router(deps));

  app.use((_req, res) => {
    sendProblem(res, 404, "NOT_FOUND", "Not found");
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status = typeof err === "object" && err !== null && "status" in err ? Number(err.status) : 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    if (safeStatus >= 500) logger.error({ err }, "unhandled request error");
    if (safeStatus === 413) sendProblem(res, 413, "PAYLOAD_TOO_LARGE", "Request is too large");
    else if (safeStatus < 500) sendProblem(res, safeStatus, "BAD_REQUEST", "Bad request");
    else sendProblem(res, 500, "INTERNAL", "Something went wrong");
  };
  app.use(onError);

  return app;
}
