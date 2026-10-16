import { Readable } from "node:stream";
import { uploadsRepo, withTenant, type Db, type ScanJob, type ScanOutcome } from "@workeasy/database";
import type { FormDefinition } from "@workeasy/form-schema";
import { detectType, SNIFF_BYTES } from "./detect.js";
import { scanStream, ScannerUnavailableError, type ScannerConfig } from "./scanner.js";
import type { ObjectStore } from "./storage.js";

/**
 * Background processing of uploads (docs/06 §3), run by the worker with the
 * worker database role. Each upload is checked, in order: it suits its field
 * (size and allowed types, from the pinned version), its bytes really are
 * the declared type, and the malware scanner finds nothing. Clean files move
 * to the clean bucket; refused files are deleted. When the scanner cannot be
 * reached the upload goes back in the queue: nothing is ever passed unscanned.
 */
export interface ScanDeps {
  workerDb: Db;
  store: ObjectStore;
  scanner: ScannerConfig;
  log?: (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
}

/** Each lease must outlast one scan of the largest file. */
export const SCAN_LEASE_SECONDS = 120;

async function readAll(body: Readable, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += (chunk as Buffer).length;
    if (total > limit) {
      body.destroy();
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function fieldSettings(workerDb: Db, job: ScanJob) {
  const row = await withTenant(workerDb, job.tenantId, (trx) =>
    trx.selectFrom("form_versions").select("public_projection").where("id", "=", job.formVersionId).where("form_id", "=", job.formId).executeTakeFirst(),
  );
  const field = (row?.public_projection as unknown as FormDefinition | undefined)?.fields.find((f) => f.id === job.fieldId && f.type === "file");
  return field ? { allowed: field.settings.allowedMimeTypes ?? [], maxBytes: field.settings.maxFileBytes ?? 0 } : undefined;
}

/** Decides one leased upload; returns what was recorded. */
export async function processScanJob(deps: ScanDeps, job: ScanJob): Promise<ScanOutcome> {
  const { store } = deps;
  const settings = await fieldSettings(deps.workerDb, job);
  const refuse = async (outcome: ScanOutcome): Promise<ScanOutcome> => {
    await store.remove(store.quarantineBucket, job.storageKey);
    await uploadsRepo.finishScan(deps.workerDb, job, outcome);
    return outcome;
  };
  if (!settings) return refuse({ outcome: "rejected", detectedType: null, reason: "type_mismatch" });

  const info = await store.head(store.quarantineBucket, job.storageKey);
  if (!info || info.bytes !== job.declaredBytes) return refuse({ outcome: "rejected", detectedType: null, reason: "size_mismatch" });
  if (info.bytes > settings.maxBytes) return refuse({ outcome: "rejected", detectedType: null, reason: "too_large" });

  const bytes = await readAll(await store.read(store.quarantineBucket, job.storageKey), settings.maxBytes);
  if (!bytes) return refuse({ outcome: "rejected", detectedType: null, reason: "too_large" });

  // The content decides the type, not the name or the declared header.
  const detected = detectType(bytes.subarray(0, SNIFF_BYTES), job.declaredType);
  if (detected !== job.declaredType || !settings.allowed.includes(detected)) {
    return refuse({ outcome: "rejected", detectedType: detected, reason: "type_mismatch" });
  }

  let verdict;
  try {
    verdict = await scanStream(deps.scanner, Readable.from([bytes]));
  } catch (err) {
    if (!(err instanceof ScannerUnavailableError)) throw err;
    // Keep it pending; the next run retries. Never treat an unscanned file as clean.
    deps.log?.("warn", "scanner unavailable; upload stays pending", { uploadId: job.uploadId, attempt: job.attempt });
    const retry: ScanOutcome = { outcome: "retry" };
    await uploadsRepo.finishScan(deps.workerDb, job, retry);
    return retry;
  }
  if (verdict.status === "infected") {
    // The signature name is logged for operators; the respondent only learns the file was blocked.
    deps.log?.("warn", "upload blocked by malware scan", { uploadId: job.uploadId, signature: verdict.signature });
    return refuse({ outcome: "infected" });
  }
  await store.promote(job.storageKey);
  const clean: ScanOutcome = { outcome: "clean", detectedType: detected };
  await uploadsRepo.finishScan(deps.workerDb, job, clean);
  return clean;
}

/** Leases and processes up to `limit` waiting uploads; returns how many were handled. */
export async function scanPendingUploads(deps: ScanDeps, limit = 10): Promise<number> {
  const jobs = await uploadsRepo.claimScanJobs(deps.workerDb, limit, SCAN_LEASE_SECONDS);
  for (const job of jobs) {
    try {
      await processScanJob(deps, job);
    } catch (err) {
      // Storage or database trouble: the lease runs out and another run picks the upload up again.
      deps.log?.("error", "upload scan failed; will retry after the lease", { uploadId: job.uploadId, err });
    }
  }
  return jobs.length;
}

/** Deletes uploads nobody claimed within 24 hours (docs/06 §3); returns how many. */
export async function expireStaleUploads(deps: Pick<ScanDeps, "workerDb" | "store" | "log">, limit = 100): Promise<number> {
  const expired = await uploadsRepo.expireUploads(deps.workerDb, limit);
  for (const upload of expired) {
    const bucket = upload.previousState === "clean" ? deps.store.cleanBucket : deps.store.quarantineBucket;
    try {
      await deps.store.remove(bucket, upload.storageKey);
    } catch (err) {
      deps.log?.("warn", "could not delete an expired upload's object", { uploadId: upload.uploadId, err });
    }
  }
  return expired.length;
}
