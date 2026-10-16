import { createDb } from "@workeasy/database";
import { createObjectStore } from "@workeasy/files";
import { sql } from "kysely";
import { createLogger } from "@workeasy/observability";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createOidcIdentityProvider } from "./identity/oidc-provider.js";

const config = loadConfig();
const logger = createLogger({ service: "api", level: config.LOG_LEVEL });
const db = createDb({ connectionString: config.DATABASE_URL, applicationName: "workeasy-api" });
const publicDb = createDb({ connectionString: config.DATABASE_PUBLIC_URL, applicationName: "workeasy-api-public" });
const consoleOrigin = new URL(config.CONSOLE_PUBLIC_URL).origin;
let draining = false;

const app = createApp({
  readinessChecks: {
    database: () => sql`SELECT 1`.execute(db),
    publicDatabase: () => sql`SELECT 1`.execute(publicDb),
  },
  isDraining: () => draining,
  logger,
  db,
  publicDb,
  objectStore: createObjectStore({
    endpoint: config.OBJECT_STORAGE_ENDPOINT,
    publicEndpoint: config.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? config.OBJECT_STORAGE_ENDPOINT,
    region: config.OBJECT_STORAGE_REGION,
    accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY,
    secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY,
    quarantineBucket: config.OBJECT_STORAGE_BUCKET_QUARANTINE,
    cleanBucket: config.OBJECT_STORAGE_BUCKET_CLEAN,
  }),
  identityProvider: createOidcIdentityProvider({
    issuerUrl: config.OIDC_ISSUER_URL,
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
    redirectUri: new URL("/auth/callback", consoleOrigin).toString(),
    // Config validation already requires https outside development.
    allowInsecureRequests: config.NODE_ENV !== "production" && new URL(config.OIDC_ISSUER_URL).protocol === "http:",
  }),
  respondentIdentityProvider: createOidcIdentityProvider({
    issuerUrl: config.OIDC_ISSUER_URL,
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
    redirectUri: new URL("/public/v1/auth/callback", config.RESPONDENT_PUBLIC_URL).toString(),
    allowInsecureRequests: config.NODE_ENV !== "production" && new URL(config.OIDC_ISSUER_URL).protocol === "http:",
  }),
  settings: {
    consoleOrigin,
    respondentOrigin: new URL(config.RESPONDENT_PUBLIC_URL).origin,
    sessionSecret: config.SESSION_SECRET,
    sessionTtlMs: config.SESSION_TTL_HOURS * 60 * 60 * 1000,
    secureCookies: config.SESSION_COOKIE_SECURE,
  },
});

const server = app.listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, "api listening");
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // Readiness fails from now on; in-flight requests finish before exit.
  draining = true;
  logger.info({ signal }, "api shutting down; draining connections");
  server.close((err) => {
    void Promise.all([db.destroy(), publicDb.destroy()]).finally(() => {
      if (err) {
        logger.error({ err }, "api shutdown failed");
        process.exit(1);
      }
      process.exit(0);
    });
  });
  // Close idle keep-alive sockets so draining does not wait on them.
  server.closeIdleConnections();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
