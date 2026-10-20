import { governanceRepo, type Db } from "@workeasy/database";
import type { ObjectStore } from "@workeasy/files";
import { sql } from "kysely";

/**
 * Ships the deletion ledger (REC-01) to object storage, for installations on
 * a managed database (Aurora/RDS) whose backups are snapshots rather than
 * files on the server. Each run writes the deletions since the previous run,
 * overlapping it, as one JSON-lines object; replay ignores duplicates. After
 * a restore, every object is replayed (docs/backup-and-restore.md).
 */
export interface LedgerShipDeps {
  workerDb: Db;
  store: ObjectStore;
  bucket: string;
  /** Prefix for ledger objects. */
  prefix?: string;
}

/** Deletions are stamped with their transaction's start, so one committing during an export can be older than it. */
export const LEDGER_OVERLAP_MS = 15 * 60_000;

export interface LedgerShipper {
  /** Exports deletions since the last run; returns how many entries were written, and where. */
  run(): Promise<{ entries: number; key: string | undefined }>;
}

export function createLedgerShipper(deps: LedgerShipDeps, start = new Date(Date.now() - 24 * 60 * 60_000)): LedgerShipper {
  // On start, look back a day: duplicates are harmless, gaps are not.
  let since = start;
  const prefix = deps.prefix ?? "deletion-ledger";
  return {
    async run() {
      const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(deps.workerDb);
      const startedAt = rows[0]!.now;
      const entries = await governanceRepo.exportDeletionLedger(deps.workerDb, new Date(since.getTime() - LEDGER_OVERLAP_MS).toISOString());
      let key: string | undefined;
      if (entries.length > 0) {
        const stamp = startedAt.toISOString();
        key = `${prefix}/${stamp.slice(0, 4)}/${stamp.slice(5, 7)}/${stamp.slice(8, 10)}/${stamp.replace(/[:.]/g, "-")}.jsonl`;
        await deps.store.put(deps.bucket, key, Buffer.from(entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8"), "application/x-ndjson");
      }
      since = startedAt;
      return { entries: entries.length, key };
    },
  };
}
