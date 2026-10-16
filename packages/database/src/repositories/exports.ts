import { sql, type Transaction } from "kysely";
import type { Db } from "../client.js";
import type { Database, ExportState } from "../schema.js";

/**
 * Export jobs (docs/04 §7). The API records requests and reads their state
 * in a tenant context; the worker leases them across tenants and records
 * results only through the migration 0011 functions.
 */
type Trx = Transaction<Database>;

export type ReadableClass = "ordinary" | "personal" | "sensitive";

export interface ExportFilters {
  versionId?: string | undefined;
  receivedFrom?: string | undefined;
  receivedTo?: string | undefined;
  answer?: { fieldId: string; op: "eq" | "contains" | "isEmpty" | "isNotEmpty"; value?: string | undefined } | undefined;
}

export interface ExportRecord {
  id: string;
  formId: string;
  requestedBy: string;
  filters: ExportFilters;
  cutoff: Date;
  readableClasses: ReadableClass[];
  raw: boolean;
  state: ExportState;
  failureCode: string | null;
  rowCount: number | null;
  bytes: number | null;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
}

const COLUMNS = [
  "id",
  "form_id",
  "requested_by",
  "filter_snapshot",
  "cutoff",
  "readable_classes",
  "raw",
  "state",
  "failure_code",
  "row_count",
  "bytes",
  "created_at",
  "completed_at",
  "expires_at",
] as const;

function toRecord(row: {
  id: string;
  form_id: string;
  requested_by: string;
  filter_snapshot: Record<string, unknown>;
  cutoff: Date;
  readable_classes: string[];
  raw: boolean;
  state: ExportState;
  failure_code: string | null;
  row_count: number | null;
  bytes: number | null;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
}): ExportRecord {
  return {
    id: row.id,
    formId: row.form_id,
    requestedBy: row.requested_by,
    filters: row.filter_snapshot as ExportFilters,
    cutoff: row.cutoff,
    readableClasses: row.readable_classes as ReadableClass[],
    raw: row.raw,
    state: row.state,
    failureCode: row.failure_code,
    rowCount: row.row_count,
    bytes: row.bytes,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

export interface NewExport {
  id: string;
  tenantId: string;
  formId: string;
  requestedBy: string;
  filters: ExportFilters;
  /** Full-precision timestamp text from the database clock. */
  cutoff: string;
  readableClasses: ReadableClass[];
  raw: boolean;
}

export async function createExport(trx: Trx, input: NewExport): Promise<ExportRecord> {
  await trx
    .insertInto("exports")
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      form_id: input.formId,
      requested_by: input.requestedBy,
      filter_snapshot: JSON.parse(JSON.stringify(input.filters)) as Record<string, unknown>,
      cutoff: sql<Date>`${input.cutoff}::timestamptz`,
      readable_classes: sql<string[]>`${input.readableClasses}::text[]`,
      raw: input.raw,
    })
    .execute();
  return (await getExport(trx, input.id))!;
}

export async function getExport(trx: Trx, exportId: string): Promise<ExportRecord | undefined> {
  const row = await trx.selectFrom("exports").select(COLUMNS).where("id", "=", exportId).executeTakeFirst();
  return row ? toRecord(row) : undefined;
}

/** The requester's own recent exports of a form, newest first. */
export async function listOwnExports(trx: Trx, formId: string, userId: string, limit: number): Promise<ExportRecord[]> {
  const rows = await trx
    .selectFrom("exports")
    .select(COLUMNS)
    .where("form_id", "=", formId)
    .where("requested_by", "=", userId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map(toRecord);
}

// Worker ------------------------------------------------------------------------

export interface ExportJob {
  exportId: string;
  tenantId: string;
  formId: string;
  requestedBy: string;
  filters: ExportFilters;
  cutoff: Date;
  readableClasses: ReadableClass[];
  raw: boolean;
  /** Lease token for finishExport. */
  attempt: number;
}

export async function claimExportJobs(db: Db, limit: number, leaseSeconds: number): Promise<ExportJob[]> {
  const { rows } = await sql<{
    export_id: string;
    tenant_id: string;
    form_id: string;
    requested_by: string;
    filter_snapshot: ExportFilters;
    cutoff: Date;
    readable_classes: ReadableClass[];
    raw: boolean;
    attempt: number;
  }>`SELECT * FROM app.claim_export_jobs(${limit}::integer, ${leaseSeconds}::integer)`.execute(db);
  return rows.map((r) => ({
    exportId: r.export_id,
    tenantId: r.tenant_id,
    formId: r.form_id,
    requestedBy: r.requested_by,
    filters: r.filter_snapshot,
    cutoff: r.cutoff,
    readableClasses: r.readable_classes,
    raw: r.raw,
    attempt: r.attempt,
  }));
}

export type ExportOutcome =
  | { outcome: "succeeded"; rows: number; bytes: number }
  | { outcome: "failed"; code: "access_revoked" | "form_unavailable" | "error" }
  | { outcome: "retry" };

export async function finishExport(db: Db, job: ExportJob, result: ExportOutcome): Promise<boolean> {
  const rows = result.outcome === "succeeded" ? result.rows : null;
  const bytes = result.outcome === "succeeded" ? result.bytes : null;
  const code = result.outcome === "failed" ? result.code : null;
  const res = await sql<{ ok: boolean | null }>`
    SELECT app.finish_export(${job.exportId}::uuid, ${job.attempt}::integer, ${result.outcome}, ${rows}::integer, ${bytes}::integer, ${code}) AS ok`.execute(db);
  return res.rows[0]?.ok === true;
}

export async function expireExports(db: Db, limit: number): Promise<string[]> {
  const { rows } = await sql<{ export_id: string }>`SELECT export_id FROM app.expire_exports(${limit}::integer)`.execute(db);
  return rows.map((r) => r.export_id);
}
