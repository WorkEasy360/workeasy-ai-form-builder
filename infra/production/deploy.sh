#!/usr/bin/env bash
# Deploys one image to this server and rolls back if it does not come up
# healthy (OPS-01). Run from this directory, which holds docker-compose.yml,
# Caddyfile and .env:
#
#   ./deploy.sh ghcr.io/owner/workeasy-forms:<commit>   deploy a release
#   ./deploy.sh --rollback                               go back to the previous release
#   ./deploy.sh --status                                 show releases and service health
#
# Migrations only ever add (expand/contract, docs/deployment.md), so rolling
# back the application after a migration is safe; the schema stays ahead.
set -euo pipefail
cd "$(dirname "$0")"

RELEASES=releases.log
SERVICES=(api worker console respondent)
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-240}

die() { echo "deploy: $*" >&2; exit 1; }
[ -f .env ] || die "no .env here; create it with ./new-env.sh"
# Only Linux servers have meaningful file modes (rehearsals may run elsewhere).
if [ "$(uname -s)" = Linux ] && [ "$(stat -c %a .env)" != "600" ]; then die ".env must be mode 600 (chmod 600 .env)"; fi

compose() { docker compose --env-file .env "$@"; }
current_image() { sed -n 's/^WORKEASY_IMAGE=//p' .env; }
set_image() {
  local tmp; tmp=$(mktemp .env.XXXX)
  sed "s|^WORKEASY_IMAGE=.*|WORKEASY_IMAGE=$1|" .env > "$tmp" && chmod 600 "$tmp" && mv "$tmp" .env
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) service id state pending
  while :; do
    pending=()
    for service in "${SERVICES[@]}"; do
      id=$(compose ps -q "$service")
      state=$( [ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)
      [ "$state" = "healthy" ] || pending+=("$service:$state")
    done
    [ ${#pending[@]} -eq 0 ] && return 0
    [ $SECONDS -ge $deadline ] && { echo "not healthy after ${HEALTH_TIMEOUT}s: ${pending[*]}" >&2; return 1; }
    sleep 5
  done
}

start() {
  # SKIP_PULL=1 uses images already on this machine (rehearsals with a local build).
  [ "${SKIP_PULL:-}" = 1 ] || compose pull --quiet
  compose --profile migrate run --rm object-storage-init
  compose --profile migrate run --rm migrate
  compose up -d --remove-orphans
}

case "${1:-}" in
  --status)
    tail -n 10 "$RELEASES" 2>/dev/null || echo "no releases yet"
    compose ps
    ;;
  --rollback)
    previous=$({ grep ' deployed ' "$RELEASES" 2>/dev/null || true; } | tail -n 2 | head -n 1 | awk '{print $3}')
    [ -n "$previous" ] && [ "$previous" != "$(current_image)" ] || die "no earlier release to roll back to"
    echo "rolling back to $previous"
    set_image "$previous"
    compose up -d --remove-orphans
    wait_healthy || die "rollback did not become healthy; check: docker compose logs"
    echo "$(date -u +%FT%TZ) deployed $previous (rollback)" >> "$RELEASES"
    ;;
  ""|-*)
    die "usage: deploy.sh <image> | --rollback | --status"
    ;;
  *)
    image=$1
    previous=$(current_image)
    echo "deploying $image (was $previous)"
    set_image "$image"
    if start && wait_healthy; then
      echo "$(date -u +%FT%TZ) deployed $image" >> "$RELEASES"
      docker image prune -f > /dev/null
      echo "deployed $image"
    else
      echo "$(date -u +%FT%TZ) failed $image" >> "$RELEASES"
      echo "new release unhealthy; restoring $previous" >&2
      set_image "$previous"
      compose up -d --remove-orphans
      wait_healthy || echo "previous release is not healthy either; check: docker compose logs" >&2
      exit 1
    fi
    ;;
esac
