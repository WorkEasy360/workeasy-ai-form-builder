import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;

export interface CreateDbOptions {
  /** Connection URL for one runtime role (api, worker or public). */
  connectionString: string;
  maxConnections?: number;
  applicationName?: string;
}

export function createDb({ connectionString, maxConnections = 10, applicationName }: CreateDbOptions): Db {
  const pool = new Pool({
    connectionString,
    max: maxConnections,
    ...(applicationName ? { application_name: applicationName } : {}),
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
