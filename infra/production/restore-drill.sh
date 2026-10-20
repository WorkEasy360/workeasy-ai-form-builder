#!/usr/bin/env bash
# Restore drill (REC-01). Restores the newest base backup plus every archived
# WAL segment into a throwaway PostgreSQL container, isolated from the
# running stack; replays the deletion ledger; checks the result; and writes
# a report with the elapsed time and the actual recovery point to
# drills/<time>.json. The live installation is not touched.
#
#   ./restore-drill.sh            run a drill and remove the restored copy
#   KEEP_DRILL=1 ./restore-drill.sh   keep it (container and volume) for inspection
#
# A real restore follows the same steps; see docs/backup-and-restore.md.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=${COMPOSE_PROJECT_NAME:-workeasy-forms-production}
BACKUPS="${PROJECT}_backups"
IMAGE=postgres:18.6-alpine
DRILL="workeasy-drill-$(date -u +%Y%m%d%H%M%S)"
PGDATA_DIR=/var/lib/postgresql/18/docker
RECOVERY_TIMEOUT=${RECOVERY_TIMEOUT:-3600}

die() { echo "restore-drill: $*" >&2; exit 1; }
[ -f .env ] || die "no .env here"
POSTGRES_USER=$(sed -n 's/^POSTGRES_USER=//p' .env)
POSTGRES_DB=$(sed -n 's/^POSTGRES_DB=//p' .env)
docker volume inspect "$BACKUPS" > /dev/null 2>&1 || die "backup volume $BACKUPS not found"

started_at=$(date -u +%FT%TZ); started=$(date +%s)
cleanup() {
  if [ "${KEEP_DRILL:-}" = 1 ]; then
    echo "kept: container $DRILL and volume $DRILL-data"
  else
    docker rm -f "$DRILL" > /dev/null 2>&1 || true
    docker volume rm "$DRILL-data" > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 1. Lay down the newest base backup with recovery settings.
base=$(docker run --rm -v "$BACKUPS:/backups:ro" "$IMAGE" sh -c 'ls -1d /backups/base/*Z 2>/dev/null | sort | tail -n 1')
[ -n "$base" ] || die "no base backup yet"
echo "restoring $base"
docker volume create "$DRILL-data" > /dev/null
docker run --rm -v "$BACKUPS:/backups:ro" -v "$DRILL-data:/var/lib/postgresql" "$IMAGE" sh -ec "
  mkdir -p $PGDATA_DIR
  tar -xzf '$base/base.tar.gz' -C $PGDATA_DIR
  mkdir -p $PGDATA_DIR/pg_wal
  cat >> $PGDATA_DIR/postgresql.auto.conf <<'CONF'
restore_command = 'cp /backups/wal/%f %p'
recovery_target_action = 'promote'
archive_mode = 'off'
CONF
  touch $PGDATA_DIR/recovery.signal
  chown -R postgres:postgres /var/lib/postgresql
  chmod 700 $PGDATA_DIR"

# 2. Replay WAL to the end of the archive. No network: nothing can reach it.
docker run -d --name "$DRILL" --network none -v "$DRILL-data:/var/lib/postgresql" -v "$BACKUPS:/backups:ro" "$IMAGE" \
  postgres -c archive_mode=off > /dev/null
q() { docker exec -i "$DRILL" psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq "$@"; }
deadline=$((SECONDS + RECOVERY_TIMEOUT))
until [ "$(q -c 'SELECT pg_is_in_recovery()' 2>/dev/null)" = "f" ]; do
  [ $SECONDS -lt $deadline ] || die "recovery did not finish within ${RECOVERY_TIMEOUT}s; see: docker logs $DRILL"
  sleep 3
done
recovered=$(date +%s)
recovery_point=$(q -c "SELECT coalesce(to_char(pg_last_xact_replay_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '')")
recovery_point_source=wal
if [ -z "$recovery_point" ]; then
  # Nothing was replayed after the base backup: the data is as of its start.
  b=$(basename "$base")
  recovery_point="${b:0:4}-${b:4:2}-${b:6:2}T${b:9:2}:${b:11:2}:${b:13:2}Z"
  recovery_point_source=base-backup
fi
echo "recovered to $recovery_point ($recovery_point_source)"

# 3. Replay the deletion ledger before anything could serve this data.
docker exec "$DRILL" sh -c 'cat /backups/ledger/*.jsonl 2>/dev/null | sort -u | { printf "["; paste -sd, -; printf "]"; } > /tmp/ledger.json'
ledger_entries=$(docker exec "$DRILL" sh -c 'cat /backups/ledger/*.jsonl 2>/dev/null | sort -u | grep -c . || true')
replayed=$(q <<'SQL'
\set ledger `cat /tmp/ledger.json`
SELECT forms_deleted || ' ' || responses_deleted FROM app.replay_deletions(:'ledger'::jsonb);
SQL
)
read -r forms_replayed responses_replayed <<< "$replayed"

# 4. Checks: data present, every tenant table still under forced row security.
counts=$(q -c "SELECT json_build_object(
  'tenants', (SELECT count(*) FROM app.tenants),
  'forms', (SELECT count(*) FROM app.forms),
  'responses', (SELECT count(*) FROM app.submissions),
  'responsesAwaitingPurge', (SELECT count(*) FROM app.submissions WHERE deleted_at IS NOT NULL AND purged_at IS NULL),
  'migrations', (SELECT count(*) FROM app.schema_migrations))")
unprotected=$(q -c "SELECT coalesce(string_agg(c.relname, ','), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
  WHERE n.nspname = 'app' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")

finished=$(date +%s)
mkdir -p drills
report="drills/$(date -u +%Y%m%dT%H%M%SZ).json"
cat > "$report" <<JSON
{
  "startedAt": "$started_at",
  "finishedAt": "$(date -u +%FT%TZ)",
  "elapsedSeconds": $((finished - started)),
  "recoverySeconds": $((recovered - started)),
  "baseBackup": "$(basename "$base")",
  "recoveryPoint": "$recovery_point",
  "recoveryPointSource": "$recovery_point_source",
  "ledgerEntries": $ledger_entries,
  "replayed": { "forms": ${forms_replayed:-0}, "responses": ${responses_replayed:-0} },
  "counts": $counts,
  "tablesWithoutForcedRowSecurity": "$unprotected"
}
JSON
cat "$report"
[ -z "$unprotected" ] || die "tenant tables without forced row security: $unprotected"
echo "drill passed; report: $report"
