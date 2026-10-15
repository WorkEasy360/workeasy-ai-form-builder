import { randomInt } from "node:crypto";
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

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Public form locator: "f-" plus 12 random base-36 characters (~62 bits).
 * A slug only locates a form; it never grants access (docs/01 §3).
 */
export function newFormSlug(): string {
  let slug = "f-";
  for (let i = 0; i < 12; i++) slug += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  return slug;
}

/** True for a unique violation on the global slug constraint, which callers retry with a new slug. */
export function isSlugCollision(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505" && (err as { constraint?: string }).constraint === "forms_slug_key";
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
  // Archived forms are listed only when asked for explicitly.
  query = options.state ? query.where("f.state", "=", options.state) : query.where("f.state", "!=", "archived");
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
    items: page.map(toSummary),
    ...(rows.length > options.limit && last ? { nextCursor: { updatedAt: last.cursor_updated_at, id: last.id } } : {}),
  };
}

const SUMMARY_COLUMNS = ["id", "slug", "name", "state", "owner_id", "created_at", "updated_at"] as const;

function toSummary(row: {
  id: string;
  slug: string;
  name: string;
  state: FormState;
  owner_id: string;
  created_at: Date;
  updated_at: Date;
}): FormSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    state: row.state,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A form that is not deleted, or undefined. */
export async function getFormSummary(trx: Trx, formId: string): Promise<FormSummary | undefined> {
  const row = await trx
    .selectFrom("forms")
    .select(SUMMARY_COLUMNS)
    .where("id", "=", formId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row ? toSummary(row) : undefined;
}

export interface FormDraft {
  revision: number;
  definition: Record<string, unknown>;
  updatedAt: Date;
  updatedBy: { id: string; displayName: string | null };
}

export async function getDraft(trx: Trx, formId: string): Promise<FormDraft | undefined> {
  const row = await trx
    .selectFrom("form_drafts as d")
    // Users are visible to their own tenants' contexts, so the last editor's name resolves here.
    .leftJoin("users as u", "u.id", "d.updated_by")
    .select(["d.revision", "d.definition", "d.updated_at", "d.updated_by", "u.display_name"])
    .where("d.form_id", "=", formId)
    .executeTakeFirst();
  return row
    ? {
        revision: row.revision,
        definition: row.definition,
        updatedAt: row.updated_at,
        updatedBy: { id: row.updated_by, displayName: row.display_name ?? null },
      }
    : undefined;
}

/**
 * Replaces the draft only if it is still at `expectedRevision` (optimistic
 * concurrency, docs/03 §2), incrementing the revision and the form's
 * last-changed time. Returns the new revision, or undefined on a conflict.
 */
export async function saveDraft(
  trx: Trx,
  formId: string,
  expectedRevision: number,
  definition: Record<string, unknown>,
  updatedBy: string,
): Promise<number | undefined> {
  const row = await trx
    .updateTable("form_drafts")
    .set((eb) => ({ definition, updated_by: updatedBy, revision: eb("revision", "+", 1) }))
    .where("form_id", "=", formId)
    .where("revision", "=", expectedRevision)
    .returning("revision")
    .executeTakeFirst();
  if (!row) return undefined;
  // The forms_set_updated_at trigger stamps updated_at on any update.
  await trx.updateTable("forms").set((eb) => ({ name: eb.ref("name") })).where("id", "=", formId).execute();
  return row.revision;
}

export interface CreateFormInput {
  tenantId: string;
  ownerId: string;
  name: string;
  slug: string;
  definition: Record<string, unknown>;
  /** Permissions granted to the owner on the new form. */
  ownerGrants: readonly string[];
}

/** Inserts a form, its draft (revision 1) and the owner's grants. Run inside one transaction. */
export async function createForm(trx: Trx, input: CreateFormInput): Promise<{ form: FormSummary; draftRevision: number }> {
  const form = await trx
    .insertInto("forms")
    .values({ tenant_id: input.tenantId, slug: input.slug, name: input.name, owner_id: input.ownerId })
    .returning(SUMMARY_COLUMNS)
    .executeTakeFirstOrThrow();
  const draft = await trx
    .insertInto("form_drafts")
    .values({ tenant_id: input.tenantId, form_id: form.id, definition: input.definition, updated_by: input.ownerId })
    .returning("revision")
    .executeTakeFirstOrThrow();
  if (input.ownerGrants.length > 0) {
    await trx
      .insertInto("form_grants")
      .values(
        input.ownerGrants.map((permission) => ({
          tenant_id: input.tenantId,
          form_id: form.id,
          principal_type: "user" as const,
          principal_id: input.ownerId,
          permission,
          created_by: input.ownerId,
        })),
      )
      .execute();
  }
  return { form: toSummary(form), draftRevision: draft.revision };
}

/**
 * Moves a form to `to` only if it is currently in one of `from` (compare and
 * set under the row lock). Returns undefined when the state did not match.
 */
export async function transitionFormState(
  trx: Trx,
  formId: string,
  from: readonly FormState[],
  to: FormState,
): Promise<FormSummary | undefined> {
  const row = await trx
    .updateTable("forms")
    .set({ state: to })
    .where("id", "=", formId)
    .where("deleted_at", "is", null)
    .where("state", "in", [...from])
    .returning(SUMMARY_COLUMNS)
    .executeTakeFirst();
  return row ? toSummary(row) : undefined;
}

/** The user's explicit grants on each of the given forms. */
export async function userGrantsForForms(trx: Trx, formIds: readonly string[], userId: string): Promise<Map<string, string[]>> {
  const grants = new Map<string, string[]>();
  if (formIds.length === 0) return grants;
  const rows = await trx
    .selectFrom("form_grants")
    .select(["form_id", "permission"])
    .where("form_id", "in", [...formIds])
    .where("principal_type", "=", "user")
    .where("principal_id", "=", userId)
    .execute();
  for (const row of rows) grants.set(row.form_id, [...(grants.get(row.form_id) ?? []), row.permission]);
  return grants;
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
