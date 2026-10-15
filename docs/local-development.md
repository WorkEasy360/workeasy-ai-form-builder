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
| API liveness / readiness | http://localhost:4000/health/live, http://localhost:4000/health/ready |
| Worker liveness | http://localhost:4001/health/live |
| Console / respondent liveness | http://localhost:3000/healthz, http://localhost:3001/healthz |
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
| `pnpm lint` | Oxlint, including import boundaries for browser-side packages |
| `pnpm check:bundles` | After `pnpm build`: fails if a client bundle contains server-only setting names or secret values |
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

Packages used by the Next.js apps (`form-schema`, `form-engine`, `form-renderer`, `builder`, `ui`) import TypeScript files **without** an extension (`from "./fields"`, not `"./fields.js"`): Next's Turbopack cannot resolve a `.js` specifier to a `.ts` file. Imports of real `.js` files, such as the generated validator, keep their extension. `pnpm build` fails if this is broken.

Both Next.js apps set `experimental.mcpServer: false`. Next 16's development MCP server writes every log line to `.next/dev/logs`; in this monorepo the repo-wide watcher picks up those writes and reloads the page, which logs again, causing an endless reload loop.

Packages without an implementation yet (`events`, `integrations`, …) are boundaries only: each `src/index.ts` names the backlog item that delivers it and exports nothing.

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
- Creating or duplicating a form gives the creator `forms.edit`, `forms.publish` and `forms.manage_access` on that form, but never response access or delete rights.

**Endpoints so far** are in [`contracts/openapi.json`](../contracts/openapi.json), which is generated from the zod schemas in `apps/api/src/contract/`. After changing a route or schema, run `pnpm --filter @workeasy/api openapi:write`; a unit test fails if the file is stale.

| Route | Permission |
|---|---|
| `GET /api/v1/me` | Signed in |
| `GET /api/v1/form-templates` | Signed in |
| `GET /api/v1/organizations/:orgId/forms` | Active member; owners/admins see every form, others only forms they hold grants on. Archived forms only with `?state=archived`. Each item lists the caller's permissions. |
| `POST /api/v1/organizations/:orgId/forms` | `forms.create`. Blank or `template`; returns the form with `ETag: "draft-1"` |
| `GET /api/v1/organizations/:orgId/forms/:formId` | `forms.read` on the form |
| `POST …/forms/:formId/duplicate` | `forms.create` and `forms.edit` on the source. Copies only the draft definition, never grants, workflow configuration, versions or responses |
| `POST …/forms/:formId/archive`, `…/restore` | `forms.publish`; 409 if the form is already archived / not archived. Restore returns the form to draft |
| `GET`/`PUT /api/v1/organizations/:orgId/forms/:formId/grants` | `forms.manage_access` on the form; grantees must be active members. PUT replaces every grant, including the creator's own |
| `GET /api/v1/organizations/:orgId/forms/:formId/draft` | `forms.edit`. Returns the definition, its `revision` (also as `ETag: "draft-N"`) and the issues to fix before publishing |
| `PUT …/forms/:formId/draft` | `forms.edit`. The body is the whole definition, and `If-Match: "draft-N"` is required. Returns 428 if `If-Match` is missing, 412 `DRAFT_CONFLICT` (with `currentRevision`) if someone saved first, 409 if the form is archived, and 422 if the definition is malformed |

Every form has exactly one draft (`form_drafts`), holding the editable definition and its `revision`. A save succeeds only if the revision is unchanged, so concurrent edits are never silently overwritten. Drafts may be incomplete: a draft with no questions yet is accepted, and the remaining problems come back as `issues`. Malformed drafts are rejected, so a stored draft can always be loaded. Slugs are server-generated (`f-` plus 12 random characters) and only locate a form; they never grant access.

The console lists, creates, duplicates, archives and restores forms at `/o/:orgId/forms`, linked from the organization list on the home page. Form names link to the builder when you can edit them.

**Builder** (`/o/:orgId/forms/:formId/build`):
- **Left:** pages (add, reorder, delete when empty) and the question palette.
- **Centre:** the current page rendered by the shared `@workeasy/form-renderer`, with move, duplicate and delete per question.
- **Right:** the inspector, for form details, page title, or the selected question's label, help text, required state and type-specific settings (lengths, number/date/time bounds, options, selection limits, file types and sizes, consent version).
- **Validation:** issues are recomputed in the browser with the same `validateDraft` the server uses. An edit that would make the draft unsaveable, such as an empty label, isn't applied; it shows an inline error and keeps what you typed.
- **Undo/redo:** every edit is a labelled step ("Undo Add Rating"), using the Undo/Redo buttons or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y). Inside a text field the browser's own text undo applies. Typing in one field within 1.5 s counts as one step. History holds up to 100 steps for the session; reloading starts fresh.
- **Autosave:** changes save 800 ms after the last edit, one save at a time. Edits made during a save follow in the next save. Network or server failures retry after 1, 3, 10 and then every 30 seconds. Undoing back to the saved state counts as saved. "Save now" or Ctrl/Cmd+S saves immediately, and you're warned before leaving while anything is unsaved.
- **Conflicts:** if someone else saved first, autosave pauses and your version stays in the tab. The builder shows who saved and when, and lists **your unsaved changes** and **their changes** separately, each compared with the last version this tab saved. You can then:
  - **Keep my version:** an explicit overwrite.
  - **Use their version:** loaded as an undoable step, so Undo brings yours back.
  - **Download my version:** a JSON copy.
