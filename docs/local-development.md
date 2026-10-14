# Local development

How to run the monorepo from a clean checkout (FND-01).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24.x | See `.nvmrc`; `engine-strict` rejects other majors |
| pnpm | 12.11.x | `npm install -g pnpm@12.11.2`, or `corepack enable` |
| Docker | Docker Desktop / Engine with Compose v2 | Runs local dependencies |

## First run

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:setup
pnpm db:seed
pnpm dev
```

`pnpm infra:up` waits until PostgreSQL, Redis, object storage and the mail sink are healthy, then creates the private buckets. `pnpm db:setup` creates the database roles and schema and applies migrations; `pnpm db:seed` adds two local tenants (Acme Support and Globex HR) with members and sample forms.

| Process | URL |
|---|---|
| Console (creator app) | http://localhost:3000 |
| Respondent (public forms) | http://localhost:3001 |
| API liveness | http://localhost:4000/health/live |
| Worker | No port; logs to the `pnpm dev` output |
| Mail sink UI (Mailpit) | http://localhost:8025 |
| Object storage console (RustFS) | http://localhost:9001 |
| PostgreSQL / Redis | `127.0.0.1:5432` / `127.0.0.1:6379` |

Every container port is bound to `127.0.0.1`. Change host ports in `.env` if they clash with something already running; remember to update `DATABASE_URL` / `REDIS_URL` to match.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Runs api, worker, console and respondent in watch mode |
| `pnpm build` | Production builds (tsup for api/worker, `next build` for the web apps) |
| `pnpm typecheck` | Type-checks every workspace project |
| `pnpm test` | Unit tests (no services needed) |
| `pnpm test:integration` | PostgreSQL integration tests; needs `pnpm infra:up`, recreates `<db>_test` each run |
| `pnpm test:all` | Both suites |
| `pnpm db:setup` | Creates/updates roles, database and schema, then applies migrations (idempotent) |
| `pnpm db:migrate` | Applies pending migrations only, as the owner role |
| `pnpm db:seed` | Inserts the two local seed tenants (idempotent; refused when `NODE_ENV=production`) |
| `pnpm infra:up` / `infra:down` | Starts / stops local dependencies (data is kept) |
| `pnpm infra:reset` | Stops dependencies and **deletes** their local volumes |
| `pnpm infra:ps` | Shows dependency status |

Run a built app with `pnpm --filter @workeasy/api start` (likewise `worker`, `console`, `respondent`).

## Layout

```text
apps/
  api/          Express API (tsup bundle)
  worker/       background worker process (tsup bundle)
  console/      Next.js creator console
  respondent/   Next.js public form runtime
packages/       shared code, imported as TypeScript source (@workeasy/*)
infra/          docker-compose.yml for local dependencies
contracts/      JSON Schema contracts (OpenAPI added per API slice)
```

Workspace packages export their TypeScript source directly (`"exports": "./src/index.ts"`). Next.js compiles them via `transpilePackages`; the api and worker bundle them with tsup. There is no separate package build step.

Packages without an implementation yet (`auth`, `form-engine`, …) are boundaries only: each `src/index.ts` names the backlog item that delivers it and exports nothing.

## Database and tenant isolation

Everything lives in the `app` schema. Each process connects as its own role (`packages/database/src/roles.ts`):

| Role | Env var | Used by | Privileges |
|---|---|---|---|
| `workeasy_owner` | `DATABASE_MIGRATION_URL` | Migrations only | Owns every object in `app` |
| `workeasy_api` | `DATABASE_URL` | API | `SELECT/INSERT/UPDATE` on tenant tables; no `DELETE` |
| `workeasy_worker` | `DATABASE_WORKER_URL` | Worker | `SELECT` until job types need more |
| `workeasy_public` | `DATABASE_PUBLIC_URL` | Public ingestion | Nothing yet (RUN-01 adds the slug locator) |

None of the runtime roles is a superuser, has `BYPASSRLS`, or owns a table. Every table holding tenant or user data has row-level security enabled and **forced**. `DATABASE_ADMIN_URL` (the local superuser) is used only by `pnpm db:setup` and the integration-test setup.

Use the context wrapper for every query on tenant data:

```ts
import { createDb, withTenant } from "@workeasy/database";

const db = createDb({ connectionString: process.env.DATABASE_URL! });
const forms = await withTenant(db, tenantId, (trx) => trx.selectFrom("forms").selectAll().execute());
```

`withTenant` / `withContext` open a transaction and set `app.tenant_id` (and optionally `app.user_id`) with transaction-local `set_config`, so the context ends with the transaction and never carries over to the next user of a pooled connection. The ID must come from server-side authentication. A query outside the wrapper sees no tenant rows.

`users` holds global identities: a user context sees only its own row, and a tenant context sees only the tenant's members.

**Migrations** are plain SQL files in `packages/database/migrations/` (`NNNN_name.sql`). They are forward-only, each runs in its own transaction, and they are serialized with an advisory lock. Checksums are recorded, so editing an applied migration is refused: add a new migration instead. New tables holding tenant data must enable and force RLS; an integration test checks this for every table with a `tenant_id` column.

**Integration tests** (`*.int.test.ts`) run against a fresh `workeasy_forms_test` database. They seed two tenants with random IDs and check that tenant A cannot read, update, insert into, move rows into or reference tenant B through either the api or the worker role. They also cover context lifetime on pooled connections and role/policy hardening.

## Dependency policy

- Versions are pinned exactly (`save-exact`) and resolved in `pnpm-lock.yaml`.
- pnpm's default `minimumReleaseAge` supply-chain check is active. Do not add `minimumReleaseAgeExclude` entries to get around it; pick an older release or wait until the new one is old enough.
- Install scripts are blocked except for packages listed under `allowBuilds` in `pnpm-workspace.yaml` (currently only `esbuild`).

## Not yet in the local environment

Later backlog items add these:

- Local OIDC provider, and API routes that resolve the tenant from membership, with API-level isolation tests (FND-03)
- Malware scanner (FIL-01)
- Readiness checks, request IDs and CI (FND-05)
