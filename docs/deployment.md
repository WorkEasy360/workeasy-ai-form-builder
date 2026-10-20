# Deployment (OPS-01)

> **Production runs on AWS** (EC2, Aurora/RDS, S3, SES): see [aws-deployment.md](aws-deployment.md). This page covers the self-contained stack for any Linux VM, with its own database and storage.

Staging and production each run on one Linux VM with Docker Compose. Every release is a single image, `ghcr.io/<owner>/workeasy-forms:<commit>`, built once and promoted unchanged from staging to production.

```
Internet ── 80/443 ──> Caddy (TLS, HSTS)
                        ├─ CONSOLE_DOMAIN ─> console :3000 ─┐ /api, /auth
                        ├─ FORMS_DOMAIN   ─> respondent :3001 ┴─> api :4000 ─> postgres
                        └─ FILES_DOMAIN   ─> object storage :9000      worker ─> scanner, SMTP, webhooks
```

Only Caddy publishes ports. The database, storage, scanner, API and worker are reachable only on the private Compose network.

## What is in the repository

| File | Purpose |
|---|---|
| `Dockerfile` | One image for the API, worker, console, respondent app and migrations |
| `infra/production/docker-compose.yml` | The services, health checks, volumes and log rotation |
| `infra/production/Caddyfile` | HTTPS with automatic certificates, HSTS, compression |
| `infra/production/env.example` | Every setting, documented |
| `infra/production/new-env.sh` | Creates `.env` with fresh random secrets (refuses to overwrite) |
| `infra/production/deploy.sh` | Pull, migrate, start, wait for health, roll back on failure |
| `infra/production/backup.sh`, `restore-drill.sh` | Backups, deletion ledger and restore drills ([backup-and-restore.md](backup-and-restore.md)) |
| `.github/workflows/deploy.yml` | Builds the image and deploys over SSH |

## Preparing a server (once per environment)

1. A Linux VM with at least 4 GB of memory (the malware scanner alone needs about 1.5 GB), Docker Engine 24+ and the Compose plugin. Open ports 80 and 443 only.
2. Three DNS names pointing at it, for example `forms-admin.example.com` (console), `forms.example.com` (public forms) and `forms-files.example.com` (uploads).
3. A deploy user in the `docker` group, with an SSH key used only for deploys.
4. In your identity provider, an OpenID Connect client with redirect URIs `https://<console>/auth/callback` and `https://<forms>/public/v1/auth/callback`.
5. Settings and secrets, either:
   - **on the server:** copy `infra/production` to `/opt/workeasy-forms`, run `./new-env.sh`, then edit the domains, identity provider and SMTP lines in `.env`; or
   - **in GitHub:** generate the file the same way on any machine and store its contents as the `DEPLOY_ENV_FILE` secret of the environment. Each deploy then replaces the server's copy.

## Configuring GitHub

1. **Settings → Environments:** create `staging` and `production`. Protect `production` with required reviewers.
2. For each environment, add secrets:

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | Server name or IP |
   | `DEPLOY_USER` | The deploy user |
   | `DEPLOY_SSH_KEY` | Its private key |
   | `DEPLOY_KNOWN_HOSTS` | Output of `ssh-keyscan <host>`, checked against the server |
   | `DEPLOY_PATH` | Optional; defaults to `/opt/workeasy-forms` |
   | `DEPLOY_ENV_FILE` | Optional; the whole `.env` file |

3. **Settings → Variables:** set `DEPLOY_ENABLED` to `true` to deploy every green commit on `main` to staging automatically.

To release to production: **Actions → Deploy → Run workflow**, choose `production`, and give the commit that is running on staging.

## What a deploy does

`deploy.sh <image>` on the server:

1. Records the running image, then switches `.env` to the new one.
2. Pulls the images, creates the storage buckets if missing, and runs `db setup` (roles and migrations; safe to repeat).
3. Starts the new version and waits up to 4 minutes for the API, worker, console and respondent health checks.
4. If any stays unhealthy, puts the previous image back and fails the job.

`./deploy.sh --rollback` returns to the previous release; `./deploy.sh --status` lists recent releases and service health.

### Migrations and rollback

Migrations run before the new version starts and are never reversed. Every migration must keep the previous release working (expand, then contract in a later release): add columns and tables; drop or rename only after a release that no longer uses them. That is what makes an application rollback safe after a migration.

## Day-to-day operations

| Task | Command (in the deploy folder) |
|---|---|
| Service health | `docker compose ps` |
| Logs | `docker compose logs --since 1h api worker` (JSON lines; rotated at 5 × 20 MB per service) |
| Failed background jobs | Console → Background jobs, or [operations runbook](operations.md) |
| Restart one service | `docker compose restart worker` |

Backups, restore drills and deletion replay: [backup-and-restore.md](backup-and-restore.md).

## Not included

- A managed database or object store. To use one, remove the `postgres` or `object-storage` service and point the URLs in `.env` at it.
- Multiple VMs or zero-downtime deploys: each service restarts once per release, so expect a few seconds of errors during a deploy.
- A script-source Content Security Policy for the console (see [security-review.md](security-review.md)).
