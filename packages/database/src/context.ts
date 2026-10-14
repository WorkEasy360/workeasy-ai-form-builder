import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "./schema.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Row-security context for one transaction. `tenantId` scopes tenant-owned
 * rows; `userId` lets a user see and maintain its own identity row. Both come
 * from server-side authentication, never from request input.
 */
export interface DbContext {
  tenantId?: string;
  userId?: string;
}

export class InvalidDbContextError extends Error {
  override name = "InvalidDbContextError";
}

function assertContext(context: DbContext): void {
  if (context.tenantId === undefined && context.userId === undefined) {
    throw new InvalidDbContextError("A database context needs a tenantId or a userId.");
  }
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && (typeof value !== "string" || !UUID_PATTERN.test(value))) {
      throw new InvalidDbContextError(`Database context ${key} must be a UUID.`);
    }
  }
}

/**
 * Runs `fn` in a transaction whose row-security context is set with
 * transaction-local set_config, so it can never leak to the next user of a
 * pooled connection (docs/04 §4).
 */
export async function withContext<T>(
  db: Kysely<Database>,
  context: DbContext,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  assertContext(context);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${context.tenantId ?? ""}, true), set_config('app.user_id', ${context.userId ?? ""}, true)`.execute(
      trx,
    );
    return fn(trx);
  });
}

/** Tenant-scoped transaction: the common case for request and job handlers. */
export function withTenant<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return withContext(db, { tenantId }, fn);
}
