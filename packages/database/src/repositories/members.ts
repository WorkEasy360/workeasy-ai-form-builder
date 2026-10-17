import { sql, type Kysely, type Transaction } from "kysely";
import type { Database, MembershipRole, MembershipStatus } from "../schema.js";

/**
 * Organization members and invitation links (PAR-05). Functions taking a
 * transaction run under withContext, so row security limits them to one
 * tenant. Only a SHA-256 hash of an invitation token is ever stored.
 */
type Trx = Transaction<Database>;

export interface Member {
  userId: string;
  displayName: string | null;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: Date;
}

export async function listMembers(trx: Trx): Promise<Member[]> {
  const rows = await trx
    .selectFrom("memberships as m")
    .leftJoin("users as u", "u.id", "m.user_id")
    .select(["m.user_id", "u.display_name", "m.role", "m.status", "m.created_at"])
    .orderBy("m.status")
    .orderBy("m.created_at")
    .execute();
  return rows.map((r) => ({ userId: r.user_id, displayName: r.display_name ?? null, role: r.role, status: r.status, joinedAt: r.created_at }));
}

export async function getMember(trx: Trx, userId: string): Promise<Member | undefined> {
  return (await listMembers(trx)).find((m) => m.userId === userId);
}

/** Active owners, locked so two concurrent changes cannot both remove the last one. */
export async function lockActiveOwners(trx: Trx): Promise<string[]> {
  const rows = await trx.selectFrom("memberships").select("user_id").where("role", "=", "owner").where("status", "=", "active").forUpdate().execute();
  return rows.map((r) => r.user_id);
}

export async function updateMember(trx: Trx, userId: string, change: { role?: MembershipRole; status?: MembershipStatus }): Promise<boolean> {
  const result = await trx.updateTable("memberships").set(change).where("user_id", "=", userId).executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Adds the user to the current tenant, or reactivates them with the new role. */
export async function upsertMember(trx: Trx, tenantId: string, userId: string, role: MembershipRole): Promise<void> {
  await trx
    .insertInto("memberships")
    .values({ tenant_id: tenantId, user_id: userId, role, status: "active" })
    .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doUpdateSet({ role, status: "active" }))
    .execute();
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface Invitation {
  id: string;
  email: string | null;
  role: MembershipRole;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  status: InvitationStatus;
}

interface InvitationRow {
  id: string;
  email: string | null;
  role: MembershipRole;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  accepted_by: string | null;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

const INVITATION_COLUMNS = ["id", "email", "role", "created_by", "created_at", "expires_at", "accepted_by", "accepted_at", "revoked_at"] as const;

function toInvitation(row: InvitationRow, now: Date): Invitation {
  let status: InvitationStatus = "pending";
  if (row.accepted_at) status = "accepted";
  else if (row.revoked_at) status = "revoked";
  else if (row.expires_at <= now) status = "expired";
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    status,
  };
}

export interface NewInvitation {
  tenantId: string;
  email: string | null;
  role: MembershipRole;
  tokenHash: Buffer;
  createdBy: string;
  expiresAt: Date;
}

export async function createInvitation(trx: Trx, input: NewInvitation): Promise<Invitation> {
  const row = await trx
    .insertInto("invitations")
    .values({
      tenant_id: input.tenantId,
      email: input.email,
      role: input.role,
      token_hash: input.tokenHash,
      created_by: input.createdBy,
      expires_at: input.expiresAt,
    })
    .returning(INVITATION_COLUMNS)
    .executeTakeFirstOrThrow();
  return toInvitation(row, new Date());
}

export async function listInvitations(trx: Trx, limit = 100): Promise<Invitation[]> {
  const rows = await trx.selectFrom("invitations").select(INVITATION_COLUMNS).orderBy("created_at", "desc").limit(limit).execute();
  const now = new Date();
  return rows.map((r) => toInvitation(r, now));
}

/** Revokes a pending invitation; undefined if it does not exist or is no longer pending. */
export async function revokeInvitation(trx: Trx, id: string): Promise<Invitation | undefined> {
  const row = await trx
    .updateTable("invitations")
    .set({ revoked_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null)
    .returning(INVITATION_COLUMNS)
    .executeTakeFirst();
  return row ? toInvitation(row, new Date()) : undefined;
}

/** The organization an open (pending, unexpired) invitation belongs to. Runs without a tenant context. */
export async function resolveInvitation(db: Kysely<Database> | Trx, tokenHash: Buffer): Promise<string | undefined> {
  const { rows } = await sql<{ tenant_id: string }>`SELECT tenant_id FROM app.resolve_invitation(${tokenHash})`.execute(db);
  return rows[0]?.tenant_id;
}

/**
 * Marks the invitation accepted only if it is still open (compare and set),
 * returning it; undefined if it was accepted, revoked or expired meanwhile.
 */
export async function markInvitationAccepted(trx: Trx, tokenHash: Buffer, userId: string): Promise<Invitation | undefined> {
  const row = await trx
    .updateTable("invitations")
    .set({ accepted_by: userId, accepted_at: sql<Date>`now()` })
    .where("token_hash", "=", tokenHash)
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", sql<Date>`now()`)
    .returning(INVITATION_COLUMNS)
    .executeTakeFirst();
  return row ? toInvitation(row, new Date()) : undefined;
}
