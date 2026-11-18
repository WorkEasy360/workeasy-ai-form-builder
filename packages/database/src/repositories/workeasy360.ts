import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../client.js";
import { withContext } from "../context.js";
import type { MembershipRole } from "../schema.js";
import { findOrCreateUser, PASSWORD_ISSUER } from "./identity.js";
import { appendAudit } from "./publishing.js";

/**
 * WorkEasy360 Accounts sign-in: sign-in flows, the organization-to-tenant
 * mapping, back-channel logout and the shared entitlement answers
 * (docs/workeasy360-sso.md). Platform-level rows are reached only through the
 * SECURITY DEFINER functions of migration 0029.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest();

// --- sign-in flows -------------------------------------------------------------

export interface LoginFlow {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** The WorkEasy360 organization the launcher named, if any. */
  organizationId: string | null;
  returnTo: string | null;
}

/** Keeps a flow on the server under the SHA-256 of the browser's random flow id. */
export async function saveLoginFlow(db: Db, flowId: string, flow: LoginFlow, ttlSeconds: number): Promise<void> {
  await sql`SELECT app.workeasy360_save_login_flow(
      ${sha256(flowId)}, ${flow.state}, ${flow.nonce}, ${flow.codeVerifier},
      ${flow.organizationId}::uuid, ${flow.returnTo}, ${ttlSeconds}::integer)`.execute(db);
}

/** Takes (deletes) the flow: it is used once, whatever the callback does next. Undefined when unknown or expired. */
export async function takeLoginFlow(db: Db, flowId: string): Promise<LoginFlow | undefined> {
  const { rows } = await sql<{ state: string; nonce: string; code_verifier: string; organization_id: string | null; return_to: string | null }>`
    SELECT state, nonce, code_verifier, organization_id, return_to FROM app.workeasy360_take_login_flow(${sha256(flowId)})`.execute(db);
  const row = rows[0];
  return row
    ? { state: row.state, nonce: row.nonce, codeVerifier: row.code_verifier, organizationId: row.organization_id, returnTo: row.return_to }
    : undefined;
}

// --- organizations and tenants ----------------------------------------------------

export interface TenantLink {
  tenantId: string;
  status: "active" | "suspended";
}

export async function findTenantByOrganization(db: Db, organizationId: string): Promise<TenantLink | undefined> {
  const { rows } = await sql<{ tenant_id: string; status: "active" | "suspended" }>`
    SELECT tenant_id, status FROM app.find_tenant_by_external_org(${organizationId.toLowerCase()})`.execute(db);
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, status: row.status } : undefined;
}

/** The WorkEasy360 organization a tenant is linked to, answered only for an active member of it. */
export async function memberTenantOrganization(db: Db, tenantId: string, userId: string): Promise<string | undefined> {
  if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(userId)) return undefined;
  const { rows } = await sql<{ org: string | null }>`SELECT app.member_tenant_external_org(${tenantId}::uuid, ${userId}::uuid) AS org`.execute(db);
  return rows[0]?.org ?? undefined;
}

/** Issuers other than `issuer` under which this subject already has a user (password accounts excluded). */
export async function otherIssuersForSubject(db: Db, issuer: string, subject: string): Promise<string[]> {
  const { rows } = await sql<{ issuer: string }>`SELECT issuer FROM app.find_issuers_for_subject(${subject})`.execute(db);
  return rows.map((r) => r.issuer).filter((i) => i !== issuer && i !== PASSWORD_ISSUER);
}

export interface Workeasy360SignIn {
  issuer: string;
  subject: string;
  displayName?: string | undefined;
  /** The WorkEasy360 organization the ID token named. */
  organizationId: string;
  /** A display label for a tenant created by this sign-in; never an identity. */
  organizationName?: string | undefined;
  /** The role someone gets on joining an existing tenant. The first person of a new tenant is its owner. */
  defaultRole: MembershipRole;
  /** Whether a WorkEasy360 organization with no tenant yet gets one on its first sign-in. */
  provisionTenants: boolean;
  homeRegion: string;
  requestId?: string | undefined;
}

