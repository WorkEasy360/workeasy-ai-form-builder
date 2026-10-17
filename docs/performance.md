# Load and failure tests (OPS-02)

`apps/api/scripts/load-test.ts` drives a running API with a fixed arrival rate (requests start on schedule whether or not earlier ones have answered, so queueing shows up as latency). It creates its own organization and a 100-question form over 5 pages with 10 visibility rules, and sends about 10 KiB of answers per submission. One respondent in ten has their client retry concurrently with the same idempotency key.

```sh
pnpm --filter @workeasy/api build
API_PORT=4100 node --env-file=.env apps/api/dist/server.js     # the built API, not the dev server
LOAD_API_URL=http://127.0.0.1:4100 pnpm --filter @workeasy/api load-test \
  --rate 40 --duration 120 --deliveries [--burst-rate 300 --burst-duration 15] [--outage] [--out report.json]
```

`--deliveries` adds an email integration to the form and measures acceptance to delivery (needs the worker and Mailpit). `--outage` pauses the database container for 5 seconds during load. The script refuses non-local APIs.

## Test environment

One Windows 11 laptop (8 cores) running everything: the API (one Node.js process), the worker, the console and respondent development servers, and PostgreSQL 18 in Docker Desktop (8 CPUs, 3.7 GB memory, virtualized disk). The load generator ran on the same machine. Treat these numbers as a floor, not as production capacity.

## Results, 17 October 2026

| Objective (docs/06 §5) | Target | Measured | Result |
|---|---|---|---|
| Submission response, p95 | ≤ 800 ms at 100/s sustained on one hot form | **352 ms at 40/s** for 2 minutes with deliveries running (p50 74 ms, p99 501 ms); 448 ms at 80/s for 30 s without deliveries | Revised: 40/s per form on this hardware |
| Burst | 300/s for 60 s | Accepted everything, but queued: p95 17 s | Not met here; see capacity |
| Delivery queue age, p95 | < 60 s | **19.6 s at 40/s** (p50 13 s) | Met |
| Public form fetch, p95 | (form load ≤ 2 s) | 17 ms for the API call | Met for the API; page load on mobile networks not measured |
| Exactly once | No duplicate or lost acknowledged responses | 0 duplicates, 0 losses across more than 49,000 accepted submissions, including concurrent retries | Met |
| Last slots of a limited form | Never over the limit | 200 concurrent for 50 slots: exactly 50 stored | Met |
| Database pause (5 s) during 20/s | Recover without errors or loss | 0 errors; requests waited and completed; first acceptance 294–469 ms after resume; nothing lost | Met |
| AI generation timeout | ≤ 120 s | Enforced by the job deadline (ai.int.test.ts) | Met |

**Revised targets until measured on production hardware:** p95 submission ≤ 800 ms up to 40 submissions/second on one form and one organization; burst traffic above that is accepted but queued (no errors, no loss). Re-run this test on the staging VM before promising more.

## What the tests found and fixed

| Finding | Fix |
|---|---|
| Throughput on one form stopped at about 60/s: every submission updates the same counter rows (form and organization), and intake held their row lock across five more round trips before committing | Reserve the response last, just before commit (`apps/api/src/intake.ts`); 60/s p95 fell from 1,273 ms to 162 ms |
| Moving the reservation last made a fresh form's counter count its first response twice (a limit of 50 accepted 49) | Counters are created before the response is inserted (migration 0024); covered by the quota tests |
| The worker ran 10 jobs per 5 seconds, one at a time: about 2/s, so a few minutes of traffic queued deliveries for hours, and one slow AI generation blocked everything behind it | The worker drains all due jobs each iteration, 8 at a time (`WORKER_JOB_CONCURRENCY`), within a time budget; measured about 350 fan-out jobs/s and 85 emails/s |
| Responses were stamped with the API server's clock while listings use the database clock | Stamped with the database clock (SEC-01) |

## Capacity limits and next steps

- **One form, one organization:** each acceptance updates two counter rows (the form's and the organization's monthly usage) under a row lock until commit, so acceptances for one form, and for one organization, commit one after another. The ceiling is set by commit latency (disk flush). Faster disks raise it; beyond that, shard the counters (several rows per form, summed for limit checks).
- **More API capacity:** run more API processes behind the proxy; the API is stateless.
- **Background work competes with intake** on one machine. On larger installations, run the worker on its own VM or lower `WORKER_JOB_CONCURRENCY`.
- **Not yet tested:** 30-minute soak, upload completions and exports under load, and mobile page load on a throttled network.
