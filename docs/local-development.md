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
pnpm dev
```

`pnpm infra:up` waits until PostgreSQL, Redis, object storage and the mail sink are healthy, then creates the private buckets.

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
| `pnpm test` | Runs the Vitest suite |
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

Packages without an implementation yet (`auth`, `database`, `form-engine`, …) are boundaries only: each `src/index.ts` names the backlog item that delivers it and exports nothing.

## Dependency policy

- Versions are pinned exactly (`save-exact`) and resolved in `pnpm-lock.yaml`.
- pnpm's default `minimumReleaseAge` supply-chain check is active. Do not add `minimumReleaseAgeExclude` entries to get around it; pick an older release or wait until the new one is old enough.
- Install scripts are blocked except for packages listed under `allowBuilds` in `pnpm-workspace.yaml` (currently only `esbuild`).

## Not yet in the local environment

Later backlog items add these:

- Local OIDC provider (FND-03)
- Malware scanner (FIL-01)
- Database migrations, roles and RLS (FND-02)
- Readiness checks, request IDs and CI (FND-05)
