import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../client.js";
import { withContext } from "../context.js";
import type { MembershipRole, MembershipStatus } from "../schema.js";

export interface IdentityClaims {
  issuer: string;
  subject: string;
  displayName?: string;
}

/** 256-bit random token, base64url without padding (43 characters). */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

async function findUserId(db: Db, issuer: string, subject: string): Promise<string | undefined> {
  const { rows } = await sql<{ id: string | null }>`SELECT app.find_user_id_by_identity(${issuer}, ${subject}) AS id`.execute(db);
  return rows[0]?.id ?? undefined;
}

/**
 * Maps a verified issuer + subject to a user, creating the identity row on
 * first sign-in. Creating a user grants nothing: access comes only from
 * memberships managed inside an organization.
 */
export async function findOrCreateUser(db: Db, identity: IdentityClaims): Promise<string> {
  const displayName = identity.displayName?.slice(0, 200) ?? null;
  let userId = await findUserId(db, identity.issuer, identity.subject);
  if (!userId) {
    const newId = randomUUID();
    await withContext(db, { userId: newId }, (trx) =>
      trx
        .insertInto("users")
        .values({ id: newId, issuer: identity.issuer, subject: identity.subject, display_name: displayName })
        .onConflict((oc) => oc.columns(["issuer", "subject"]).doNothing())
        .execute(),
    );
    // A concurrent first sign-in may have won the insert; use whichever row exists.
    userId = await findUserId(db, identity.issuer, identity.subject);
    if (!userId) throw new Error("User identity could not be created.");
  } else if (displayName !== null) {
    const id = userId;
    await withContext(db, { userId: id }, (trx) =>
      trx
        .updateTable("users")
        .set({ display_name: displayName })
        .where("id", "=", id)
        .where("display_name", "is distinct from", displayName)
        .execute(),
    );
  }
  return userId;
}

/** Issuer of email and password accounts; their subject is the normalized email. */
export const PASSWORD_ISSUER = "urn:workeasy:password";

/**
 * Creates a user with an email and password (already hashed by the caller).
 * Returns undefined when the email is taken.
 */
export async function createPasswordAccount(
  db: Db,
  account: { email: string; passwordHash: string; displayName?: string },
): Promise<string | undefined> {
  const email = account.email.toLowerCase();
  if (await findUserId(db, PASSWORD_ISSUER, email)) return undefined;
  const userId = randomUUID();
  try {
    await withContext(db, { userId }, async (trx) => {
      await trx
        .insertInto("users")
        .values({ id: userId, issuer: PASSWORD_ISSUER, subject: email, display_name: account.displayName?.slice(0, 200) ?? null })
        .execute();
      await trx.insertInto("password_credentials").values({ user_id: userId, email, password_hash: account.passwordHash }).execute();
    });
  } catch (err) {
    // A concurrent sign-up with the same email won.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") return undefined;
    throw err;
  }
  return userId;
}

/** The stored hash for an email, for checking a sign-in attempt. */
export async function findPasswordCredential(db: Db, email: string): Promise<{ userId: string; passwordHash: string } | undefined> {
  const { rows } = await sql<{ user_id: string; password_hash: string }>`
    SELECT user_id, password_hash FROM app.find_password_credential(${email.toLowerCase()})`.execute(db);
  const row = rows[0];
  return row ? { userId: row.user_id, passwordHash: row.password_hash } : undefined;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

/**
 * What a WorkEasy360 session is bound to (docs/workeasy360-sso.md): the one
 * tenant its ID token's organization maps to, and the provider sign-in a
 * back-channel logout names.
 */
export interface SessionBinding {
  tenantId: string;
  issuer: string;
  subject: string;
  /** The ID token's sid, when the provider issued one. */
  sid?: string | undefined;
  organizationId: string;
  /** Sent back as id_token_hint when the person also signs out of WorkEasy360. */
  idToken?: string | undefined;
}

export async function createSession(db: Db, userId: string, ttlMs: number, binding?: SessionBinding): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  const row = await withContext(db, { userId }, (trx) =>
    trx
      .insertInto("auth_sessions")
      .values({
        user_id: userId,
        token_hash: hashToken(token),
        expires_at: expiresAt,
        ...(binding
          ? {
              provider: "workeasy360" as const,
              tenant_id: binding.tenantId,
              w360_issuer: binding.issuer,
              w360_subject: binding.subject,
              w360_sid: binding.sid ?? null,
              w360_organization_id: binding.organizationId,
              id_token: binding.idToken ?? null,
            }
          : {}),
      })
      .returning("id")
      .executeTakeFirstOrThrow(),
  );
  return { token, sessionId: row.id, expiresAt };
}

