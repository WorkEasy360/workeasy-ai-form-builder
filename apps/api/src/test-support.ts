import type { IdentityProvider } from "@workeasy/auth";
import type { Db } from "@workeasy/database";
import { createObjectStore, type ObjectStore } from "@workeasy/files";
import { createLogger } from "@workeasy/observability";
import type { Express } from "express";
import { sql } from "kysely";
import { createApp, type AppSettings } from "./app.js";

/** Shared setup for API integration tests. Not part of the production bundle. */
export const TEST_CONSOLE_ORIGIN = "http://localhost:3000";
export const TEST_RESPONDENT_ORIGIN = "http://localhost:3001";

/** The signing-secret key the test API and test worker share. */
export const TEST_INTEGRATION_KEY = Buffer.alloc(32, 9);

export const testSettings: AppSettings = {
  consoleOrigin: TEST_CONSOLE_ORIGIN,
  respondentOrigin: TEST_RESPONDENT_ORIGIN,
  sessionSecret: "integration-test-secret-integration-test-0000",
  sessionTtlMs: 60 * 60 * 1000,
  secureCookies: false,
  aiEnabled: true,
  integrationSecretKey: TEST_INTEGRATION_KEY,
  // Integration tests deliver to a local receiver; the strict policy has its own unit tests.
  webhookPolicy: { allowHttp: true, allowPrivateNetworks: true, allowedPorts: [] },
  // Tests submit as soon as a session opens; the spam protection test sets its own minimum.
  minFillMs: 0,
};

/**
 * The local S3-compatible storage from `pnpm infra:up`, configured like the
 * API from .env (loaded by the integration global setup).
 */
export function testObjectStore(): ObjectStore {
  const env = process.env;
  const endpoint = env.OBJECT_STORAGE_ENDPOINT ?? "http://127.0.0.1:9000";
  return createObjectStore({
    endpoint,
    publicEndpoint: env.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? endpoint,
    region: env.OBJECT_STORAGE_REGION ?? "us-east-1",
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY ?? "local-dev-access",
    secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY ?? "local-dev-secret-key",
    quarantineBucket: env.OBJECT_STORAGE_BUCKET_QUARANTINE ?? "workeasy-quarantine",
    cleanBucket: env.OBJECT_STORAGE_BUCKET_CLEAN ?? "workeasy-clean",
    exportsBucket: env.OBJECT_STORAGE_BUCKET_EXPORTS ?? "workeasy-exports",
  });
}

/** An identity provider for tests that must not reach sign-in. */
export const unusedIdentityProvider: IdentityProvider = {
  beginLogin: () => Promise.reject(new Error("identity provider not available in this test")),
  completeLogin: () => Promise.reject(new Error("identity provider not available in this test")),
};

/**
 * `publicDb` should be a connection as the public role whenever a test calls
 * /public/v1; it defaults to `db` only for tests that never do.
 */
export function buildTestApp(
  db: Db,
  identityProvider: IdentityProvider = unusedIdentityProvider,
  settings = testSettings,
  publicDb: Db = db,
  respondentIdentityProvider: IdentityProvider = identityProvider,
  objectStore: ObjectStore = testObjectStore(),
  logger = createLogger({ service: "api-test", level: "silent" }),
): Express {
  return createApp({
    logger,
    db,
    publicDb,
    objectStore,
    identityProvider,
    respondentIdentityProvider,
    settings,
    readinessChecks: { database: () => sql`SELECT 1`.execute(db) },
    isDraining: () => false,
  });
}

/** Extracts `name=value` for a cookie from Set-Cookie headers. */
export function cookieFrom(setCookie: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const [pair] = header.split(";");
    if (pair?.startsWith(`${name}=`)) return pair;
  }
  return undefined;
}
