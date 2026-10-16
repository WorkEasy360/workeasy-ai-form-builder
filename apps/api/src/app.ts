import express, { type ErrorRequestHandler, type Express } from "express";
import type { IdentityProvider } from "@workeasy/auth";
import type { Db } from "@workeasy/database";
import type { ObjectStore } from "@workeasy/files";
import type { Logger } from "@workeasy/observability";
import { healthRouter, type ReadinessCheck } from "./http/health.js";
import { sendProblem } from "./http/problem.js";
import { requestContext, requestLog } from "./http/request-context.js";
import { apiV1Router } from "./routes/api-v1.js";
import { publicV1Router } from "./routes/public-v1.js";
import { authRouter } from "./routes/auth.js";

/** JSON body cap for non-upload routes (docs/05 §1). */
const JSON_BODY_LIMIT = "1mb";

export interface AppSettings {
  /** Public console origin: OIDC redirect base and the only origin allowed to mutate with cookies. */
  consoleOrigin: string;
  /** Public respondent origin: share links, QR codes and embed snippets point here. */
  respondentOrigin: string;
  /** Key material for the encrypted login-transaction cookie. */
  sessionSecret: string;
  sessionTtlMs: number;
  secureCookies: boolean;
  /** Whether AI generation is offered (a worker with a provider runs it). Manual editing never depends on it. */
  aiEnabled: boolean;
}

export interface AppDependencies {
  logger: Logger;
  db: Db;
  /** Connection as the public role, for respondent routes only. */
  publicDb: Db;
  /** Upload storage: presigned uploads to quarantine, downloads from the clean bucket. */
  objectStore: ObjectStore;
  identityProvider: IdentityProvider;
  /** The same identity provider, redirecting back to the respondent origin. */
  respondentIdentityProvider: IdentityProvider;
  settings: AppSettings;
  /** Dependencies that must be reachable for /health/ready (e.g. the database). */
  readinessChecks: Record<string, ReadinessCheck>;
  /** True once shutdown has begun, so load balancers stop routing here. */
  isDraining: () => boolean;
}

/** Maps body-parser failures to stable problem codes. */
function clientErrorFor(err: unknown): { status: number; code: string; title: string } | undefined {
  const type = typeof err === "object" && err !== null && "type" in err ? String(err.type) : "";
  if (type === "entity.parse.failed") return { status: 400, code: "MALFORMED_JSON", title: "The request body is not valid JSON" };
  if (type === "entity.too.large") return { status: 413, code: "PAYLOAD_TOO_LARGE", title: "Request is too large" };
  if (type === "encoding.unsupported" || type === "charset.unsupported") {
    return { status: 415, code: "UNSUPPORTED_ENCODING", title: "Send the body as UTF-8 JSON" };
  }
  return undefined;
}

export function createApp(deps: AppDependencies): Express {
  const { logger } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext(logger));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use("/health", healthRouter(deps.readinessChecks, deps.isDraining));
  app.use("/auth", authRouter(deps));
  app.use("/api/v1", apiV1Router(deps));
  app.use("/public/v1", publicV1Router(deps));

  app.use((_req, res) => {
    sendProblem(res, 404, "NOT_FOUND", "Not found");
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const known = clientErrorFor(err);
    if (known) {
      sendProblem(res, known.status, known.code, known.title);
      return;
    }
    const status = typeof err === "object" && err !== null && "status" in err ? Number(err.status) : 500;
    if (status >= 400 && status < 500) {
      sendProblem(res, status, "BAD_REQUEST", "Bad request");
      return;
    }
    requestLog(res, logger).error({ err }, "unhandled request error");
    if (res.headersSent) return;
    sendProblem(res, 500, "INTERNAL", "Something went wrong");
  };
  app.use(onError);

  return app;
}
