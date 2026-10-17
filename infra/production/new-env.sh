#!/usr/bin/env bash
# Creates .env (next to this script) from env.example with fresh random secrets
# (OPS-01). Refuses to overwrite an existing file: secrets such as
# INTEGRATION_SECRET_KEY must never change on a running installation.
set -euo pipefail
cd "$(dirname "$0")"

if [ -e .env ]; then
  echo ".env already exists; not overwriting it." >&2
  exit 1
fi

secret() { openssl rand -hex "$1"; }
pg_admin=$(secret 24); pg_owner=$(secret 24); pg_api=$(secret 24); pg_worker=$(secret 24); pg_public=$(secret 24)

umask 077
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pg_admin}|" \
  -e "s|^DATABASE_ADMIN_URL=.*|DATABASE_ADMIN_URL=postgres://workeasy_admin:${pg_admin}@postgres:5432/postgres|" \
  -e "s|^DATABASE_MIGRATION_URL=.*|DATABASE_MIGRATION_URL=postgres://workeasy_owner:${pg_owner}@postgres:5432/workeasy_forms|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://workeasy_api:${pg_api}@postgres:5432/workeasy_forms|" \
  -e "s|^DATABASE_WORKER_URL=.*|DATABASE_WORKER_URL=postgres://workeasy_worker:${pg_worker}@postgres:5432/workeasy_forms|" \
  -e "s|^DATABASE_PUBLIC_URL=.*|DATABASE_PUBLIC_URL=postgres://workeasy_public:${pg_public}@postgres:5432/workeasy_forms|" \
  -e "s|^OBJECT_STORAGE_ACCESS_KEY=.*|OBJECT_STORAGE_ACCESS_KEY=$(secret 12)|" \
  -e "s|^OBJECT_STORAGE_SECRET_KEY=.*|OBJECT_STORAGE_SECRET_KEY=$(secret 24)|" \
  -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(secret 32)|" \
  -e "s|^INTEGRATION_SECRET_KEY=.*|INTEGRATION_SECRET_KEY=$(openssl rand -base64 32)|" \
  env.example > .env
chmod 600 .env

echo "Wrote .env (mode 600). Now set the domains, identity provider and SMTP lines marked CHANGE_ME or example.com."
