import { createHash, randomUUID } from "node:crypto";
import { intakeRepo, publicFormsRepo, publishRepo, uploadsRepo, withTenant, type Db, type RespondentSession, type Unavailable, type Upload } from "@workeasy/database";
import { SUBMISSION_ACCEPTED_V1, submissionAcceptedV1 } from "@workeasy/events";
import { canonicalJson, evaluate } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import type { FieldError } from "./http/problem.js";

/**
 * The intake transaction (docs/04 §5): one tenant transaction that either
 * stores exactly one response, its idempotency record and its outbox event,
 * or changes nothing. Success is reported only after commit.
 */

export interface Receipt {
  submissionId: string;
  receiptId: string;
  receivedAt: string;
  intakeState: "accepted";
  /** The form's message after submitting. */
  message: string;
  /** Consents given, with the version of the wording shown. */
  consents: Array<{ fieldId: string; consentTextVersion: string | null }>;
}

export type IntakeOutcome =
  | { kind: "accepted"; receipt: Receipt }
  /** Same key, same request: the recorded receipt, with nothing stored again. */
  | { kind: "replayed"; status: number; receipt: Receipt }
  /** The session already submitted under another key: its receipt, not a second response. */
  | { kind: "already_submitted"; receipt: Receipt }
  | { kind: "idempotency_conflict" }
  | { kind: "session_invalid" }
  | { kind: "version_mismatch" }
  /** Closed, outside its schedule, full, over the tenant's quota, or gone. */
  | { kind: "unavailable"; reason: Unavailable; opensAt?: Date | undefined }
  | { kind: "access_revoked" }
  /** Spam checks failed (honeypot filled in, or submitted too fast). Nothing is stored. */
  | { kind: "blocked" }
  | { kind: "invalid"; errors: FieldError[] };

/** Faster than this after opening the form is not a person filling it in. */
export const DEFAULT_MIN_FILL_MS = 2000;

