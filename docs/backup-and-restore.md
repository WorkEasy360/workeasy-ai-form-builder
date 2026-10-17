# Backup, restore and deletion replay (REC-01)

Targets (docs/06): recovery point 15 minutes or better, recovery time 4 hours or better, and no deleted response coming back after a restore.

## What is backed up

| What | How | Recovery point |
|---|---|---|
| Database | Continuous WAL archiving (a segment at least every 5 minutes) plus a nightly base backup (02:00 UTC, last 7 kept) | 5 minutes or better |
| Deletion ledger | Every deleted form and response, exported every minute as JSON lines | 1 minute |
| Uploaded files | Nightly mirror of the files bucket | 24 hours (see below) |

Everything lands in the `backups` Docker volume (`/var/lib/docker/volumes/workeasy-forms-production_backups/_data` on the server). The `backup` and `file-backup` services in `infra/production/docker-compose.yml` do this; nothing needs scheduling.

**Copy the volume off the server.** A backup on the same disk is lost with the disk. Sync it at least every 5 minutes to storage in another location, for example with `restic` or `rclone` to an object store with versioning, using a key that cannot delete old versions.

Files uploaded since the last nightly mirror are lost if the object storage volume is lost. If that is not acceptable, use a managed object store with versioning and cross-region replication instead of the bundled one.

## Why a deletion ledger

Deleted responses are purged, but a restore brings back the database as it was at the recovery point. Anything deleted after that point would reappear, along with its answers. The ledger is exported every minute to the backup folder, outside the database, so it is always newer than any restorable point. Replaying it before the restored data serves traffic deletes those rows again (keeping their original deletion times), and the worker then purges their content as for any deletion.

Replay is idempotent and ignores entries whose tenant does not match the row, so the whole ledger can be replayed every time.

## Restore drill (quarterly, and after any backup change)

On the server, in the deploy folder:

```sh
./restore-drill.sh
```

It restores the newest base backup and every archived WAL segment into a throwaway database container with no network, replays the ledger, checks that every tenant table still has forced row-level security, and writes `drills/<time>.json`:

```json
{
  "elapsedSeconds": 9,
  "recoverySeconds": 7,
  "baseBackup": "20261017T190011Z",
  "recoveryPoint": "2026-10-17T19:04:10Z",
  "recoveryPointSource": "wal",
  "ledgerEntries": 1,
  "replayed": { "forms": 0, "responses": 0 },
  "counts": { "tenants": 2, "forms": 3, "responses": 0, "responsesAwaitingPurge": 0, "migrations": 23 },
  "tablesWithoutForcedRowSecurity": ""
}
```

Record each drill's report in your operations log. Compare `recoveryPoint` with the time of the last known transaction to measure the actual data loss, and `elapsedSeconds` against the 4-hour target (it grows with database size and the WAL since the last base backup).

### Drill record

| Date | Where | Elapsed | Recovery point | Ledger | Result |
|---|---|---|---|---|---|
| 2026-10-17 | Local rehearsal of the production stack | 9 s | WAL replayed to the last archived change | A form deleted after the last archived WAL segment was deleted again by replay; a second drill with that deletion inside the WAL replayed nothing | Passed |

## Real restore

1. **Stop traffic:** `docker compose stop caddy api worker console respondent`.
2. **Restore:** `KEEP_DRILL=1 ./restore-drill.sh`. Check the report: recovery point, counts, no unprotected tables. The ledger is already replayed.
3. **Swap in the restored data:**
   ```sh
   docker compose stop postgres backup
   docker run --rm -v workeasy-forms-production_postgres-data:/to -v <drill>-data:/from alpine sh -c 'rm -rf /to/* && cp -a /from/. /to/'
   docker rm -f <drill>; docker volume rm <drill>-data
   docker compose up -d postgres backup
   ```
   Keep a copy of the old `postgres-data` volume first if there is any doubt.
4. **Purge before opening:** `docker compose up -d worker` and wait until the console's background jobs are idle and `responsesAwaitingPurge` (rerun the count) is zero.
5. **Open traffic:** `docker compose up -d`. Take a fresh base backup by restarting the `backup` service.
6. **Files:** if object storage was lost too, copy `backups/files/<bucket>` back into the bucket. Purge removes files of responses deleted since the mirror.

## Operational notes

- If the `backup` service is down, PostgreSQL keeps WAL segments it could not archive in its own volume. Watch disk space and `SELECT failed_count, last_failed_wal FROM pg_stat_archiver`.
- On first start, PostgreSQL reports a few failed archive attempts until the backup service prepares the archive folder; they are retried automatically.
