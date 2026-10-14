import pg from "pg";
import { APP_SCHEMA, DB_ROLES, type DbRoleKey } from "./roles.js";

export interface BootstrapOptions {
  /** Superuser (or CREATEROLE + CREATEDB) connection used only for provisioning. */
  adminUrl: string;
  /** Database to create if missing and prepare for migrations. */
  database: string;
  /** Connection URL per role; user names must match DB_ROLES and carry the password to set. */
  roleUrls: Record<DbRoleKey, string>;
}

function credentialsFor(key: DbRoleKey, url: string): { name: string; password: string } {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (name !== DB_ROLES[key]) {
    throw new Error(`The ${key} connection URL must use role "${DB_ROLES[key]}", not "${name}".`);
  }
  if (!password) throw new Error(`The ${key} connection URL has no password.`);
  return { name, password };
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * Idempotently provisions roles, the database and the application schema.
 * Intended for local development and tests; deployed environments provision
 * the same roles through infrastructure tooling and a secret manager.
 */
export async function bootstrapDatabase({ adminUrl, database, roleUrls }: BootstrapOptions): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const key of Object.keys(DB_ROLES) as DbRoleKey[]) {
      const { name, password } = credentialsFor(key, roleUrls[key]);
      const role = admin.escapeIdentifier(name);
      const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
      if (exists.rowCount === 0) await admin.query(`CREATE ROLE ${role} LOGIN`);
      await admin.query(
        `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${admin.escapeLiteral(password)}`,
      );
    }

    const db = admin.escapeIdentifier(database);
    const dbExists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (dbExists.rowCount === 0) await admin.query(`CREATE DATABASE ${db}`);
    await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    for (const name of Object.values(DB_ROLES)) {
      const role = admin.escapeIdentifier(name);
      await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
      await admin.query(`ALTER ROLE ${role} IN DATABASE ${db} SET search_path = ${APP_SCHEMA}`);
    }
  } finally {
    await admin.end();
  }

  const target = new pg.Client({ connectionString: withDatabase(adminUrl, database) });
  await target.connect();
  try {
    const owner = target.escapeIdentifier(DB_ROLES.owner);
    await target.query(`CREATE SCHEMA IF NOT EXISTS ${APP_SCHEMA} AUTHORIZATION ${owner}`);
    await target.query(`ALTER SCHEMA ${APP_SCHEMA} OWNER TO ${owner}`);
    // Nothing lives in public; make sure no role can create objects there.
    await target.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  } finally {
    await target.end();
  }
}