export type ProvisionOutcome =
  | { kind: "ok"; userId: string; tenantId: string; tenantCreated: boolean; membershipCreated: boolean; role: MembershipRole }
  | { kind: "refused"; code: "tenant_suspended" | "membership_revoked" | "no_tenant" | "identity_conflict"; detail: string };

/** Fallback label for a tenant created from a token that carries no organization name. */
export const FALLBACK_ORGANIZATION_NAME = "My organization";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * Maps a verified WorkEasy360 sign-in onto this product's rows.
 *
 * - The person is the user keyed on (issuer, sub). Never on email: a password
 *   account with the same address stays a different account.
 * - The tenant is the one linked to the token's organization (operator
 *   command), or a new one on the organization's first sign-in.
 * - Access is the membership in that tenant: an existing active one keeps its
 *   role; a revoked one is refused (an administrator of this product removed
 *   the person); none yet is created with the default role.
 */
export async function provisionSignIn(db: Db, input: Workeasy360SignIn): Promise<ProvisionOutcome> {
  const organizationId = input.organizationId.toLowerCase();
  if (!UUID_PATTERN.test(organizationId)) return { kind: "refused", code: "no_tenant", detail: "organization_id is not a UUID" };

  // An issuer move (ADR-067) without the identity move would split one person into two accounts.
  const existingElsewhere = await otherIssuersForSubject(db, input.issuer, input.subject);
  const known = await sql<{ id: string | null }>`SELECT app.find_user_id_by_identity(${input.issuer}, ${input.subject}) AS id`.execute(db);
  if (!known.rows[0]?.id && existingElsewhere.length > 0) {
    return {
      kind: "refused",
      code: "identity_conflict",
      detail: `subject already has a user under ${existingElsewhere.length} other issuer(s); run move-identity-issuer`,
    };
  }

  const userId = await findOrCreateUser(db, { issuer: input.issuer, subject: input.subject, ...(input.displayName ? { displayName: input.displayName } : {}) });

  let link = await findTenantByOrganization(db, organizationId);
  let tenantCreated = false;
  if (!link) {
    if (!input.provisionTenants) return { kind: "refused", code: "no_tenant", detail: "no tenant is linked to this organization" };
    const tenantId = randomUUID();
    const name = (input.organizationName ?? "").trim().slice(0, 200) || FALLBACK_ORGANIZATION_NAME;
    try {
      await withContext(db, { tenantId, userId }, async (trx) => {
        await trx.insertInto("tenants").values({ id: tenantId, name, home_region: input.homeRegion, external_org_id: organizationId }).execute();
        await trx.insertInto("memberships").values({ tenant_id: tenantId, user_id: userId, role: "owner" }).execute();
        await appendAudit(trx, {
          tenantId,
          actor: { type: "user", id: userId },
          action: "organization.provisioned_from_workeasy",
          resourceType: "organization",
          resourceId: tenantId,
          requestId: input.requestId,
          metadata: { workeasy360OrganizationId: organizationId },
        });
      });
      tenantCreated = true;
      link = { tenantId, status: "active" };
    } catch (err) {
      // Two first sign-ins of one organization raced; the other created the tenant.
      if (!isUniqueViolation(err)) throw err;
      link = await findTenantByOrganization(db, organizationId);
      if (!link) throw err;
    }
  }
  if (link.status !== "active") return { kind: "refused", code: "tenant_suspended", detail: `tenant ${link.tenantId} is suspended` };

  const tenantId = link.tenantId;
  const outcome = await withContext(db, { tenantId, userId }, async (trx): Promise<ProvisionOutcome> => {
    const membership = await trx.selectFrom("memberships").select(["role", "status"]).where("user_id", "=", userId).executeTakeFirst();
    if (membership?.status === "active") {
      return { kind: "ok", userId, tenantId, tenantCreated, membershipCreated: false, role: membership.role };
    }
    if (membership) {
      return { kind: "refused", code: "membership_revoked", detail: `membership of ${userId} in ${tenantId} is revoked` };
    }
    await trx
      .insertInto("memberships")
      .values({ tenant_id: tenantId, user_id: userId, role: input.defaultRole })
      .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
      .execute();
    const now = await trx.selectFrom("memberships").select(["role", "status"]).where("user_id", "=", userId).executeTakeFirstOrThrow();
    if (now.status !== "active") return { kind: "refused", code: "membership_revoked", detail: `membership of ${userId} in ${tenantId} is revoked` };
    await appendAudit(trx, {
      tenantId,
      actor: { type: "user", id: userId },
      action: "member.joined_from_workeasy",
      resourceType: "member",
      resourceId: userId,
      requestId: input.requestId,
      metadata: { role: now.role },
    });
    return { kind: "ok", userId, tenantId, tenantCreated, membershipCreated: true, role: now.role };
  });
  return outcome;
}