- **Logic:** a question's **Logic** section sets "Show only when"/"Hide when" and "Required only when"/"Optional when" rules. A page's **Skip ahead** section jumps respondents forward after that page. Conditions can only use earlier questions (for a skip, questions on that page or before), with operators and values that suit each question's type. Skips only go forward past the next page, and each page has at most one. An edit that would cause a cycle, a conflict or a backward skip is refused with the reason. If reordering later breaks a rule, the problem shows next to the rule and blocks publishing. Canvas cards are marked "Conditional"/"Required by rule", and pages that skip are marked in the page list.
- **Keyboard:** every action is a button, so nothing needs dragging.

`@workeasy/builder` also holds the edit history (`applyStep`/`undo`/`redo`), the autosave controller (`Autosave`) and `diffDefinitions`/`summarizeChanges`, which name changes by stable ID (reused for reviewing AI proposals). `GET …/draft` reports `updatedAt` and `updatedBy` for the conflict message. Pure editing operations live in `@workeasy/builder` (add/update/move/duplicate/remove questions, options and pages). Removing a question also removes the rules that depend on it, and reports them. Rule editing (`setFieldRule`, `setSkipRule`, `removeRule`, `conditionFieldsFor`, `skipTargetsFor`, `ruleProblems`, `guardRuleEdit`) uses the engine's `validateDraft`, so the builder and the engine reject the same rules. New fields and options get random opaque IDs, so labels can change without changing identity.

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

**Renderer.** `@workeasy/form-renderer` has one accessible React component per field type (`FIELD_COMPONENTS`, `FormField`):
- Labels stay visible.
- Help text and errors are linked with `aria-describedby`, and invalid controls carry `aria-invalid`.
- Required state uses the native `required` attribute.
- Radios, checkboxes and ratings are grouped in a `fieldset` with a `legend`.
- Decimals are entered as text, so no precision is lost.
- Markup in labels is shown as text.

`*.browser.test.tsx` files run only in headless Chromium and drive the components with real input events. They also check that every P1 field type has a renderer, codec, validator and export serializer.

## Errors, logs and health

- **Request IDs.** Every API response has an `X-Request-Id` (`req_…`). Every log line written while handling the request carries the same ID. An incoming `X-Request-Id` is recorded only as `upstreamRequestId`, and only if it is plainly safe to log; it is never reused as our own.
- **Error model.** Every error is `application/problem+json` with `type`, `title`, `status`, `code` and `requestId`, plus `errors` for field problems or `checks` for readiness. Malformed JSON → 400 `MALFORMED_JSON`; oversized body → 413; unexpected failures → 500 `INTERNAL` with a generic title (details only in the log, under the request ID).
- **Logs** are JSON (pino). Each request logs one line with method, route **template** (e.g. `/api/v1/organizations/:orgId/forms`), status and duration. It never logs the concrete path, query string, headers or body.
  - Credentials, tokens, answers and prompts are redacted by key.
  - Errors are reduced to name, message, code and stack. PostgreSQL errors keep only the SQLSTATE and the table or constraint name, because their messages and details can quote submitted values.
- **Health.**
  - `/health/live` reports process liveness.
  - `/health/ready` checks PostgreSQL with a 2-second timeout, and fails while the API is draining for shutdown. Sign-in, email and AI outages deliberately don't affect readiness.
  - The worker's `/health/live` (port `WORKER_HEALTH_PORT`) fails if its polling loop stops iterating.
  - The Next.js apps serve `/healthz`.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and `feat/**` and on pull requests. Actions are pinned to full commit SHAs.

| Job | Runs |
|---|---|
| checks | `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `build`, `check:bundles` |
| browser | Shared engine/schema tests in headless Chromium |
| integration | `pnpm infra:up` (the same Docker services as locally, with `.env.example` credentials), then `test:integration` |
| audit | `pnpm audit --prod --audit-level high` |

## Dependency policy

- Versions are pinned exactly (`save-exact`) and resolved in `pnpm-lock.yaml`.
- pnpm's default `minimumReleaseAge` supply-chain check is active. Do not add `minimumReleaseAgeExclude` entries to get around it; pick an older release or wait until the new one is old enough.
- Install scripts are blocked except for packages listed under `allowBuilds` in `pnpm-workspace.yaml` (currently only `esbuild`).

## Not yet in the local environment

Later backlog items add these:

- Distributed tracing (OpenTelemetry), metrics and alerting
- Secret scanning and container image scanning in CI
- Audit events for grant changes and sign-ins (GOV-01)
- Rate limiting on sign-in, and invalidating sessions after high-risk account changes
- Malware scanner (FIL-01)