export type SessionProvider = "local" | "workeasy360";

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  /** `local`: password or the generic OIDC provider. `workeasy360`: WorkEasy360 Accounts, bound to one tenant. */
  provider: SessionProvider;
  /** A WorkEasy360 session's tenant; the only organization it may reach. */
  tenantId?: string;
  /** A WorkEasy360 session's organization and person, for the entitlement endpoint. */
  workeasy360OrganizationId?: string;
  workeasy360Subject?: string;
}

/**
 * Returns the active (unrevoked, unexpired) session for a cookie token. It
 * reads PostgreSQL every time: a session ended anywhere (sign-out, a
 * back-channel logout on another instance) is refused on the next request.
 */
export async function resolveSession(db: Db, token: string): Promise<ResolvedSession | undefined> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return undefined;
  const { rows } = await sql<{
    session_id: string;
    user_id: string;
    expires_at: Date;
    provider: SessionProvider;
    tenant_id: string | null;
    w360_organization_id: string | null;
    w360_subject: string | null;
  }>`
    SELECT session_id, user_id, expires_at, provider, tenant_id, w360_organization_id, w360_subject
      FROM app.resolve_session(${hashToken(token)})`.execute(db);
  const row = rows[0];
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    provider: row.provider,
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    ...(row.w360_organization_id ? { workeasy360OrganizationId: row.w360_organization_id } : {}),
    ...(row.w360_subject ? { workeasy360Subject: row.w360_subject } : {}),
  };
}

/** The ID token a WorkEasy360 session was opened with, for id_token_hint (the user's own context). */
export async function sessionIdToken(db: Db, session: { sessionId: string; userId: string }): Promise<string | undefined> {
  const row = await withContext(db, { userId: session.userId }, (trx) =>
    trx.selectFrom("auth_sessions").select("id_token").where("id", "=", session.sessionId).executeTakeFirst(),
  );
  return row?.id_token ?? undefined;
}

export async function revokeSession(db: Db, session: { sessionId: string; userId: string }): Promise<void> {
  await withContext(db, { userId: session.userId }, (trx) =>
    trx
      .updateTable("auth_sessions")
      .set({ revoked_at: new Date() })
      .where("id", "=", session.sessionId)
      .where("revoked_at", "is", null)
      .execute(),
  );
}

export interface UserProfile {
  id: string;
  displayName: string | null;
  memberships: { tenantId: string; tenantName: string; role: MembershipRole; status: MembershipStatus }[];
}

/**
 * The signed-in user and its active memberships across organizations (user
 * context only). `onlyTenantId` narrows them to one: a WorkEasy360 session
 * sees only the organization its token named.
 */
export async function getUserProfile(db: Db, userId: string, onlyTenantId?: string): Promise<UserProfile | undefined> {
  return withContext(db, { userId }, async (trx) => {
    const user = await trx.selectFrom("users").select(["id", "display_name"]).where("id", "=", userId).executeTakeFirst();
    if (!user) return undefined;
    let query = trx
      .selectFrom("memberships as m")
      .innerJoin("tenants as t", "t.id", "m.tenant_id")
      .select(["m.tenant_id", "t.name", "m.role", "m.status"])
      .where("m.user_id", "=", userId)
      .where("m.status", "=", "active")
      .where("t.status", "=", "active");
    if (onlyTenantId) query = query.where("m.tenant_id", "=", onlyTenantId);
    const memberships = await query.orderBy("t.name").execute();
    return {
      id: user.id,
      displayName: user.display_name,
      memberships: memberships.map((m) => ({ tenantId: m.tenant_id, tenantName: m.name, role: m.role, status: m.status })),
    };
  });
}
