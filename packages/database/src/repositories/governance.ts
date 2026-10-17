import { sql, type Transaction } from "kysely";
import type { Db } from "../client.js";
import type { Database } from "../schema.js";

/**
 * Deletion, retention, legal holds and the audit log (docs/04 §7). The API
 * marks responses and forms deleted and reads the audit log; the worker
 * purges deleted content and applies retention through the migration 0012
 * functions.
 */
type Trx = Transaction<Database>;

export interface RetentionSettings {
  retentionDays: number;
  legalHold: boolean;
}

export async function getRetention(trx: Trx, formId: string): Promise<RetentionSettings | undefined> {
  const row = await trx.selectFrom("forms").select(["retention_days", "legal_hold"]).where("id", "=", formId).where("deleted_at", "is", null).executeTakeFirst();
  return row ? { retentionDays: row.retention_days, legalHold: row.legal_hold } : undefined;
}

export async function setRetention(trx: Trx, formId: string, settings: RetentionSettings): Promise<void> {
  await trx.updateTable("forms").set({ retention_days: settings.retentionDays, legal_hold: settings.legalHold }).where("id", "=", formId).execute();
}

/** Marks one response deleted; false if it was already deleted or does not exist. */
export async function deleteResponse(trx: Trx, formId: string, submissionId: string, deletedBy: string, reason: string): Promise<boolean> {
  const res = await trx
    .updateTable("submissions")
    .set({ deleted_at: sql<Date>`now()`, deleted_by: deletedBy, deletion_reason: reason })
    .where("id", "=", submissionId)
    .where("form_id", "=", formId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return res.numUpdatedRows > 0n;
}

/** Marks a form and all its responses deleted; returns how many responses. */
export async function deleteForm(trx: Trx, formId: string, deletedBy: string, reason: string): Promise<number> {
  await trx.updateTable("forms").set({ deleted_at: sql<Date>`now()` }).where("id", "=", formId).where("deleted_at", "is", null).execute();
  const res = await trx
    .updateTable("submissions")
    .set({ deleted_at: sql<Date>`now()`, deleted_by: deletedBy, deletion_reason: reason })
    .where("form_id", "=", formId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

// Audit log ------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  occurredAt: Date;
  occurredAtKey: string;
  actor: { type: "user" | "system"; id: string | null; displayName: string | null };
  action: string;
  resourceType: string;
  resourceId: string;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditQuery {
  limit: number;
  after?: { occurredAt: string; id: string } | undefined;
  action?: string | undefined;
  resourceId?: string | undefined;
}

/** The tenant's audit entries, newest first, keyset-paginated on (occurred_at, id). */
export async function listAudit(trx: Trx, query: AuditQuery): Promise<{ entries: AuditEntry[]; more: boolean }> {
  let q = trx
    .selectFrom("audit_events as a")
    .leftJoin("users as u", "u.id", "a.actor_id")
    .select([
      "a.id",
      "a.occurred_at",
      sql<string>`a.occurred_at::text`.as("occurred_at_key"),
      "a.actor_type",
      "a.actor_id",
      "u.display_name",
      "a.action",
      "a.resource_type",
      "a.resource_id",
      "a.request_id",
      "a.metadata",
    ]);
  if (query.after) q = q.where(sql<boolean>`(a.occurred_at, a.id) < (${query.after.occurredAt}::timestamptz, ${query.after.id}::uuid)`);
  if (query.action) q = q.where("a.action", "=", query.action);
  if (query.resourceId) q = q.where("a.resource_id", "=", query.resourceId);
  const rows = await q.orderBy("a.occurred_at", "desc").orderBy("a.id", "desc").limit(query.limit + 1).execute();
  return {
    entries: rows.slice(0, query.limit).map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      occurredAtKey: r.occurred_at_key,
      actor: { type: r.actor_type, id: r.actor_id, displayName: r.display_name ?? null },
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      requestId: r.request_id,
      metadata: r.metadata,
    })),
    more: rows.length > query.limit,
  };
}

// Worker ---------------------------------------------------------------------------

export interface PurgeJob {
  submissionId: string;
  tenantId: string;
  formId: string;
  receivedAt: Date;
}

export const PURGE_LEASE_SECONDS = 300;

export async function claimPurges(db: Db, limit: number): Promise<PurgeJob[]> {
  const { rows } = await sql<{ submission_id: string; tenant_id: string; form_id: string; received_at: Date }>`
    SELECT * FROM app.claim_purges(${limit}::integer, ${PURGE_LEASE_SECONDS}::integer)`.execute(db);
  return rows.map((r) => ({ submissionId: r.submission_id, tenantId: r.tenant_id, formId: r.form_id, receivedAt: r.received_at }));
}

/** Stored objects that must go with a response: its files, and finished exports that could contain it. */
export async function purgeTargets(trx: Trx, job: PurgeJob): Promise<{ fileKeys: Array<{ key: string; clean: boolean }>; exportIds: string[] }> {
  const files = await trx
    .selectFrom("file_uploads")
    .select(["storage_key", "state"])
    .where("claimed_submission_id", "=", job.submissionId)
    .execute();
  const exports = await trx
    .selectFrom("exports")
    .select("id")
    .where("form_id", "=", job.formId)
    .where("state", "=", "succeeded")
    .where("cutoff", ">=", job.receivedAt)
    .execute();
  return { fileKeys: files.map((f) => ({ key: f.storage_key, clean: f.state === "clean" })), exportIds: exports.map((e) => e.id) };
}

/** Clears the response's content once its objects are gone; false if a hold or another worker got there first. */
export async function completePurge(db: Db, submissionId: string): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`SELECT app.complete_purge(${submissionId}::uuid) AS ok`.execute(db);
  return rows[0]?.ok === true;
}

/** Deletes responses past their form's retention period; returns how many. */
export async function applyRetention(db: Db, limit: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT app.apply_retention(${limit}::integer) AS n`.execute(db);
  return rows[0]?.n ?? 0;
}

// Deletion ledger (REC-01) ------------------------------------------------------------

export interface LedgerEntry {
  kind: "form" | "response";
  id: string;
  tenant_id: string;
  form_id: string;
  /** ISO time with microseconds, as the database stores it. */
  deleted_at: string;
}

/** Forms and responses deleted after `since`, oldest first. Owner connection only. */
export async function exportDeletionLedger(db: Db, since: string): Promise<LedgerEntry[]> {
  const { rows } = await sql<LedgerEntry>`
    SELECT kind, id, tenant_id, form_id, to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at
      FROM app.deletion_ledger(${since}::timestamptz)`.execute(db);
  return rows;
}

/** Deletes again what the ledger lists; idempotent. Owner connection only. */
export async function replayDeletions(db: Db, entries: readonly LedgerEntry[]): Promise<{ forms: number; responses: number }> {
  const { rows } = await sql<{ forms_deleted: number; responses_deleted: number }>`
    SELECT * FROM app.replay_deletions(${JSON.stringify(entries)}::jsonb)`.execute(db);
  return { forms: rows[0]?.forms_deleted ?? 0, responses: rows[0]?.responses_deleted ?? 0 };
}