// --- back-channel logout --------------------------------------------------------

export interface LogoutTokenFacts {
  issuer: string;
  jti: string;
  subject?: string | undefined;
  sid?: string | undefined;
  /** After this instant the token is refused anyway, so its jti need not be remembered longer. */
  acceptableUntil: Date;
}

export type LogoutOutcome = { replayed: true } | { replayed: false; sessionsEnded: number };

/** Records the jti and ends the sessions the token names, in one transaction. */
export async function endSessions(db: Db, token: LogoutTokenFacts): Promise<LogoutOutcome> {
  const { rows } = await sql<{ replayed: boolean; sessions_ended: number }>`
    SELECT replayed, sessions_ended FROM app.workeasy360_end_sessions(
      ${token.issuer}, ${token.jti}, ${token.acceptableUntil}, ${token.subject ?? null}, ${token.sid ?? null})`.execute(db);
  const row = rows[0];
  if (!row) throw new Error("workeasy360_end_sessions returned nothing");
  return row.replayed ? { replayed: true } : { replayed: false, sessionsEnded: Number(row.sessions_ended) };
}

// --- entitlement answers ---------------------------------------------------------

export async function getEntitlementAnswer(db: Db, key: string): Promise<string | null> {
  const { rows } = await sql<{ answer: unknown }>`SELECT app.workeasy360_entitlement_get(${key}) AS answer`.execute(db);
  const answer = rows[0]?.answer;
  return answer === null || answer === undefined ? null : JSON.stringify(answer);
}

/** `ttlSeconds` null: kept without expiry (a known denial must never lapse). */
export async function putEntitlementAnswer(db: Db, key: string, value: string, ttlSeconds: number | null): Promise<void> {
  await sql`SELECT app.workeasy360_entitlement_put(${key}, ${value}::jsonb, ${ttlSeconds}::integer)`.execute(db);
}

// --- operator commands -------------------------------------------------------------

export class OperatorError extends Error {
  override name = "OperatorError";
}

export interface LinkResult {
  tenantId: string;
  tenantName: string;
  organizationId: string;
  /** False: it was already linked to exactly this organization. */
  changed: boolean;
  /** The empty tenant a first sign-in had created for this organization, now unlinked and suspended. */
  replacedTenantId?: string;
}

/**
 * `link-workeasy360-organization <tenant> <organization>`: binds an existing
 * tenant to a WorkEasy360 organization, so sign-ins from that organization land
 * in it instead of creating a new, empty tenant. Runs as the owner role.
 *
 * `replaceEmpty`: when a first sign-in already created a tenant for the
 * organization and that tenant holds no forms, it is unlinked and suspended,
 * and its WorkEasy360 sessions end; otherwise the command refuses.
 */
