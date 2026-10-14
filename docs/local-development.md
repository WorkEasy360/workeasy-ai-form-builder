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

`pnpm infra:up` waits until PostgreSQL, Redis, object storage and the mail sink are healthy, then creates the private buckets. `pnpm db:setup` creates the database roles and schema and applies migrations; `pnpm db:seed` adds two local tenants (Acme Support and Globex HR) with members and sample forms. Open http://localhost:3000 and sign in as one of the [local users](#sign-in-and-permissions).

| Process | URL |
|---|---|
| Console (creator app) | http://localhost:3000 |
| Respondent (public forms) | http://localhost:3001 |
| API liveness | http://localhost:4000/health/live |
| Worker | No port; logs to the `pnpm dev` output |
| Local sign-in provider (Dex) | http://localhost:5556/dex |
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
| `pnpm test:browser` | Shared engine/schema tests in headless Chromium; needs `pnpm browsers:install` once |
| `pnpm test:all` | All three suites |
| `pnpm browsers:install` | Downloads Playwright's headless Chromium for `test:browser` |
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

## Sign-in and permissions

**Local users** (all use the password `local-dev-password`; defined in `infra/dex/config.yaml`):

| Email | Seeded as |
|---|---|
| `asha@acme.test` | Owner of Acme Support |
| `carlos@acme.test` | Creator in Acme Support |
| `grace@globex.test` | Owner of Globex HR |
| `ana@globex.test` | Analyst in Globex HR |
| `nina@nowhere.test` | No organization (signs in, sees none) |

**Flow.** The console forwards `/auth/*` and `/api/*` to the API (`next.config.ts` rewrites, `API_INTERNAL_URL`), so cookies stay first-party to the console origin.

1. `/auth/login` starts an OIDC authorization-code flow with PKCE, state and nonce. These are kept in a short-lived, AES-GCM-encrypted HttpOnly cookie.
2. `/auth/callback` exchanges the code. `openid-client` validates the ID token, the issuer + subject is mapped to a user (created on first sign-in, with no access), and a random 256-bit session token is set as an HttpOnly, SameSite=Lax cookie. Only its SHA-256 hash is stored, in `auth_sessions`.
3. `POST /auth/logout` revokes the session.

Cookie-authenticated mutations must come from `CONSOLE_PUBLIC_URL`, checked by Origin, or by Referer when there is no Origin. With `SESSION_COOKIE_SECURE=true` the cookie becomes `__Host-we_session`, and production refuses `false`, http issuers and http console URLs.

**Organization mapping.** Organization routes take the tenant ID from the URL (`/api/v1/organizations/:orgId/...`), and every request re-checks that the signed-in user has an **active** membership there before any tenant data is read. Unknown organizations, organizations the user doesn't belong to, and revoked memberships all return 404, so revocation applies to the very next request. The tenant is never inferred from an email domain or a token claim. `tenants.external_org_id` is reserved for the Workeasy organization identifier once the Workeasy identity provider's claims are specified.

**Roles and grants** (`packages/auth`, docs/01 §4):
- Owners hold every permission.
- Admins hold every permission except organization management, and except deleting forms or responses without an explicit grant.
- Creators can create forms.
- Everything else comes from per-form grants in `form_grants`.
- Any grant on a form implies `forms.read`.
- Creating a form does not by itself give response access.

**Endpoints so far** are in [`contracts/openapi.json`](../contracts/openapi.json), which is generated from the zod schemas in `apps/api/src/contract/`. After changing a route or schema, run `pnpm --filter @workeasy/api openapi:write`; a unit test fails if the file is stale.

| Route | Permission |
|---|---|
| `GET /api/v1/me` | Signed in |
| `GET /api/v1/organizations/:orgId/forms` | Active member; owners/admins see every form, others only forms they hold grants on |
| `GET`/`PUT /api/v1/organizations/:orgId/forms/:formId/grants` | `forms.manage_access` on the form; grantees must be active members |

## Form definitions and the engine

`@workeasy/form-schema` and `@workeasy/form-engine` are pure TypeScript with no Node or DOM APIs. The same code runs in the API, the builder and the respondent app (docs/03).

- **Structural validation** is generated from `contracts/form-definition.schema.json` into `packages/form-schema/src/generated/validate-definition.js`. This is Ajv's standalone output, which compiles no code at runtime and so stays compatible with a strict Content-Security-Policy. After editing the contract, run `pnpm --filter @workeasy/form-schema generate`; a test fails if the committed validator is stale. Nesting depth (40) and size (1 MiB) are checked before schema validation.
- **`validateDefinition`** (engine) runs the schema validation, then the semantic checks:
  - IDs are unique, and every field is on exactly one page.
  - Settings suit the field type, and min/max/length ranges are valid.
  - Rule conditions reference existing fields with operators and literals that suit the type, and are at most 8 levels deep and 100 parts.
  - A visibility/required rule may only depend on **earlier** fields. This makes cycles impossible and keeps evaluation single-pass.
  - At most one rule per target property, and at most one forward-only skip per page.
- **`evaluate(definition, answers)`** decodes answers (unknown fields rejected, values never coerced), walks pages in order applying visibility and skip rules, drops answers for hidden or unreachable fields, applies conditional required state, and returns canonical answers plus field errors.
  - `""`, `null` and `[]` are empty. `false` and `0` are not.
  - Comparisons on absent values are false (including `neq`).
  - Decimals are compared as exact base-10 strings.
  - Text `contains` ignores case.
- **Field registry** (`FIELD_REGISTRY`): the codec, allowed settings, rule operators, privacy default and export value for each P1 type. File answers are upload IDs. The engine checks only their shape and count; ownership and scan state are checked when a submission claims them (FIL-01).

**Shared corpus.** `packages/form-engine/corpus/` holds JSON cases: definitions with raw answers and their exact expected outcome, plus definitions with their expected validation issues. `*.shared.test.ts` files run unchanged in Node (`pnpm test`) and headless Chromium (`pnpm test:browser`). To cover new behavior, add a case to the corpus instead of writing a one-off test.

## Dependency policy

- Versions are pinned exactly (`save-exact`) and resolved in `pnpm-lock.yaml`.
- pnpm's default `minimumReleaseAge` supply-chain check is active. Do not add `minimumReleaseAgeExclude` entries to get around it; pick an older release or wait until the new one is old enough.
- Install scripts are blocked except for packages listed under `allowBuilds` in `pnpm-workspace.yaml` (currently only `esbuild`).

## Not yet in the local environment

Later backlog items add these:

- Readiness checks, request IDs and CI (FND-05)
- Audit events for grant changes and sign-ins (GOV-01)
- Rate limiting on sign-in, and invalidating sessions after high-risk account changes
- Malware scanner (FIL-01)
