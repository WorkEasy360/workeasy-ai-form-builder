#!/bin/sh
# Backup loop (REC-01), run by the "backup" service in docker-compose.yml.
# It shares the database container's network, so it connects on 127.0.0.1,
# where the image allows replication connections.
#
#   /backups/wal/        WAL segments, archived by PostgreSQL itself (every 5 min at most)
#   /backups/base/<ts>/  nightly base backups (BASE_BACKUP_HOUR, UTC); BASE_BACKUPS_KEPT are kept
#   /backups/ledger/     deletion ledger, exported every minute (JSON lines)
#
# Copy /backups off this server (docs/backup-and-restore.md); a backup on
# the same disk does not survive losing the disk.
set -eu

: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}"
BASE_BACKUP_HOUR=${BASE_BACKUP_HOUR:-2}
BASE_BACKUPS_KEPT=${BASE_BACKUPS_KEPT:-7}
# Deletions are stamped with their transaction's start time, so one still
# committing during an export can carry an earlier time. Each export
# overlaps the previous one by this much; replay ignores duplicates.
LEDGER_OVERLAP=${LEDGER_OVERLAP:-15 minutes}

export PGHOST=127.0.0.1 PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB"
mkdir -p /backups/base /backups/ledger /backups/wal
chown postgres:postgres /backups/wal

log() { echo "$(date -u +%FT%TZ) backup: $*"; }

until pg_isready -q; do sleep 2; done

base_backup() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  log "base backup $ts starting"
  # Marks when the backup began: restoring it needs every WAL segment archived after this.
  touch "/backups/base/$ts.started"
  # WAL comes from the archive; -X none keeps the backup small.
  pg_basebackup -D "/backups/base/$ts.partial" -Ft -z -X none --checkpoint=fast
  mv "/backups/base/$ts.partial" "/backups/base/$ts"
  log "base backup $ts done ($(du -sh "/backups/base/$ts" | cut -f1))"
  # Keep the newest BASE_BACKUPS_KEPT; drop WAL archived before the oldest kept one began.
  for old in $(ls -1d /backups/base/*Z 2>/dev/null | sort -r | tail -n "+$((BASE_BACKUPS_KEPT + 1))"); do
    rm -rf "$old" "$old.started"
  done
  oldest=$(ls -1d /backups/base/*Z | sort | head -n 1)
  find /backups/wal -type f ! -newer "$oldest.started" -delete
}

export_ledger() {
  since_file=/backups/ledger/.last-export
  since=$( [ -f "$since_file" ] && cat "$since_file" || echo "-infinity" )
  started=$(psql -Atc "SELECT now()")
  psql -Atc "SELECT row_to_json(l) FROM app.deletion_ledger('$since'::timestamptz - interval '$LEDGER_OVERLAP') l" \
    >> "/backups/ledger/ledger-$(date -u +%Y-%m).jsonl"
  echo "$started" > "$since_file"
}

# A first base backup at once, so restores work from day one.
[ -n "$(ls -1d /backups/base/*Z 2>/dev/null)" ] || base_backup
last_base_day=$(date -u +%F)
while :; do
  export_ledger || log "ledger export failed; retrying in a minute"
  if [ "$(date -u +%F)" != "$last_base_day" ] && [ "$(date -u +%H)" -ge "$BASE_BACKUP_HOUR" ]; then
    base_backup && last_base_day=$(date -u +%F) || log "base backup failed; retrying in a minute"
  fi
  sleep 60
done