export async function linkOrganization(
  ownerDb: Db,
  tenantId: string,
  organizationId: string,
  options: { replaceEmpty?: boolean } = {},
): Promise<LinkResult> {
  if (!UUID_PATTERN.test(tenantId)) throw new OperatorError("The tenant id must be a UUID.");
  if (!UUID_PATTERN.test(organizationId)) throw new OperatorError("The WorkEasy360 organization id must be a UUID.");
  const target = organizationId.toLowerCase();
  const tenant = await withContext(ownerDb, { tenantId }, (trx) =>
    trx.selectFrom("tenants").select(["id", "name", "external_org_id", "status"]).where("id", "=", tenantId).executeTakeFirst(),
  );
  if (!tenant) throw new OperatorError(`No tenant ${tenantId}.`);
  if (tenant.external_org_id === target) return { tenantId, tenantName: tenant.name, organizationId: target, changed: false };
  if (tenant.external_org_id) {
    throw new OperatorError(
      `${tenant.name} is already linked to WorkEasy360 organization ${tenant.external_org_id}. Unlink it deliberately before linking it to another one.`,
    );
  }
  const holder = await findTenantByOrganization(ownerDb, target);
  let replacedTenantId: string | undefined;
  if (holder) {
    if (!options.replaceEmpty) {
      throw new OperatorError(
        `WorkEasy360 organization ${target} is already linked to tenant ${holder.tenantId}. If a first sign-in created that tenant and it has no forms, run again with --replace-empty.`,
      );
    }
    // The owner role reads every tenant's forms (0005 public_locator), so the tenant is named explicitly.
    const forms = await withContext(ownerDb, { tenantId: holder.tenantId }, (trx) =>
      trx.selectFrom("forms").select((eb) => eb.fn.countAll<string>().as("n")).where("tenant_id", "=", holder.tenantId).executeTakeFirstOrThrow(),
    );
    if (Number(forms.n) > 0) {
      throw new OperatorError(`Tenant ${holder.tenantId} holds ${forms.n} form(s); it is not empty, so it is not replaced.`);
    }
    await withContext(ownerDb, { tenantId: holder.tenantId }, (trx) =>
      trx.updateTable("tenants").set({ external_org_id: null, status: "suspended" }).where("id", "=", holder.tenantId).execute(),
    );
    await sql`UPDATE app.auth_sessions SET revoked_at = now() WHERE tenant_id = ${holder.tenantId}::uuid AND revoked_at IS NULL`.execute(ownerDb);
    replacedTenantId = holder.tenantId;
  }
  await withContext(ownerDb, { tenantId }, async (trx) => {
    await trx.updateTable("tenants").set({ external_org_id: target }).where("id", "=", tenantId).execute();
    await appendAudit(trx, {
      tenantId,
      actor: { type: "system" },
      action: "organization.linked_to_workeasy",
      resourceType: "organization",
      resourceId: tenantId,
      metadata: { workeasy360OrganizationId: target, ...(replacedTenantId ? { replacedTenantId } : {}) },
    });
  });
  return { tenantId, tenantName: tenant.name, organizationId: target, changed: true, ...(replacedTenantId ? { replacedTenantId } : {}) };
}

export interface IssuerCount {
  issuer: string;
  users: number;
  liveSessions: number;
}

/** `workeasy360-identities`: how many users (and live sessions) each issuer holds. */
export async function countIdentities(ownerDb: Db): Promise<IssuerCount[]> {
  const { rows } = await sql<{ issuer: string; users: string; live: string }>`
    SELECT u.issuer, count(DISTINCT u.id) AS users,
           count(s.id) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at > now()) AS live
      FROM app.users u LEFT JOIN app.auth_sessions s ON s.user_id = u.id
     GROUP BY u.issuer ORDER BY u.issuer`.execute(ownerDb);
  return rows.map((r) => ({ issuer: r.issuer, users: Number(r.users), liveSessions: Number(r.live) }));
}

export interface IssuerMovePlan {
  from: string;
  to: string;
  /** Users whose identity moves. */
  movable: number;
  /** Subjects that already have a user under the new issuer: moving would merge two accounts. */
  conflicts: { subject: string; fromUserId: string; toUserId: string }[];
  applied: boolean;
}

/**
 * `move-identity-issuer --from <issuer> --to <issuer> [--apply]`: the
 * identity-link move of an issuer change (the contract's step 4: "When the
 * issuer moves, the identity-link move runs in the same release"). Every user
 * keyed on (from, sub) becomes (to, sub), and so do the live WorkEasy360
 * sessions, so a logout token from the new issuer still finds them.
 *
 * It never merges: when a subject already has a user under the new issuer
 * (someone signed in after the issuer changed and before the move), the move
 * is refused and the pairs are listed for an operator to resolve. Without
 * `apply` it only reports.
 */