export interface IntakeRequest {
  session: RespondentSession;
  idempotencyKey: string;
  /** The hidden field people never see; anything in it means a bot. */
  honeypot?: string | undefined;
  /** The shortest time between opening the form and submitting it, when spam checks are on. */
  minFillMs?: number;
  formVersionId: string;
  answers: Record<string, unknown>;
  requestId?: string | undefined;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** Equal requests hash equally whatever their key order; the key itself is hashed separately. */
export function requestDigest(formVersionId: string, answers: Record<string, unknown>): Buffer {
  return sha256(canonicalJson({ formVersionId, answers }));
}

/** Why an attached upload cannot be submitted, in respondent terms. */
function uploadProblem(upload: Upload | undefined, fieldId: string): FieldError | undefined {
  const field = `answers.${fieldId}`;
  if (!upload || upload.fieldId !== fieldId || upload.claimedSubmissionId) {
    return { field, code: "FILE_NOT_FOUND", message: "One of the files is no longer available. Upload it again." };
  }
  if (upload.state === "clean") return undefined;
  if (upload.state === "infected") return { field, code: "FILE_INFECTED", message: "A file was blocked by the virus check. Remove it to continue." };
  if (upload.state === "rejected") {
    return { field, code: "FILE_REJECTED", message: "A file's content doesn't match its type, or it is too large. Remove it to continue." };
  }
  if (upload.state === "expired") return { field, code: "FILE_EXPIRED", message: "A file has expired. Upload it again." };
  return { field, code: "FILE_PENDING", message: "A file is still being checked. Try again in a moment." };
}

/** Raised by app.claim_uploads when a file was claimed or changed after it was checked. */
const isClaimRace = (err: unknown) => err instanceof Error && /UPLOAD_NOT_CLAIMABLE/.test(err.message);

export async function intake(publicDb: Db, request: IntakeRequest): Promise<IntakeOutcome> {
  try {
    return await intakeTransaction(publicDb, request);
  } catch (err) {
    if (!isClaimRace(err)) throw err;
    // Nothing was stored: the transaction rolled back. The respondent can retry.
    return { kind: "invalid", errors: [{ field: "answers", code: "FILE_NOT_FOUND", message: "One of the files changed while sending. Try again." }] };
  }
}

function intakeTransaction(publicDb: Db, request: IntakeRequest): Promise<IntakeOutcome> {
  const { session } = request;
  const keyHash = sha256(request.idempotencyKey);
  const requestHash = requestDigest(request.formVersionId, request.answers);

  return withTenant(publicDb, session.tenantId, async (trx): Promise<IntakeOutcome> => {
    // 1. Every request for this session waits here, so retries and races are decided one at a time.
    const locked = await intakeRepo.lockSession(trx, session.id);
    if (!locked) return { kind: "session_invalid" };

    // 2. A key already used for this session: replay its receipt, or refuse different content.
    const recorded = await intakeRepo.findRequest(trx, session.id, keyHash);
    if (recorded) {
      return recorded.requestHash.equals(requestHash)
        ? { kind: "replayed", status: recorded.responseCode, receipt: recorded.receipt as unknown as Receipt }
        : { kind: "idempotency_conflict" };
    }

    // 3. One response per session, whatever key a later request uses.
    if (locked.acceptedSubmissionId) {
      const receipt = await intakeRepo.receiptFor(trx, locked.acceptedSubmissionId);
      if (!receipt) throw new Error(`Submission ${locked.acceptedSubmissionId} has no receipt`);
      return { kind: "already_submitted", receipt: receipt as unknown as Receipt };
    }

    // 4. The session's version, never one the browser picks.
    if (request.formVersionId !== locked.formVersionId) return { kind: "version_mismatch" };

    // 5. The form's current state and policy, locked until commit so a concurrent close waits for us.
    const form = await intakeRepo.lockForm(trx, locked.formId);
    const acceptance = await publicFormsRepo.judgeAcceptance(trx, form, { tenantId: session.tenantId, actorId: locked.actorId });
    if (!acceptance.accepting) {
      return acceptance.reason === "access_revoked" ? { kind: "access_revoked" } : { kind: "unavailable", reason: acceptance.reason, opensAt: acceptance.opensAt };
    }

    // 5b. Spam checks, when the form has them on: the hidden field must be empty, and
    // the form must have been open long enough for a person to fill it in.
    if (await intakeRepo.spamProtection(trx, locked.formId)) {
      if ((request.honeypot ?? "") !== "" || locked.ageMs < (request.minFillMs ?? DEFAULT_MIN_FILL_MS)) return { kind: "blocked" };
    }

    // 6. The same engine the browser ran, against the pinned version.
    const projection = await intakeRepo.versionProjection(trx, locked.formId, locked.formVersionId);
    if (!projection) throw new Error(`Version ${locked.formVersionId} is missing`);
    const definition = projection as unknown as FormDefinition;
    const evaluation = evaluate(definition, request.answers);
    if (evaluation.errors.length > 0) {
      return { kind: "invalid", errors: evaluation.errors.map((e) => ({ field: e.fieldId ? `answers.${e.fieldId}` : "answers", code: e.code, message: e.message })) };
    }

    // 6b. Files: every attached upload must be this session's, for that field, scanned clean and unclaimed.
    const fileClaims = definition.fields
      .filter((f) => f.type === "file" && Array.isArray(evaluation.answers[f.id]))
      .flatMap((f) => (evaluation.answers[f.id] as string[]).map((uploadId) => ({ uploadId, fieldId: f.id })));
    if (fileClaims.length > 0) {
      const uploads = new Map((await uploadsRepo.uploadsByIds(trx, session.id, fileClaims.map((c) => c.uploadId))).map((u) => [u.id, u]));
      const problems = fileClaims.flatMap((c) => uploadProblem(uploads.get(c.uploadId), c.fieldId) ?? []);
      if (problems.length > 0) return { kind: "invalid", errors: problems };
    }

    // 7. Reserve against the form's limit and the tenant's quota; only valid answers count (docs/04 §5).
    const reserved = await intakeRepo.reserveResponse(trx, locked.formId);
    if (reserved !== "ok") return { kind: "unavailable", reason: reserved === "form_full" ? "full" : "quota" };

    // 8. Store the response, its receipt, the session's accepted marker and the event together.
    const receivedAt = await intakeRepo.transactionTime(trx);
    const submissionId = randomUUID();
    const consents = definition.fields
      .filter((f) => f.type === "consent" && evaluation.answers[f.id] === true)
      .map((f) => ({ fieldId: f.id, consentTextVersion: f.settings.consentTextVersion ?? null }));
    const receipt: Receipt = {
      submissionId,
      receiptId: randomUUID(),
      receivedAt: receivedAt.toISOString(),
      intakeState: "accepted",
      message: definition.success.message,
      consents,
    };
    await intakeRepo.insertSubmission(
      trx,
      {
        id: submissionId,
        tenantId: session.tenantId,
        formId: locked.formId,
        formVersionId: locked.formVersionId,
        sessionId: session.id,
        answers: evaluation.answers as Record<string, unknown>,
        consents,
        receiptId: receipt.receiptId,
        receivedAt,
      },
      { keyHash, requestHash, receipt: receipt as unknown as Record<string, unknown> },
    );
    // Claimed all or nothing; a race with another claim rolls the whole intake back.
    await uploadsRepo.claimUploads(trx, session.id, submissionId, fileClaims);
    const event = submissionAcceptedV1({
      eventId: randomUUID(),
      occurredAt: receivedAt,
      tenantId: session.tenantId,
      traceId: request.requestId,
      data: { formId: locked.formId, formVersionId: locked.formVersionId, submissionId, submissionRevision: 1 },
    });
    await publishRepo.appendOutbox(trx, {
      id: event.eventId,
      tenantId: session.tenantId,
      eventType: SUBMISSION_ACCEPTED_V1,
      aggregateId: event.aggregateId,
      occurredAt: receivedAt,
      payload: { ...event.data },
      traceId: request.requestId,
    });
    return { kind: "accepted", receipt };
  });
}
