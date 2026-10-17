import { formPermissions, isFormPermission } from "@workeasy/auth";
import { exportsRepo, orgRepo, responsesRepo, withContext, type AttachedFile, type Db, type ExportJob, type ExportOutcome, type ResponseRow } from "@workeasy/database";
import type { ObjectStore } from "@workeasy/files";
import { FIELD_REGISTRY, privacyOf } from "@workeasy/form-engine";
import { sql } from "kysely";
import type { Field } from "@workeasy/form-schema";
import { csvRow, UTF8_BOM } from "./csv.js";
import { displayAnswer, indexVersions, readableClasses, shortReceipt, type VersionIndex } from "./presentation.js";

/**
 * Building CSV exports in the worker (docs/04 §7). The requester's access is
 * checked again before any data is read: an export made by someone who has
 * since lost response access, or whose cleared field classes shrank, fails
 * instead of producing a file. Rows are read in bounded keyset batches up to
 * the cutoff recorded with the request.
 */
export interface ExportDeps {
  workerDb: Db;
  store: ObjectStore;
  log?: (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
}

export const EXPORT_LEASE_SECONDS = 300;
const BATCH = 500;

/**
 * Raw values for machines: lists joined with ";", name and address parts as
 * JSON in the question's part order (the database does not keep key order).
 */
function rawValue(value: unknown, field: Field): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(";");
  if (typeof value === "object") {
    const parts = FIELD_REGISTRY[field.type].parts ?? [];
    const record = value as Record<string, string>;
    return JSON.stringify(Object.fromEntries(parts.filter((p) => p.key in record).map((p) => [p.key, record[p.key]])));
  }
  return String(value);
}

function header(columns: readonly Field[], raw: boolean): string[] {
  return raw ? ["submission_id", "received_at", "version", ...columns.map((f) => f.id)] : ["Receipt no.", "Received (UTC)", "Version", ...columns.map((f) => f.label)];
}

function row(record: ResponseRow, versions: VersionIndex, columns: readonly Field[], files: Map<string, AttachedFile[]>, raw: boolean): string[] {
  const version = versions.byId.get(record.formVersionId)!;
  const own = new Map(version.definition.fields.map((f) => [f.id, f]));
  const cells = columns.map((column) => {
    const field = own.get(column.id);
    const value = record.answers[column.id];
    if (!field || value === undefined) return "";
    return raw ? rawValue(value, field) : displayAnswer(field, value, files.get(record.id) ?? []);
  });
  return raw
    ? [record.id, record.receivedAt.toISOString(), String(version.versionNumber), ...cells]
    : [shortReceipt(record.receiptId), record.receivedAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, ""), String(version.versionNumber), ...cells];
}

/** Decides one leased export; returns what was recorded. */
export async function runExportJob(deps: ExportDeps, job: ExportJob): Promise<ExportOutcome> {
  const built = await withContext(deps.workerDb, { tenantId: job.tenantId, userId: job.requestedBy }, async (trx) => {
    // 1. Access, as of now: still a member, still allowed to export, still cleared for every class asked for.
    const form = await orgRepo.getFormSummary(trx, job.formId);
    if (!form) return { failed: "form_unavailable" as const };
    const membership = await orgRepo.getMembership(trx, job.requestedBy);
    const grants = (await orgRepo.listUserFormGrants(trx, job.formId, job.requestedBy)).filter(isFormPermission);
    const permissions = formPermissions(membership, grants);
    const readable = readableClasses(permissions);
    if (!permissions.has("responses.export") || !permissions.has("responses.read") || job.readableClasses.some((c) => !readable.has(c))) {
      return { failed: "access_revoked" as const };
    }

    // 2. Columns: fields of every version, limited to the classes recorded with the request.
    const versions = indexVersions(await responsesRepo.formVersions(trx, job.formId));
    const allowed = new Set(job.readableClasses);
    const columns = versions.order.map((id) => versions.latestField.get(id)!).filter((f) => allowed.has(privacyOf(f)));

    // 3. Rows up to the recorded cutoff, newest first, in bounded batches.
    // Full precision, so the file holds exactly the responses up to the cutoff the requester saw.
    const cutoff = (await sql<{ cutoff: string }>`SELECT cutoff::text AS cutoff FROM app.exports WHERE id = ${job.exportId}`.execute(trx)).rows[0]!.cutoff;
    const filters = job.filters;
    let text = (job.raw ? "" : UTF8_BOM) + csvRow(header(columns, job.raw), job.raw);
    let count = 0;
    let after: { receivedAt: string; id: string } | undefined;
    for (;;) {
      const page = await responsesRepo.listResponses(trx, job.formId, {
        limit: BATCH,
        cutoff,
        after,
        versionId: filters.versionId,
        receivedFrom: filters.receivedFrom ? new Date(filters.receivedFrom) : undefined,
        receivedTo: filters.receivedTo ? new Date(filters.receivedTo) : undefined,
        answer: filters.answer,
      });
      const files = await responsesRepo.filesFor(trx, page.rows.map((r) => r.id));
      for (const record of page.rows) text += csvRow(row(record, versions, columns, files, job.raw), job.raw);
      count += page.rows.length;
      const last = page.rows.at(-1);
      if (!page.more || !last) break;
      after = { receivedAt: last.receivedAtKey, id: last.id };
    }
    return { text, count };
  });

  if ("failed" in built) {
    const outcome: ExportOutcome = { outcome: "failed", code: built.failed };
    await exportsRepo.finishExport(deps.workerDb, job, outcome);
    deps.log?.("info", "export refused", { exportId: job.exportId, code: built.failed });
    return outcome;
  }
  const body = Buffer.from(built.text, "utf8");
  await deps.store.put(deps.store.exportsBucket, job.exportId, body, "text/csv; charset=utf-8");
  const outcome: ExportOutcome = { outcome: "succeeded", rows: built.count, bytes: body.length };
  await exportsRepo.finishExport(deps.workerDb, job, outcome);
  return outcome;
}

/** Leases and builds up to `limit` waiting exports; returns how many were handled. */
export async function processExports(deps: ExportDeps, limit = 2): Promise<number> {
  const jobs = await exportsRepo.claimExportJobs(deps.workerDb, limit, EXPORT_LEASE_SECONDS);
  for (const job of jobs) {
    try {
      await runExportJob(deps, job);
    } catch (err) {
      // Storage or database trouble: try again on a later run, a bounded number of times.
      deps.log?.("error", "export failed", { exportId: job.exportId, attempt: job.attempt, err });
      await exportsRepo.finishExport(deps.workerDb, job, job.attempt >= 3 ? { outcome: "failed", code: "error" } : { outcome: "retry" });
    }
  }
  return jobs.length;
}

/** Deletes export files 24 hours after they were ready; returns how many. */
export async function expireOldExports(deps: ExportDeps, limit = 100): Promise<number> {
  const ids = await exportsRepo.expireExports(deps.workerDb, limit);
  for (const id of ids) {
    try {
      await deps.store.remove(deps.store.exportsBucket, id);
    } catch (err) {
      deps.log?.("warn", "could not delete an expired export file", { exportId: id, err });
    }
  }
  return ids.length;
}
