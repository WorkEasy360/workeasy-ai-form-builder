# Operations runbook (DOC-01)

For whoever runs a Workeasy Forms installation (docs/deployment.md). Each section starts from what you notice. Commands run on the server, in the deploy folder; `dc` means `docker compose`.

## First look

| Where | What it tells you |
|---|---|
| `dc ps` | Which services are running and healthy |
| Console → **Background jobs** (owners and admins) | Jobs by state, attempts and error code; **Retry** on failed ones |
| Console → form → **Integrations** → **Show deliveries** | Every email and webhook attempt with status and error code; **Send again** |
| Console → **Audit log** | Who changed what (no answers in it) |
| `dc logs --since 30m api worker` | JSON logs; search for a request ID |

**Request IDs.** Every API response, including error pages, carries an `X-Request-Id` (`req_…`), and every log line for that request has it. Ask the person reporting a problem for the ID shown in the error, then `dc logs api | grep req_…`. Logs never contain answers, tokens or full URLs, so they are safe to share with support.

## Background jobs

Jobs carry deliveries (`integrations.fanout` → `integrations.deliver`) and AI requests (`ai.generate`). Each is tried up to 8 times with growing waits (5 seconds doubling, up to an hour), then marked **Failed (needs attention)**.

| Error code | Meaning | Action |
|---|---|---|
| `handler_error` | Unexpected failure in the job (log has details under the job ID) | Check `dc logs worker` for the job ID; fix the cause, then **Retry** |
| `lease_expired` | The worker stopped (crash, restart, out of memory) during the last attempt | Check `dc ps` and memory (`docker stats`); **Retry** |
| `deadline_exceeded`, `provider_timeout`, `provider_unavailable`, `provider_unreachable` | AI provider slow or down | Nothing; manual editing is unaffected. Persistent: check the provider's status page and `AI_PROVIDER`/keys |
| `provider_refused`, `provider_rejected` | The provider refused the request (key, quota, content) | Check the API key and the provider account |
| `invalid_output`, `output_truncated` | The AI's answer was not a valid form, even after one repair | Nothing to fix; the author can ask again |
| `ai_not_enabled`, `ai_unavailable` | AI turned off for the organization, or no provider configured | Expected |
| `form_unavailable`, `access_revoked` | The form or the requester's access went away before the job ran | Expected |

**Retry** gives a failed job three more attempts with the same identity, so a receiver that deduplicates sees no duplicate. It is audited.

### Jobs pile up (deliveries arrive late)

```sh
dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT type, status, count(*), min(next_attempt_at) FROM app.jobs
 WHERE status IN ('queued', 'running') GROUP BY 1, 2;
SQL
```

- Many `queued` with `next_attempt_at` in the past: the worker is behind. Check `dc ps worker` (healthy?) and `docker stats` (CPU). Raise `WORKER_JOB_CONCURRENCY` in `.env` (default 8) if CPU and the SMTP relay allow, then `dc up -d worker`.
- Many `queued` with future `next_attempt_at`: they are waiting to retry; look at the deliveries' error codes below.
- Measured capacity on a laptop: about 350 fan-outs and 85 emails per second (docs/performance.md).

## Failed deliveries (email and webhooks)

Shown per delivery in **Integrations → Show deliveries → Details**.

