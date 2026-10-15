import { createHash, randomBytes } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { Db } from "../client.js";
import type { AccessMode, Database, FormState } from "../schema.js";

/**
 * The respondent-facing path to published forms (docs/04 §4), used with the
 * public database role. A slug or a session capability is resolved by a
 * narrow locator to its tenant; everything after that runs in a tenant
 * context and sees only the columns the public role was granted.
 */
type Trx = Transaction<Database>;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
/** 32 random bytes, base64url: 43 characters. */
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** How long a respondent session may be used (docs/02 §5). */
export const RESPONDENT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const hashCapability = (capability: string) => createHash("sha256").update(capability, "utf8").digest();

/** The tenant and form behind a public slug, if the form exists and has been published. */
export async function resolveSlug(db: Db, slug: string): Promise<{ tenantId: string; formId: string } | undefined> {
  if (!SLUG_PATTERN.test(slug)) return undefined;
  const { rows } = await sql<{ tenant_id: string; form_id: string }>`SELECT tenant_id, form_id FROM app.resolve_public_form(${slug})`.execute(db);
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, formId: row.form_id } : undefined;
}

/** Whether a user is an active member of the tenant, for organization-only forms. */
export async function isActiveMember(db: Db | Trx, tenantId: string, userId: string): Promise<boolean> {
  const { rows } = await sql<{ member: boolean }>`SELECT app.is_active_member(${tenantId}::uuid, ${userId}::uuid) AS member`.execute(db);
  return rows[0]?.member === true;
}

export interface PublicForm {
  slug: string;
  state: FormState;
  accessMode: AccessMode;
  version: { id: string; versionNumber: number; projection: Record<string, unknown> };
}

/** The form's state, who may respond, and its active version's public projection. */
export async function getPublicForm(trx: Trx, formId: string): Promise<PublicForm | undefined> {
  const row = await trx
    .selectFrom("forms as f")
    .innerJoin("form_versions as v", (join) => join.onRef("v.id", "=", "f.active_version_id").onRef("v.form_id", "=", "f.id"))
    .leftJoin("form_access_policies as p", "p.form_id", "f.id")
    .select(["f.slug", "f.state", "p.mode", "v.id as version_id", "v.version_number", "v.public_projection"])
    .where("f.id", "=", formId)
    .where("f.deleted_at", "is", null)
    .executeTakeFirst();
  return row
    ? {
        slug: row.slug,
        state: row.state,
        // No policy row means the default: anyone with the link.
        accessMode: row.mode ?? "public",
        version: { id: row.version_id, versionNumber: row.version_number, projection: row.public_projection },
      }
    : undefined;
}

export interface StartedSession {
  id: string;
  /** Given to the respondent once; only its hash is stored. */
  capability: string;
  expiresAt: Date;
}

/** Starts a session pinned to one version. The caller has already checked access. */
export async function startSession(
  trx: Trx,
  input: { tenantId: string; formId: string; formVersionId: string; actorId: string | null; now?: Date },
): Promise<StartedSession> {
  const capability = randomBytes(32).toString("base64url");
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + RESPONDENT_SESSION_TTL_MS);
  const row = await trx
    .insertInto("respondent_sessions")
    .values({
      tenant_id: input.tenantId,
      form_id: input.formId,
      form_version_id: input.formVersionId,
      token_hash: hashCapability(capability),
      actor_id: input.actorId,
      expires_at: expiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, capability, expiresAt };
}

export interface RespondentSession {
  id: string;
  tenantId: string;
  formId: string;
  formVersionId: string;
  actorId: string | null;
  expiresAt: Date;
}

/** The live, unexpired session behind a capability, or undefined. */
export async function resolveCapability(db: Db, capability: string): Promise<RespondentSession | undefined> {
  if (!CAPABILITY_PATTERN.test(capability)) return undefined;
  const { rows } = await sql<{
    session_id: string;
    tenant_id: string;
    form_id: string;
    form_version_id: string;
    actor_id: string | null;
    expires_at: Date;
  }>`SELECT session_id, tenant_id, form_id, form_version_id, actor_id, expires_at FROM app.resolve_respondent_session(${hashCapability(capability)})`.execute(db);
  const row = rows[0];
  return row
    ? { id: row.session_id, tenantId: row.tenant_id, formId: row.form_id, formVersionId: row.form_version_id, actorId: row.actor_id, expiresAt: row.expires_at }
    : undefined;
}

export type Acceptance = { accepting: true } | { accepting: false; reason: "not_found" | "closed" | "access_revoked" };

/**
 * Whether the form accepts a response from this session right now, read from
 * the authoritative rows (never from a cache). Run it in a transaction for the
 * session's tenant. Closing a form takes effect here immediately, even for
 * respondents whose page loaded before it closed (docs/02 §5); for an
 * organization-only form the respondent must still be an active member.
 *
 * A session keeps the version it started with for its whole lifetime, even
 * after a newer version is published or an older one is reactivated. The
 * intake transaction (RUN-02) must call this after locking the form row,
 * before storing anything.
 */
export async function checkSessionAcceptance(trx: Trx, session: RespondentSession): Promise<Acceptance> {
  const form = await trx
    .selectFrom("forms as f")
    .leftJoin("form_access_policies as p", "p.form_id", "f.id")
    .select(["f.state", "f.active_version_id", "p.mode"])
    .where("f.id", "=", session.formId)
    .where("f.deleted_at", "is", null)
    .executeTakeFirst();
  if (!form?.active_version_id || form.state === "draft" || form.state === "archived") return { accepting: false, reason: "not_found" };
  if (form.state !== "published") return { accepting: false, reason: "closed" };
  if (form.mode === "organization") {
    if (!session.actorId || !(await isActiveMember(trx, session.tenantId, session.actorId))) return { accepting: false, reason: "access_revoked" };
  }
  return { accepting: true };
}
