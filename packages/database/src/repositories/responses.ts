import { sql, type Transaction } from "kysely";
import type { Database } from "../schema.js";

/**
 * Reading stored responses (docs/04 §7), as the API role in a tenant
 * context. Lists use keyset pagination on (received_at, id), newest first,
 * bounded by a cutoff fixed when the first page is read, so paging through
 * a form that keeps receiving responses never repeats or skips one.
 * Masking by field classification is the caller's job and happens before
 * anything leaves the API.
 */
type Trx = Transaction<Database>;

export interface ResponseRow {
  id: string;
  formVersionId: string;
  sessionId: string;
  receivedAt: Date;
  /** Full-precision timestamp text, for an exact cursor. */
  receivedAtKey: string;
  answers: Record<string, unknown>;
  consents: unknown[];
  receiptId: string;
}

export type AnswerFilterOp = "eq" | "contains" | "isEmpty" | "isNotEmpty";

export interface ListResponsesOptions {
  limit: number;
  /** Only responses received at or before this instant (full-precision text). */
  cutoff: string;
  after?: { receivedAt: string; id: string } | undefined;
  versionId?: string | undefined;
  receivedFrom?: Date | undefined;
  receivedTo?: Date | undefined;
  /** One answer filter on a field ID the caller has already allowed. */
  answer?: { fieldId: string; op: AnswerFilterOp; value?: string | undefined } | undefined;
}

/** The database clock as full-precision text: the cutoff for a new listing. */
export async function currentCutoff(trx: Trx): Promise<string> {
  const { rows } = await sql<{ now: string }>`SELECT now()::text AS now`.execute(trx);
  return rows[0]!.now;
}

