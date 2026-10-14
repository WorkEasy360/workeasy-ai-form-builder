# Instructions for an AI IDE implementing workeasy-AI-Form-builder

Use this as the initial build prompt, then give one backlog slice at a time.

```text
Build workeasy-AI-Form-builder using the specifications in this repository.
The confirmed stack is Next.js frontend, Express.js backend, and PostgreSQL.
Use TypeScript, the monorepo structure in docs/02-system-architecture.md,
and the shared schema/engine approach in docs/03-form-engine-and-ai.md.

Read README.md and docs/01 through docs/08 before implementation.
Treat contracts/form-definition.schema.json as the initial structural contract;
implement the additional semantic checks in the engine specification.

Begin with P0 in docs/07-delivery-plan.md, then implement P1A through P1D
in order. Complete working vertical slices with real persistence and tests.
Do not claim P2/P3 features exist before their phase acceptance gates pass.

Preserve these invariants:
1. Every tenant-owned resource is tenant-scoped and authorized server-side.
2. Published definitions are immutable; sessions/submissions pin a version.
3. Manual edits, AI proposals, and preview use the same definition/renderer.
4. The server validates and canonicalizes all answers and rule results.
5. Submission, quotas, receipt, and outbox event commit transactionally.
6. Retries cannot create a second response for the same respondent session.
7. AI produces reviewable drafts; it cannot publish or perform external actions.
8. Credentials never appear in client bundles, public schemas, or logs.
9. Uploads stay private and quarantined until checked and scanned.
10. Workeasy connectors use verified API contracts and idempotent adapters.

Before implementing each API slice, create executable OpenAPI schemas for
its routes, typed request/response models, migrations, and acceptance tests.
Use the data dictionary and transaction specifications, not ad hoc tables.
Pin supported dependency versions in a lockfile. Keep an architecture decision
record for necessary deviations and explain the impact before broad changes.

Use a local OIDC test provider until existing Workeasy SSO is specified.
Keep hosting and AI provider behind replaceable adapters. Do not invent real
Workeasy endpoints, deploy credentials, payment accounts, or production domains.
Use documented example environment variables with no secrets.

For every completed slice, report files changed, how to run it, tests actually
executed, acceptance criteria demonstrated, and known limitations.
Do not substitute decorative screens, mock success responses, or TODOs for
working feature behavior. Do not launch with unresolved tenant isolation flaws.
```

## Suggested first task

“Implement FND-01 through FND-05. Create the monorepo, real PostgreSQL migrations and RLS, local identity adapter, schema validation, and CI. Demonstrate tenant isolation with two fixture tenants. Do not start advanced UI until this foundation passes.”

## Suggested slice prompt

“Implement [BACKLOG ID] using the design documents. Inspect the current repository first. Extend contracts and migrations as needed, implement the complete vertical slice, run the relevant tests, and document any unresolved integration requirements. Stop at the specified phase gate rather than inventing future features.”

## What this package does not provide yet

It does not contain an application scaffold, runnable API implementation, production SQL migrations, a complete executable OpenAPI document, cloud-specific IaC, or verified Workeasy integration credentials/contracts. Those are explicit implementation deliverables. The JSON Schema and sample are starter design contracts, not an entire platform implementation.