export async function moveIssuer(ownerDb: Db, from: string, to: string, apply: boolean): Promise<IssuerMovePlan> {
  if (!from || !to || from === to) throw new OperatorError("Give two different issuers: --from <issuer> --to <issuer>.");
  if (from === PASSWORD_ISSUER || to === PASSWORD_ISSUER) throw new OperatorError("Password accounts are not moved between issuers.");
  const { rows: movable } = await sql<{ id: string; subject: string }>`SELECT id, subject FROM app.users WHERE issuer = ${from}`.execute(ownerDb);
  const { rows: conflicts } = await sql<{ subject: string; from_id: string; to_id: string }>`
    SELECT a.subject, a.id AS from_id, b.id AS to_id
      FROM app.users a JOIN app.users b ON b.subject = a.subject AND b.issuer = ${to}
     WHERE a.issuer = ${from}`.execute(ownerDb);
  const plan: IssuerMovePlan = {
    from,
    to,
    movable: movable.length,
    conflicts: conflicts.map((c) => ({ subject: c.subject, fromUserId: c.from_id, toUserId: c.to_id })),
    applied: false,
  };
  if (!apply || plan.conflicts.length > 0 || movable.length === 0) return plan;
  await ownerDb.transaction().execute(async (trx) => {
    for (const user of movable) {
      // users_update_self: each identity row changes in its own user context.
      await sql`SELECT set_config('app.user_id', ${user.id}, true), set_config('app.tenant_id', '', true)`.execute(trx);
      await trx.updateTable("users").set({ issuer: to }).where("id", "=", user.id).where("issuer", "=", from).execute();
    }
    await sql`UPDATE app.auth_sessions SET w360_issuer = ${to} WHERE w360_issuer = ${from} AND revoked_at IS NULL`.execute(trx);
  });
  return { ...plan, applied: true };
}

export interface UserLinkResult {
  userId: string;
  fromIssuer: string;
  toIssuer: string;
  subject: string;
}

/**
 * `link-workeasy360-user --user <id> --subject <sub> --issuer <issuer>`: an
 * operator vouches that an existing account (a password account, or one from
 * another identity provider) is this WorkEasy360 person, and re-keys it to
 * (issuer, sub). Memberships, forms and grants stay with the account. Refused
 * when the WorkEasy360 identity already has its own user: two accounts are
 * never merged silently. A password account keeps its password; with
 * WORKEASY360_SSO_ONLY=true it can no longer be used.
 */
export async function linkUserIdentity(ownerDb: Db, userId: string, issuer: string, subject: string): Promise<UserLinkResult> {
  if (!UUID_PATTERN.test(userId)) throw new OperatorError("The user id must be a UUID.");
  if (!issuer || !subject || subject.length > 255) throw new OperatorError("Give the WorkEasy360 issuer and the person's sub.");
  const { rows: current } = await sql<{ issuer: string; subject: string }>`SELECT issuer, subject FROM app.users WHERE id = ${userId}::uuid`.execute(ownerDb);
  const user = current[0];
  if (!user) throw new OperatorError(`No user ${userId}.`);
  if (user.issuer === issuer && user.subject === subject) return { userId, fromIssuer: issuer, toIssuer: issuer, subject };
  if (user.issuer === issuer) throw new OperatorError(`User ${userId} is already a different WorkEasy360 identity (${user.subject}).`);
  const { rows: taken } = await sql<{ id: string | null }>`SELECT app.find_user_id_by_identity(${issuer}, ${subject}) AS id`.execute(ownerDb);
  if (taken[0]?.id) {
    throw new OperatorError(
      `WorkEasy360 identity ${subject} already has its own user ${taken[0].id}. Give that user the access it needs instead (Members page), or resolve the two accounts by hand.`,
    );
  }
  await withContext(ownerDb, { userId }, (trx) => trx.updateTable("users").set({ issuer, subject }).where("id", "=", userId).execute());
  return { userId, fromIssuer: user.issuer, toIssuer: issuer, subject };
}
