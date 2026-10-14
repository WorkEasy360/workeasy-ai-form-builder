import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { APP_SCHEMA } from "./roles.js";

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Arbitrary constant so concurrent migrators serialize on one advisory lock. */
const MIGRATION_LOCK_KEY = "7031958245019372001";
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  /** Connection as the owner role. */
  connectionString: string;
  migrationsDir?: string;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => FILE_PATTERN.test(name)).toSorted();
  const migrations: MigrationFile[] = [];
  for (const name of names) {
    // Normalize line endings so a Windows checkout produces the same checksum.
    const sql = (await readFile(join(dir, name), "utf8")).replace(/\r\n/g, "\n");
    const version = name.slice(0, 4);
    if (migrations.some((m) => m.version === version)) {
      throw new Error(`Duplicate migration version ${version} (${name}).`);
    }
    migrations.push({ version, name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return migrations;
}

/**
 * Applies pending forward-only migrations, each in its own transaction.
 * Refuses to run when an applied migration was edited or removed: fix forward
 * with a new migration instead (docs/06 §9).
 */
export async function migrate({ connectionString, migrationsDir = DEFAULT_MIGRATIONS_DIR }: MigrateOptions): Promise<MigrateResult> {
  const migrations = await loadMigrations(migrationsDir);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.schema_migrations (
          version text PRIMARY KEY,
          name text NOT NULL,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
        `SELECT version, name, checksum FROM ${APP_SCHEMA}.schema_migrations ORDER BY version`,
      );

      for (const row of rows) {
        const file = migrations.find((m) => m.version === row.version);
        if (!file) throw new Error(`Applied migration ${row.name} is missing from ${migrationsDir}.`);
        if (file.checksum !== row.checksum) {
          throw new Error(`Applied migration ${row.name} has changed (checksum mismatch). Add a new migration instead.`);
        }
      }

      const appliedVersions = new Set(rows.map((r) => r.version));
      const applied: string[] = [];
      for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) continue;
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO ${APP_SCHEMA}.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
            [migration.version, migration.name, migration.checksum],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`Migration ${migration.name} failed: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          });
        }
        applied.push(migration.name);
      }
      return { applied, alreadyApplied: rows.map((r) => r.name) };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
