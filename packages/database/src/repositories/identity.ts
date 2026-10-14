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

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(db: Db, userId: string, ttlMs: number): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  const row = await withContext(db, { userId }, (trx) =>
    trx
      .insertInto("auth_sessions")
      .values({ user_id: userId, token_hash: hashToken(token), expires_at: expiresAt })
      .returning("id")
      .executeTakeFirstOrThrow(),
  );
  return { token, sessionId: row.id, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

/** Returns the active (unrevoked, unexpired) session for a cookie token. */
export async function resolveSession(db: Db, token: string): Promise<ResolvedSession | undefined> {
  if (!SESSION_TOKEN_PATTERN.test(token)) return undefined;
  const { rows } = await sql<{ session_id: string; user_id: string; expires_at: Date }>`
    SELECT session_id, user_id, expires_at FROM app.resolve_session(${hashToken(token)})`.execute(db);
  const row = rows[0];
  return row ? { sessionId: row.session_id, userId: row.user_id, expiresAt: row.expires_at } : undefined;
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

/** The signed-in user and its active memberships across organizations (user context only). */
export async function getUserProfile(db: Db, userId: string): Promise<UserProfile | undefined> {
  return withContext(db, { userId }, async (trx) => {
    const user = await trx.selectFrom("users").select(["id", "display_name"]).where("id", "=", userId).executeTakeFirst();
    if (!user) return undefined;
    const memberships = await trx
      .selectFrom("memberships as m")
      .innerJoin("tenants as t", "t.id", "m.tenant_id")
      .select(["m.tenant_id", "t.name", "m.role", "m.status"])
      .where("m.user_id", "=", userId)
      .where("m.status", "=", "active")
      .where("t.status", "=", "active")
      .orderBy("t.name")
      .execute();
    return {
      id: user.id,
      displayName: user.display_name,
      memberships: memberships.map((m) => ({ tenantId: m.tenant_id, tenantName: m.name, role: m.role, status: m.status })),
    };
  });
}
