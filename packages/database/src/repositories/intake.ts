import { sql, type Transaction } from "kysely";
import type { AccessMode, Database, FormState } from "../schema.js";

/**
 * Steps of the intake transaction (docs/04 §5), run by the public role inside
 * one tenant transaction. The caller orders them: lock the session, settle
 * idempotency, lock and check the form, validate, then write everything.
 */
type Trx = Transaction<Database>;

export interface LockedSession {
  formId: string;
  formVersionId: string;
  actorId: string | null;
  acceptedSubmissionId: string | null;
}

/** Locks the session row for the rest of the transaction, serializing every request for this session. */
export async function lockSession(trx: Trx, sessionId: string): Promise<LockedSession | undefined> {
  const row = await trx
    .selectFrom("respondent_sessions")
    .select(["form_id", "form_version_id", "actor_id", "accepted_submission_id"])
    .where("id", "=", sessionId)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", sql<Date>`now()`)
    .forUpdate()
    .executeTakeFirst();
  return row
    ? { formId: row.form_id, formVersionId: row.form_version_id, actorId: row.actor_id, acceptedSubmissionId: row.accepted_submission_id }
    : undefined;
}

export interface RecordedRequest {
  requestHash: Buffer;
  responseCode: number;
  receipt: Record<string, unknown>;
}

/** The outcome already recorded for this session and idempotency key, if any. */
export async function findRequest(trx: Trx, sessionId: string, keyHash: Buffer): Promise<RecordedRequest | undefined> {
  const row = await trx
    .selectFrom("submission_requests")
    .select(["request_hash", "response_code", "receipt"])
    .where("session_id", "=", sessionId)
    .where("key_hash", "=", keyHash)
    .executeTakeFirst();
  return row ? { requestHash: row.request_hash, responseCode: row.response_code, receipt: row.receipt } : undefined;
}

/** The receipt first issued for a submission (for a later request under another key). */
export async function receiptFor(trx: Trx, submissionId: string): Promise<Record<string, unknown> | undefined> {
  const row = await trx
    .selectFrom("submission_requests")
    .select("receipt")
    .where("submission_id", "=", submissionId)
    .orderBy("created_at")
    .executeTakeFirst();
  return row?.receipt;
}

/**
 * Locks the form row (FOR SHARE) until commit and returns its lifecycle state
 * and access mode. Closing a form must wait for in-flight intakes, and an
 * intake that starts after a close sees it.
 */
export async function lockForm(trx: Trx, formId: string): Promise<{ state: FormState; activeVersionId: string | null; accessMode: AccessMode } | undefined> {
  const { rows } = await sql<{ state: FormState; active_version_id: string | null }>`
    SELECT state, active_version_id FROM app.lock_form_for_intake(${formId}::uuid)`.execute(trx);
  const form = rows[0];
  if (!form) return undefined;
  const policy = await trx.selectFrom("form_access_policies").select("mode").where("form_id", "=", formId).executeTakeFirst();
  return { state: form.state, activeVersionId: form.active_version_id, accessMode: policy?.mode ?? "public" };
}

/** The public projection of the version a session is pinned to: what the engine validates against. */
export async function versionProjection(trx: Trx, formId: string, versionId: string): Promise<Record<string, unknown> | undefined> {
  const row = await trx
    .selectFrom("form_versions")
    .select("public_projection")
    .where("form_id", "=", formId)
    .where("id", "=", versionId)
    .executeTakeFirst();
  return row?.public_projection;
}

export interface NewSubmission {
  id: string;
  tenantId: string;
  formId: string;
  formVersionId: string;
  sessionId: string;
  answers: Record<string, unknown>;
  /** Consent fields agreed to, with the version of the wording shown (docs/03 §2). */
  consents: Array<{ fieldId: string; consentTextVersion: string | null }>;
  receiptId: string;
  receivedAt: Date;
}

/**
 * Stores the response, its idempotency record and marks the session
 * accepted. The unique (tenant, session) constraint is the last line of
 * defense against a second response for the same session.
 */
export async function insertSubmission(
  trx: Trx,
  submission: NewSubmission,
  request: { keyHash: Buffer; requestHash: Buffer; receipt: Record<string, unknown> },
): Promise<void> {
  await trx
    .insertInto("submissions")
    .values({
      id: submission.id,
      tenant_id: submission.tenantId,
      form_id: submission.formId,
      form_version_id: submission.formVersionId,
      session_id: submission.sessionId,
      answers: submission.answers,
      // jsonb takes the JSON text; a JS array would be sent as a Postgres array.
      consents: JSON.stringify(submission.consents) as unknown as unknown[],
      receipt_id: submission.receiptId,
      received_at: submission.receivedAt,
    })
    .execute();
  await trx
    .insertInto("submission_requests")
    .values({
      tenant_id: submission.tenantId,
      session_id: submission.sessionId,
      key_hash: request.keyHash,
      request_hash: request.requestHash,
      submission_id: submission.id,
      response_code: 201,
      receipt: request.receipt,
    })
    .execute();
  await trx.updateTable("respondent_sessions").set({ accepted_submission_id: submission.id }).where("id", "=", submission.sessionId).execute();
}
