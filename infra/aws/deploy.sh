#!/usr/bin/env bash
# Deploys one image on the EC2 server (OPS-03). GitHub Actions runs it through
# AWS Systems Manager after every successful build of main; you can also run
# it on the server yourself:
#
#   ./deploy.sh <account>.dkr.ecr.<region>.amazonaws.com/workeasy-forms:<commit>
#   ./deploy.sh --rollback      back to the previous release
#   ./deploy.sh --status        recent releases and service health
#
# Needs AWS_REGION and SETTINGS_SECRET_ID (the Secrets Manager secret holding
# the .env). Credentials come from the instance's IAM role.
#
# Migrations only ever add (expand/contract, docs/deployment.md), so rolling
# the application back after a migration is safe.
set -euo pipefail
cd "$(dirname "$0")"

RELEASES=releases.log
SERVICES=(api worker console respondent)
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-300}
RDS_CA_URL=https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

die() { echo "deploy: $*" >&2; exit 1; }
log() { echo "deploy: $*"; }
: "${AWS_REGION:?set AWS_REGION}"

compose() { WORKEASY_IMAGE="$IMAGE" docker compose --env-file .env "$@"; }
# No release log yet (the first deploy) means no previous release, not an error.
last_release() { { grep ' deployed ' "$RELEASES" 2>/dev/null || true; } | tail -n "${1:-1}" | head -n 1 | awk '{print $3}'; }

# Settings: the whole .env lives in Secrets Manager; it is written here with mode 600 on every deploy.
fetch_settings() {
  : "${SETTINGS_SECRET_ID:?set SETTINGS_SECRET_ID}"
  umask 077
  aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$SETTINGS_SECRET_ID" --query SecretString --output text > .env.next
  grep -q '^DATABASE_URL=' .env.next || { rm -f .env.next; die "the settings secret has no DATABASE_URL; fill it from env.example"; }
  mv .env.next .env
  # Amazon's certificate authorities for RDS/Aurora, for verified database connections.
  [ -s rds-ca.pem ] || curl -fsSL --retry 3 "$RDS_CA_URL" -o rds-ca.pem
}

registry_login() {
  aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${IMAGE%%/*}" > /dev/null
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

release() {
  registry_login
  compose pull --quiet
  log "migrating the database"
  compose --profile migrate run --rm migrate
  compose up -d --remove-orphans
}

case "${1:-}" in
  --status)
    tail -n 10 "$RELEASES" 2>/dev/null || echo "no releases yet"
    IMAGE=$(last_release) compose ps
    ;;
  --rollback)
    IMAGE=$(last_release 2)
    [ -n "$IMAGE" ] && [ "$IMAGE" != "$(last_release)" ] || die "no earlier release to roll back to"
    log "rolling back to $IMAGE"
    fetch_settings
    registry_login
    compose up -d --remove-orphans
    wait_healthy || die "rollback did not become healthy; check: docker compose logs"
    echo "$(date -u +%FT%TZ) deployed $IMAGE (rollback)" >> "$RELEASES"
    ;;
  ""|-*)
    die "usage: deploy.sh <image> | --rollback | --status"
    ;;
  *)
    IMAGE=$1
    previous=$(last_release)
    log "deploying $IMAGE (was ${previous:-nothing})"
    fetch_settings
    if release && wait_healthy; then
      echo "$(date -u +%FT%TZ) deployed $IMAGE" >> "$RELEASES"
      # Keep this app's last three releases for rollbacks; never touch other images.
      keep=$(grep ' deployed ' "$RELEASES" | tail -n 3 | awk '{print $3}')
      docker image ls --format '{{.Repository}}:{{.Tag}}' "${IMAGE%:*}" | grep -vxF "$keep" | xargs -r docker image rm > /dev/null 2>&1 || true
      docker image prune -f > /dev/null || true
      log "deployed $IMAGE"
    else
      echo "$(date -u +%FT%TZ) failed $IMAGE" >> "$RELEASES"
      if [ -n "$previous" ]; then
        echo "new release unhealthy; restoring $previous" >&2
        IMAGE=$previous
        compose up -d --remove-orphans
        wait_healthy || echo "previous release is not healthy either; check: docker compose logs" >&2
      fi
      exit 1
    fi
    ;;
esac
