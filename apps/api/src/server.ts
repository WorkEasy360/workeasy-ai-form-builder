import { createDb } from "@workeasy/database";
import { createLogger } from "@workeasy/observability";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createOidcIdentityProvider } from "./identity/oidc-provider.js";

const config = loadConfig();
const logger = createLogger({ service: "api", level: config.LOG_LEVEL });
const db = createDb({ connectionString: config.DATABASE_URL, applicationName: "workeasy-api" });
const consoleOrigin = new URL(config.CONSOLE_PUBLIC_URL).origin;

const app = createApp({
  logger,
  db,
  identityProvider: createOidcIdentityProvider({
    issuerUrl: config.OIDC_ISSUER_URL,
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
    redirectUri: new URL("/auth/callback", consoleOrigin).toString(),
    // Config validation already requires https outside development.
    allowInsecureRequests: config.NODE_ENV !== "production" && new URL(config.OIDC_ISSUER_URL).protocol === "http:",
  }),
  settings: {
    consoleOrigin,
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
  logger.info({ signal }, "api shutting down; draining connections");
  server.close((err) => {
    void db.destroy().finally(() => {
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
