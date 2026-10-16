import { governanceRepo, withTenant, type Db, type PurgeJob } from "@workeasy/database";
import type { ObjectStore } from "@workeasy/files";

/**
 * Purging deleted responses (docs/04 §7), run by the worker. The stored
 * objects go first (the response's files and every finished export that
 * could contain it); only then is the content cleared in the database. If
 * storage is unavailable the lease runs out and a later run tries again, so
 * the database never claims a purge whose files still exist.
 */
export interface PurgeDeps {
  workerDb: Db;
  store: ObjectStore;
  log?: (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
}

export async function purgeOne(deps: PurgeDeps, job: PurgeJob): Promise<boolean> {
  const targets = await withTenant(deps.workerDb, job.tenantId, (trx) => governanceRepo.purgeTargets(trx, job));
  for (const file of targets.fileKeys) {
    // Claimed files live in the clean bucket; deleting from both covers any state.
    await deps.store.remove(deps.store.cleanBucket, file.key);
    await deps.store.remove(deps.store.quarantineBucket, file.key);
  }
  for (const exportId of targets.exportIds) await deps.store.remove(deps.store.exportsBucket, exportId);
  return governanceRepo.completePurge(deps.workerDb, job.submissionId);
}

/** Purges up to `limit` deleted responses; returns how many were handled. */
export async function purgeDeletedResponses(deps: PurgeDeps, limit = 50): Promise<number> {
  const jobs = await governanceRepo.claimPurges(deps.workerDb, limit);
  for (const job of jobs) {
    try {
      await purgeOne(deps, job);
    } catch (err) {
      deps.log?.("error", "purge failed; will retry after the lease", { submissionId: job.submissionId, err });
    }
  }
  return jobs.length;
}

/** Deletes responses past their form's retention period (the purge then removes them); returns how many. */
export function applyRetention(deps: Pick<PurgeDeps, "workerDb">, limit = 500): Promise<number> {
  return governanceRepo.applyRetention(deps.workerDb, limit);
}