function toRow(row: {
  id: string;
  form_version_id: string;
  session_id: string;
  received_at: Date;
  received_at_key: string;
  answers: Record<string, unknown>;
  consents: unknown[];
  receipt_id: string;
}): ResponseRow {
  return {
    id: row.id,
    formVersionId: row.form_version_id,
    sessionId: row.session_id,
    receivedAt: row.received_at,
    receivedAtKey: row.received_at_key,
    answers: row.answers,
    consents: row.consents,
    receiptId: row.receipt_id,
  };
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A page of responses plus whether more follow. Values in filters are always parameters. */
export async function listResponses(trx: Trx, formId: string, options: ListResponsesOptions): Promise<{ rows: ResponseRow[]; more: boolean }> {
  let query = trx
    .selectFrom("submissions")
    .select(["id", "form_version_id", "session_id", "received_at", "answers", "consents", "receipt_id", sql<string>`received_at::text`.as("received_at_key")])
    .where("form_id", "=", formId)
    .where("deleted_at", "is", null)
    .where(sql<boolean>`received_at <= ${options.cutoff}::timestamptz`);
  if (options.after) query = query.where(sql<boolean>`(received_at, id) < (${options.after.receivedAt}::timestamptz, ${options.after.id}::uuid)`);
  if (options.versionId) query = query.where("form_version_id", "=", options.versionId);
  if (options.receivedFrom) query = query.where("received_at", ">=", options.receivedFrom);
  if (options.receivedTo) query = query.where("received_at", "<", options.receivedTo);
  const filter = options.answer;
  if (filter) {
    const { fieldId } = filter;
    if (filter.op === "isEmpty") query = query.where(sql<boolean>`NOT jsonb_exists(answers, ${fieldId})`);
    else if (filter.op === "isNotEmpty") query = query.where(sql<boolean>`jsonb_exists(answers, ${fieldId})`);
    else if (filter.op === "contains") {
      // Text, or any element of a multi-value answer, containing the value (case-insensitive).
      const pattern = `%${escapeLike(filter.value ?? "")}%`;
      query = query.where(
        sql<boolean>`(
          (jsonb_typeof(answers -> ${fieldId}) = 'string' AND (answers ->> ${fieldId}) ILIKE ${pattern} ESCAPE '\\')
          OR (jsonb_typeof(answers -> ${fieldId}) = 'array' AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(answers -> ${fieldId}) AS e(v) WHERE e.v ILIKE ${pattern} ESCAPE '\\'))
          OR (jsonb_typeof(answers -> ${fieldId}) = 'object' AND EXISTS (
                SELECT 1 FROM jsonb_each_text(answers -> ${fieldId}) AS p(k, v) WHERE p.v ILIKE ${pattern} ESCAPE '\\'))
        )`,
      );
    } else {
      // Equal to the value (as text), or a multi-value answer that includes it.
      const value = filter.value ?? "";
      query = query.where(
        sql<boolean>`(
          (jsonb_typeof(answers -> ${fieldId}) IN ('string', 'number', 'boolean') AND (answers ->> ${fieldId}) = ${value})
          OR (jsonb_typeof(answers -> ${fieldId}) = 'array' AND (answers -> ${fieldId}) ? ${value})
        )`,
      );
    }
  }
  const rows = await query.orderBy("received_at", "desc").orderBy("id", "desc").limit(options.limit + 1).execute();
  return { rows: rows.slice(0, options.limit).map(toRow), more: rows.length > options.limit };
}

export async function countResponses(trx: Trx, formId: string, cutoff: string): Promise<number> {
  const row = await trx
    .selectFrom("submissions")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("form_id", "=", formId)
    .where("deleted_at", "is", null)
    .where(sql<boolean>`received_at <= ${cutoff}::timestamptz`)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function getResponse(trx: Trx, formId: string, submissionId: string): Promise<(ResponseRow & { actor: { id: string; displayName: string | null } | null }) | undefined> {
  const row = await trx
    .selectFrom("submissions as s")
    .innerJoin("respondent_sessions as rs", "rs.id", "s.session_id")
    .leftJoin("users as u", "u.id", "rs.actor_id")
    .select([
      "s.id",
      "s.form_version_id",
      "s.session_id",
      "s.received_at",
      "s.answers",
      "s.consents",
      "s.receipt_id",
      sql<string>`s.received_at::text`.as("received_at_key"),
      "rs.actor_id",
      "u.display_name",
    ])
    .where("s.form_id", "=", formId)
    .where("s.id", "=", submissionId)
    .where("s.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return undefined;
  return { ...toRow(row), actor: row.actor_id ? { id: row.actor_id, displayName: row.display_name ?? null } : null };
}

export interface VersionDefinition {
  id: string;
  versionNumber: number;
  definition: Record<string, unknown>;
  active: boolean;
}

/** The form's versions (newest first), for labels and classifications across versions. */
export async function formVersions(trx: Trx, formId: string): Promise<VersionDefinition[]> {
  const rows = await trx
    .selectFrom("form_versions as v")
    .innerJoin("forms as f", "f.id", "v.form_id")
    .select(["v.id", "v.version_number", "v.definition", sql<boolean>`v.id = f.active_version_id`.as("active")])
    .where("v.form_id", "=", formId)
    .orderBy("v.version_number", "desc")
    .execute();
  return rows.map((r) => ({ id: r.id, versionNumber: r.version_number, definition: r.definition, active: r.active }));
}

export interface AttachedFile {
  uploadId: string;
  fieldId: string;
  fileName: string;
  bytes: number | null;
  contentType: string | null;
}

/** Clean files claimed by these submissions. */
export async function filesFor(trx: Trx, submissionIds: readonly string[]): Promise<Map<string, AttachedFile[]>> {
  const result = new Map<string, AttachedFile[]>();
  if (submissionIds.length === 0) return result;
  const rows = await trx
    .selectFrom("file_uploads")
    .select(["id", "field_id", "file_name", "bytes", "detected_type", "claimed_submission_id"])
    .where("claimed_submission_id", "in", [...submissionIds])
    .where("state", "=", "clean")
    .orderBy("created_at")
    .execute();
  for (const r of rows) {
    const list = result.get(r.claimed_submission_id!) ?? [];
    list.push({ uploadId: r.id, fieldId: r.field_id, fileName: r.file_name, bytes: r.bytes, contentType: r.detected_type });
    result.set(r.claimed_submission_id!, list);
  }
  return result;
}
