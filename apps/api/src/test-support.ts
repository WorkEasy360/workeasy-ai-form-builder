import type { IdentityProvider } from "@workeasy/auth";
import type { Db } from "@workeasy/database";
import { createLogger } from "@workeasy/observability";
import type { Express } from "express";
import { sql } from "kysely";
import { createApp, type AppSettings } from "./app.js";

/** Shared setup for API integration tests. Not part of the production bundle. */
export const TEST_CONSOLE_ORIGIN = "http://localhost:3000";
export const TEST_RESPONDENT_ORIGIN = "http://localhost:3001";

export const testSettings: AppSettings = {
  consoleOrigin: TEST_CONSOLE_ORIGIN,
  respondentOrigin: TEST_RESPONDENT_ORIGIN,
  sessionSecret: "integration-test-secret-integration-test-0000",
  sessionTtlMs: 60 * 60 * 1000,
  secureCookies: false,
};

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
): Express {
  return createApp({
    logger: createLogger({ service: "api-test", level: "silent" }),
    db,
    publicDb,
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