| Error code | Retried? | Meaning and action |
|---|---|---|
| `http_408`, `http_429`, `http_5xx`, `timeout`, `network_error`, `connection_refused`, `dns_failed`, `tls_failed` | Yes, about 1m, 5m, 30m, 2h, 8h, 24h | The receiver is down or slow. Usually resolves itself; tell the receiver's owner if it persists. `timeout` after sending is marked **Possibly delivered**. |
| other `http_4xx` | No | The receiver rejected the request (wrong URL, auth, signature check). Fix it at the receiver, then **Send again**. |
| `redirect_not_followed` | No | The URL redirects; enter the final URL. |
| `destination_blocked` | No | The URL resolves to a private or internal address. Intended (protection against server-side request forgery); use a public URL. |
| `smtp_unavailable`, `smtp_4xx` | Yes | The SMTP relay is down or deferring. Check `SMTP_HOST` and the relay's status. |
| `smtp_auth_failed`, `smtp_5xx` | No | Wrong SMTP credentials or a rejected sender/recipient. Fix `.env`, `dc up -d worker`, then **Send again**. |
| `email_not_configured` | No | `SMTP_HOST` is empty. |
| `no_recipient` | No (skipped) | Confirmation email: the respondent gave no address. Expected. |
| `recipient_limit`, `hourly_limit` | No (skipped) | Confirmation email limits: 5 per address per day, 500 per confirmation per hour. Repeated hits on one form may be someone using it to flood an inbox; check its responses. |

Bounces after the relay accepts a message are not tracked.

## Uploads stuck "checking"

Uploads wait for the malware scanner and are never passed unscanned.

1. `dc ps scanner`: it needs about 1.5 GB of memory and a few minutes to start.
2. `dc logs --since 1h scanner`: signature download errors are retried; the scanner keeps working with the signatures it has.
3. Once healthy, pending uploads are scanned on the worker's next pass (every 5 seconds).

**Malware found.** Infected files are deleted at once and never reach the clean bucket; respondents see "blocked by the virus check". No action is needed for one file. Many from one form may be an attack: close the form (form → **Settings** → **General** → close) and check the audit log for who published it.

## Database

| Symptom | Check | Action |
|---|---|---|
| `/health/ready` fails, console shows errors | `dc ps postgres`, `dc logs --since 15m postgres` | Restart: `dc restart postgres`. Intake waits up to the request timeout and resumes; no accepted response is lost (tested in docs/performance.md). |
| Disk filling up | `df -h`; `du -sh /var/lib/docker/volumes/*` | WAL piles up if archiving fails: check `SELECT failed_count, last_failed_wal FROM pg_stat_archiver` (with the same `psql` command as above) and the `backup` service |
| Restore needed | | docs/backup-and-restore.md |

## Security incidents

### A secret leaked

| Secret | Rotate | Effect |
|---|---|---|
| `SESSION_SECRET` | New random value in `.env`, `dc up -d api` | Everyone is signed out |
| Database role passwords | New values in all `DATABASE_*` URLs, then `./deploy.sh <current image>` (the migrate step sets them) | Brief restart |
| `OBJECT_STORAGE_*` keys | Change in storage and `.env`, `dc up -d` | Upload links already issued stop working |
| `OIDC_CLIENT_SECRET` | Rotate at the identity provider, update `.env`, `dc up -d api` | Sign-ins in progress fail once |
| A webhook signing secret | Form → **Integrations** → **New signing secret** (old and new are both sent for 24 hours) | None |
| `INTEGRATION_SECRET_KEY` | Not rotatable in place yet: stored webhook secrets are encrypted with it. Generate new signing secrets for every webhook after changing it. | Webhooks fail until their secrets are regenerated |
| AI provider key | Revoke at the provider, update `.env`, `dc up -d worker` | None |

Then check the audit log for actions in the exposure window.

### Someone may have seen another organization's data

1. Capture the request IDs, user, organization and time.
2. Find the requests: `dc logs api | grep <request id>`; the route template and status show what was called.
3. Check the audit log of both organizations for the window.
4. Every query runs under forced row-level security, and `apps/api/src/authz.int.test.ts` attacks every route across tenants on each build. If you can reproduce access, treat it as a critical bug: stop the API (`dc stop api`) until fixed.

### AI spend runs away

Turn AI off for the organization (console → **AI settings**, owners) or for everyone (`AI_PROVIDER=disabled` in `.env`, `dc up -d api worker`). Generations still queued are stopped before they run and their reserved budget is released; one already running finishes (at most 120 seconds).

## Deploys and rollback

`./deploy.sh --status`, `./deploy.sh --rollback`: docs/deployment.md.
