import { providerFromSettings } from "@workeasy/ai";
import { parseSecretKey, STRICT_POLICY } from "@workeasy/integrations";
import { createDb } from "@workeasy/database";
import { createObjectStore } from "@workeasy/files";
import { sql } from "kysely";
import { createLogger } from "@workeasy/observability";
import { readFileSync } from "node:fs";
import type { IdentityProvider } from "@workeasy/auth";
import { createApp } from "./app.js";
import { isLoopbackHttp, loadConfig, WORKEASY360_CALLBACK_PATH } from "./config.js";
import { createOidcIdentityProvider } from "./identity/oidc-provider.js";
import { createWorkeasy360Runtime, type Workeasy360Runtime } from "./workeasy360/runtime.js";

const config = loadConfig();
const logger = createLogger({ service: "api", level: config.LOG_LEVEL });
const db = createDb({ connectionString: config.DATABASE_URL, applicationName: "workeasy-api" });
const publicDb = createDb({ connectionString: config.DATABASE_PUBLIC_URL, applicationName: "workeasy-api-public" });
const consoleOrigin = new URL(config.CONSOLE_PUBLIC_URL).origin;
let draining = false;

// The worker runs AI drafting; the API runs the assistant, which answers while the member waits.
const assistant = providerFromSettings(config);

/** The generic OpenID Connect provider (OIDC_*), or one that reports itself unavailable when it is not configured. */
function genericProvider(redirectUri: string): IdentityProvider {
  const { OIDC_ISSUER_URL: issuerUrl, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret } = config;
  if (!issuerUrl || !clientId || !clientSecret) {
    return {
      isAvailable: () => Promise.resolve(false),
      beginLogin: () => Promise.reject(new Error("single sign-on is not configured")),
      completeLogin: () => Promise.reject(new Error("single sign-on is not configured")),
    };
  }
  return createOidcIdentityProvider({
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    // Config validation already requires https outside development.
    allowInsecureRequests: config.NODE_ENV !== "production" && new URL(issuerUrl).protocol === "http:",
  });
}

/** WorkEasy360 Accounts sign-in (docs/workeasy360-sso.md), when WORKEASY360_* is set. */
function workeasy360Runtime(): Workeasy360Runtime | undefined {
  const { WORKEASY360_ISSUER: issuer, WORKEASY360_CLIENT_ID: clientId, WORKEASY360_KEY_ID: keyId, WORKEASY360_PRIVATE_KEY_FILE: keyFile } = config;
  if (!issuer || !clientId || !keyId || !keyFile) return undefined;
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(keyFile, "utf8");
  } catch {
    throw new Error("WORKEASY360_PRIVATE_KEY_FILE cannot be read");
  }
  const runtime = createWorkeasy360Runtime(
    db,
    {
      issuer,
      clientId,
      productCode: config.WORKEASY360_PRODUCT_CODE,
      redirectUri: config.WORKEASY360_REDIRECT_URI ?? new URL(WORKEASY360_CALLBACK_PATH, consoleOrigin).toString(),
      keyId,
      privateKeyPem,
      scopes: config.WORKEASY360_SCOPES.split(" ").filter(Boolean),
      // Config validation allows plain http only for a loopback issuer outside production.
      allowInsecureRequests: config.NODE_ENV !== "production" && isLoopbackHttp(issuer),
    },
    {
      postLogoutRedirectUri: config.WORKEASY360_POST_LOGOUT_REDIRECT_URI ?? new URL("/", consoleOrigin).toString(),
      ssoOnly: config.WORKEASY360_SSO_ONLY,
      defaultRole: config.WORKEASY360_DEFAULT_ROLE,
      provisionTenants: config.WORKEASY360_PROVISION_TENANTS,
      purchaseUrl: config.WORKEASY360_PURCHASE_URL ?? issuer,
    },
    { logger },
  );
  logger.info({ issuer, productCode: config.WORKEASY360_PRODUCT_CODE, ssoOnly: config.WORKEASY360_SSO_ONLY }, "WorkEasy360 sign-in enabled");
  return runtime;
}

const app = createApp({
  assistant,
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
    publicEndpoint: config.OBJECT_STORAGE_PUBLIC_ENDPOINT,
    region: config.OBJECT_STORAGE_REGION,
    accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY,
    secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY,
    quarantineBucket: config.OBJECT_STORAGE_BUCKET_QUARANTINE,
    cleanBucket: config.OBJECT_STORAGE_BUCKET_CLEAN,
    exportsBucket: config.OBJECT_STORAGE_BUCKET_EXPORTS,
  }),
  identityProvider: genericProvider(new URL("/auth/callback", consoleOrigin).toString()),
  respondentIdentityProvider: genericProvider(new URL("/public/v1/auth/callback", config.RESPONDENT_PUBLIC_URL).toString()),
  workeasy360: workeasy360Runtime(),
  settings: {
    consoleOrigin,
    respondentOrigin: new URL(config.RESPONDENT_PUBLIC_URL).origin,
    sessionSecret: config.SESSION_SECRET,
    sessionTtlMs: config.SESSION_TTL_HOURS * 60 * 60 * 1000,
    secureCookies: config.SESSION_COOKIE_SECURE,
    aiEnabled: config.AI_PROVIDER !== "disabled",
    assistantDailyLimit: config.ASSISTANT_DAILY_LIMIT,
    homeRegion: config.OBJECT_STORAGE_REGION,
    integrationSecretKey: parseSecretKey(config.INTEGRATION_SECRET_KEY),
    webhookPolicy: config.WEBHOOK_ALLOW_PRIVATE_NETWORKS ? { allowHttp: true, allowPrivateNetworks: true, allowedPorts: [] } : STRICT_POLICY,
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
