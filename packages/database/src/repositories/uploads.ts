import { sql, type Transaction } from "kysely";
import type { Db } from "../client.js";
import type { Database, UploadState } from "../schema.js";

/**
 * Upload records (docs/06 §3). The respondent side runs as the public role
 * in the session's tenant context and may only create and read records; all
 * state changes go through the database functions from migration 0009. The
 * worker side claims scan work across tenants through those functions.
 */
type Trx = Transaction<Database>;

export interface Upload {
  id: string;
  formId: string;
  formVersionId: string;
  sessionId: string;
  fieldId: string;
  fileName: string;
  declaredType: string;
  declaredBytes: number;
  storageKey: string;
  state: UploadState;
  detectedType: string | null;
  rejectionReason: string | null;
  bytes: number | null;
  claimedSubmissionId: string | null;
  expiresAt: Date;
}

type Row = Database["file_uploads"];

function toUpload(row: {
  id: string;
  form_id: string;
  form_version_id: string;
  session_id: string;
  field_id: string;
  file_name: string;
  declared_type: string;
  declared_bytes: number;
  storage_key: string;
  state: UploadState;
  detected_type: string | null;
  rejection_reason: string | null;
  bytes: number | null;
  claimed_submission_id: string | null;
  expires_at: Date;
}): Upload {
  return {
    id: row.id,
    formId: row.form_id,
    formVersionId: row.form_version_id,
    sessionId: row.session_id,
    fieldId: row.field_id,
    fileName: row.file_name,
    declaredType: row.declared_type,
    declaredBytes: row.declared_bytes,
    storageKey: row.storage_key,
    state: row.state,
    detectedType: row.detected_type,
    rejectionReason: row.rejection_reason,
    bytes: row.bytes,
    claimedSubmissionId: row.claimed_submission_id,
    expiresAt: row.expires_at,
  };
}

const COLUMNS = [
  "id",
  "form_id",
  "form_version_id",
  "session_id",
  "field_id",
  "file_name",
  "declared_type",
  "declared_bytes",
  "storage_key",
  "state",
  "detected_type",
  "rejection_reason",
  "bytes",
  "claimed_submission_id",
  "expires_at",
] as const satisfies ReadonlyArray<keyof Row>;

export interface NewUpload {
  id: string;
  tenantId: string;
  formId: string;
  formVersionId: string;
  sessionId: string;
  fieldId: string;
  fileName: string;
  declaredType: string;
  declaredBytes: number;
  storageKey: string;
}

export async function createUpload(trx: Trx, upload: NewUpload): Promise<void> {
  await trx
    .insertInto("file_uploads")
    .values({
      id: upload.id,
      tenant_id: upload.tenantId,
      form_id: upload.formId,
      form_version_id: upload.formVersionId,
      session_id: upload.sessionId,
      field_id: upload.fieldId,
      file_name: upload.fileName,
      declared_type: upload.declaredType,
      declared_bytes: upload.declaredBytes,
      storage_key: upload.storageKey,
    })
    .execute();
}

/** An upload of this session, or undefined (another session's upload looks missing). */
export async function getSessionUpload(trx: Trx, sessionId: string, uploadId: string): Promise<Upload | undefined> {
  const row = await trx.selectFrom("file_uploads").select(COLUMNS).where("id", "=", uploadId).where("session_id", "=", sessionId).executeTakeFirst();
  return row ? toUpload(row) : undefined;
}

/** Uploads of this session that still count towards a field's file allowance. */
export async function countActiveUploads(trx: Trx, sessionId: string, fieldId: string): Promise<number> {
  const row = await trx
    .selectFrom("file_uploads")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("session_id", "=", sessionId)
    .where("field_id", "=", fieldId)
    .where("state", "not in", ["rejected", "infected", "expired"])
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** awaiting_upload -> pending_scan; false if the upload was not awaiting its bytes. */
export async function markReceived(trx: Trx, sessionId: string, uploadId: string, bytes: number): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean | null }>`SELECT app.mark_upload_received(${uploadId}::uuid, ${sessionId}::uuid, ${bytes}::integer) AS ok`.execute(trx);
  return rows[0]?.ok === true;
}

export async function rejectUpload(trx: Trx, sessionId: string, uploadId: string, reason: "size_mismatch" | "too_large"): Promise<void> {
  await sql`SELECT app.reject_upload(${uploadId}::uuid, ${sessionId}::uuid, ${reason})`.execute(trx);
}

