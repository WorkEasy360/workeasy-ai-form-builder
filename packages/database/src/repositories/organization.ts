import { sql, type Transaction } from "kysely";
import type { Database, FormState, MembershipRole, MembershipStatus } from "../schema.js";

/**
 * Tenant-scoped queries. Every function takes a transaction opened with
 * withTenant/withContext, so row security already limits it to one tenant.
 */
type Trx = Transaction<Database>;

export interface MembershipRecord {
  role: MembershipRole;
  status: MembershipStatus;
}

export async function getMembership(trx: Trx, userId: string): Promise<MembershipRecord | undefined> {
  return trx.selectFrom("memberships").select(["role", "status"]).where("user_id", "=", userId).executeTakeFirst();
}

export interface FormSummary {
  id: string;
  slug: string;
  name: string;
  state: FormState;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FormListCursor {
  updatedAt: string;
  id: string;
}

export interface ListFormsOptions {
  /** Restrict to forms the user holds at least one grant on; false for roles that read every form. */
  onlyGrantedTo?: string;
  limit: number;
  cursor?: FormListCursor;
  state?: FormState;
  search?: string;
}

export interface FormPage {
  items: FormSummary[];
  nextCursor?: FormListCursor;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Keyset-paginated form list ordered by (updated_at, id) descending. */
export async function listForms(trx: Trx, options: ListFormsOptions): Promise<FormPage> {
  let query = trx
    .selectFrom("forms as f")
    .select([
      "f.id",
      "f.slug",
      "f.name",
      "f.state",
      "f.owner_id",
      "f.created_at",
      "f.updated_at",
      // Full-precision text keeps the cursor exact (JS Dates only hold milliseconds).
      sql<string>`f.updated_at::text`.as("cursor_updated_at"),
    ])
    .where("f.deleted_at", "is", null);

  const granteeId = options.onlyGrantedTo;
  if (granteeId) {
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom("form_grants as g")
          .select(sql`1`.as("one"))
          .whereRef("g.form_id", "=", "f.id")
          .where("g.principal_type", "=", "user")
          .where("g.principal_id", "=", granteeId),
      ),
    );
  }
  if (options.state) query = query.where("f.state", "=", options.state);
  if (options.search) query = query.where(sql<boolean>`f.name ILIKE ${`%${escapeLike(options.search)}%`} ESCAPE '\\'`);
  if (options.cursor) {
    const { updatedAt, id } = options.cursor;
    query = query.where(sql<boolean>`(f.updated_at, f.id) < (${updatedAt}::timestamptz, ${id}::uuid)`);
  }

  const rows = await query
    .orderBy("f.updated_at", "desc")
    .orderBy("f.id", "desc")
    .limit(options.limit + 1)
    .execute();

  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      state: r.state,
      ownerId: r.owner_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    ...(rows.length > options.limit && last ? { nextCursor: { updatedAt: last.cursor_updated_at, id: last.id } } : {}),
  };
}

export async function formExists(trx: Trx, formId: string): Promise<boolean> {
  const row = await trx.selectFrom("forms").select("id").where("id", "=", formId).where("deleted_at", "is", null).executeTakeFirst();
  return !!row;
}

export async function listUserFormGrants(trx: Trx, formId: string, userId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("form_grants")
    .select("permission")
    .where("form_id", "=", formId)
    .where("principal_type", "=", "user")
    .where("principal_id", "=", userId)
    .execute();
  return rows.map((r) => r.permission);
}

export interface FormGrant {
  principalType: "user";
  principalId: string;
  permission: string;
}

export async function listFormGrants(trx: Trx, formId: string): Promise<FormGrant[]> {
  const rows = await trx
    .selectFrom("form_grants")
    .select(["principal_type", "principal_id", "permission"])
    .where("form_id", "=", formId)
    .orderBy("principal_id")
    .orderBy("permission")
    .execute();
  return rows.map((r) => ({ principalType: r.principal_type, principalId: r.principal_id, permission: r.permission }));
}

/** IDs among `userIds` that are active members of the current tenant. */
export async function activeMemberIds(trx: Trx, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await trx
    .selectFrom("memberships")
    .select("user_id")
    .where("user_id", "in", [...userIds])
    .where("status", "=", "active")
    .execute();
  return new Set(rows.map((r) => r.user_id));
}

/** Replaces the full grant set of a form. Callers validate principals and permissions first. */
export async function replaceFormGrants(trx: Trx, formId: string, tenantId: string, grants: readonly FormGrant[], grantedBy: string): Promise<void> {
  await trx.deleteFrom("form_grants").where("form_id", "=", formId).execute();
  if (grants.length === 0) return;
  await trx
    .insertInto("form_grants")
    .values(
      grants.map((g) => ({
        tenant_id: tenantId,
        form_id: formId,
        principal_type: g.principalType,
        principal_id: g.principalId,
        permission: g.permission,
        created_by: grantedBy,
      })),
    )
    .execute();
}
