import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { bootstrapDatabase } from "../bootstrap.js";
import { migrate } from "../migrate.js";
import type { TestDatabaseUrls, TestOidcSettings } from "./provided.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and run \`pnpm infra:up\` first.`);
  return value;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Recreates a dedicated `<db>_test` database, provisions roles and applies all
 * migrations, then hands per-role URLs to integration tests via `inject`.
 */
export default async function setup(project: TestProject): Promise<void> {
  const envFile = resolve(import.meta.dirname, "../../../../.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const adminUrl = required("DATABASE_ADMIN_URL");
  const devDatabase = decodeURIComponent(new URL(required("DATABASE_MIGRATION_URL")).pathname.slice(1));
  const testDatabase = `${devDatabase}_test`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(testDatabase)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }

  const urls: TestDatabaseUrls = {
    admin: withDatabase(adminUrl, testDatabase),
    owner: withDatabase(required("DATABASE_MIGRATION_URL"), testDatabase),
    api: withDatabase(required("DATABASE_URL"), testDatabase),
    worker: withDatabase(required("DATABASE_WORKER_URL"), testDatabase),
    public: withDatabase(required("DATABASE_PUBLIC_URL"), testDatabase),
  };

  await bootstrapDatabase({
    adminUrl,
    database: testDatabase,
    roleUrls: { owner: urls.owner, api: urls.api, worker: urls.worker, public: urls.public },
  });
  await migrate({ connectionString: urls.owner });

  project.provide("testDatabase", urls);

  const { OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, CONSOLE_PUBLIC_URL } = process.env;
  const oidc: TestOidcSettings | null =
    OIDC_ISSUER_URL && OIDC_CLIENT_ID && OIDC_CLIENT_SECRET && CONSOLE_PUBLIC_URL
      ? {
          issuerUrl: OIDC_ISSUER_URL,
          clientId: OIDC_CLIENT_ID,
          clientSecret: OIDC_CLIENT_SECRET,
          consoleOrigin: new URL(CONSOLE_PUBLIC_URL).origin,
        }
      : null;
  project.provide("testOidc", oidc);
}