/** The session's uploads among `ids`, to explain why a submission cannot claim them. */
export async function uploadsByIds(trx: Trx, sessionId: string, ids: readonly string[]): Promise<Upload[]> {
  if (ids.length === 0) return [];
  const rows = await trx.selectFrom("file_uploads").select(COLUMNS).where("session_id", "=", sessionId).where("id", "in", [...ids]).execute();
  return rows.map(toUpload);
}

/**
 * Claims the uploads for a submission, all or nothing (app.claim_uploads).
 * Throws if any of them cannot be claimed, which rolls back the intake.
 */
export async function claimUploads(trx: Trx, sessionId: string, submissionId: string, claims: ReadonlyArray<{ uploadId: string; fieldId: string }>): Promise<void> {
  if (claims.length === 0) return;
  const ids = claims.map((c) => c.uploadId);
  const fields = claims.map((c) => c.fieldId);
  await sql`SELECT app.claim_uploads(${sessionId}::uuid, ${submissionId}::uuid, ${ids}::uuid[], ${fields}::text[])`.execute(trx);
}

/** A clean upload claimed by this submission of this form (for authorized downloads). */
export async function getClaimedUpload(trx: Trx, formId: string, submissionId: string, uploadId: string): Promise<Upload | undefined> {
  const row = await trx
    .selectFrom("file_uploads")
    .select(COLUMNS)
    .where("id", "=", uploadId)
    .where("form_id", "=", formId)
    .where("claimed_submission_id", "=", submissionId)
    .where("state", "=", "clean")
    .executeTakeFirst();
  return row ? toUpload(row) : undefined;
}

// Worker ------------------------------------------------------------------------

export interface ScanJob {
  uploadId: string;
  tenantId: string;
  formId: string;
  formVersionId: string;
  fieldId: string;
  storageKey: string;
  declaredType: string;
  declaredBytes: number;
  /** Lease token: finishScan succeeds only with the attempt that was leased. */
  attempt: number;
}

export async function claimScanJobs(db: Db, limit: number, leaseSeconds: number): Promise<ScanJob[]> {
  const { rows } = await sql<{
    upload_id: string;
    tenant_id: string;
    form_id: string;
    form_version_id: string;
    field_id: string;
    storage_key: string;
    declared_type: string;
    declared_bytes: number;
    attempt: number;
  }>`SELECT * FROM app.claim_scan_jobs(${limit}::integer, ${leaseSeconds}::integer)`.execute(db);
  return rows.map((r) => ({
    uploadId: r.upload_id,
    tenantId: r.tenant_id,
    formId: r.form_id,
    formVersionId: r.form_version_id,
    fieldId: r.field_id,
    storageKey: r.storage_key,
    declaredType: r.declared_type,
    declaredBytes: r.declared_bytes,
    attempt: r.attempt,
  }));
}

export type ScanOutcome =
  | { outcome: "clean"; detectedType: string }
  | { outcome: "infected" }
  | { outcome: "rejected"; detectedType: string | null; reason: "type_mismatch" | "size_mismatch" | "too_large" }
  | { outcome: "retry" };

/** Records the outcome if the lease is still ours; false if another worker took over. */
export async function finishScan(db: Db, job: ScanJob, result: ScanOutcome): Promise<boolean> {
  const detected = "detectedType" in result ? result.detectedType : null;
  const reason = result.outcome === "infected" ? "malware" : result.outcome === "rejected" ? result.reason : null;
  const { rows } = await sql<{ ok: boolean | null }>`
    SELECT app.finish_scan(${job.uploadId}::uuid, ${job.attempt}::integer, ${result.outcome}, ${detected}, ${reason}) AS ok`.execute(db);
  return rows[0]?.ok === true;
}

export async function expireUploads(db: Db, limit: number): Promise<Array<{ uploadId: string; storageKey: string; previousState: UploadState }>> {
  const { rows } = await sql<{ upload_id: string; storage_key: string; previous_state: UploadState }>`
    SELECT * FROM app.expire_uploads(${limit}::integer)`.execute(db);
  return rows.map((r) => ({ uploadId: r.upload_id, storageKey: r.storage_key, previousState: r.previous_state }));
}
