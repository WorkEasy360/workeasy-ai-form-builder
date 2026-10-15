import { sql, type Transaction } from "kysely";
import type { Db } from "../client.js";
import type { Database, FormState } from "../schema.js";

/**
 * The respondent-facing path to published forms (docs/04 §4), used with the
 * public database role. A slug is resolved to its tenant and form by a narrow
 * locator; everything after that runs in a tenant context and sees only the
 * columns the public role was granted.
 */
type Trx = Transaction<Database>;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** The tenant and form behind a public slug, if the form exists and has been published. */
export async function resolveSlug(db: Db, slug: string): Promise<{ tenantId: string; formId: string } | undefined> {
  if (!SLUG_PATTERN.test(slug)) return undefined;
  const { rows } = await sql<{ tenant_id: string; form_id: string }>`SELECT tenant_id, form_id FROM app.resolve_public_form(${slug})`.execute(db);
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, formId: row.form_id } : undefined;
}

export interface PublicForm {
  slug: string;
  state: FormState;
  version: { id: string; versionNumber: number; projection: Record<string, unknown> };
}

/** The form's state and its active version's public projection. */
export async function getPublicForm(trx: Trx, formId: string): Promise<PublicForm | undefined> {
  const row = await trx
    .selectFrom("forms as f")
    .innerJoin("form_versions as v", (join) => join.onRef("v.id", "=", "f.active_version_id").onRef("v.form_id", "=", "f.id"))
    .select(["f.slug", "f.state", "v.id as version_id", "v.version_number", "v.public_projection"])
    .where("f.id", "=", formId)
    .where("f.deleted_at", "is", null)
    .executeTakeFirst();
  return row
    ? { slug: row.slug, state: row.state, version: { id: row.version_id, versionNumber: row.version_number, projection: row.public_projection } }
    : undefined;
}

export type Acceptance =
  | { accepting: true; versionId: string }
  | { accepting: false; reason: "not_found" | "closed" | "version_changed"; activeVersionId?: string };

/**
 * Whether the form accepts a response for `versionId` right now, read from
 * the authoritative row (never from a cache). Closing a form takes effect
 * here immediately, even for respondents whose page loaded before it closed
 * (docs/02 §5). The intake transaction (RUN-02) must call this inside its own
 * transaction, after locking the form row, before storing anything.
 *
 * Until respondent sessions exist (RUN-01), only the active version is
 * accepted; sessions will let a respondent finish the version they started.
 */
export async function checkAcceptance(trx: Trx, formId: string, versionId: string): Promise<Acceptance> {
  const form = await trx
    .selectFrom("forms")
    .select(["state", "active_version_id"])
    .where("id", "=", formId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!form?.active_version_id || form.state === "draft") return { accepting: false, reason: "not_found" };
  if (form.state !== "published") return { accepting: false, reason: "closed" };
  if (form.active_version_id !== versionId) return { accepting: false, reason: "version_changed", activeVersionId: form.active_version_id };
  return { accepting: true, versionId };
}
