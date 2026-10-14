# Implementation plan and acceptance gates

## 1. Delivery method

Build vertical slices with real persistence and automated verification. Do not build all screens with mocked data and call the platform complete. Each slice includes schema/migrations, authorization, API, UI, failure behavior, tests, and operational notes. No time estimate is committed before team size and existing reusable components are known.

Sequence dependency: P0 → P1A → P1B → P1C → P1D → P2 → P3. Each backlog item has a proposed stable ID suitable for an issue tracker.

## 2. P0 — foundation

| ID | Deliverable | Acceptance |
|---|---|---|
| FND-01 | Monorepo, Next.js apps, Express, worker, TypeScript and lockfile | Clean checkout runs local environment from documented commands |
| FND-02 | PostgreSQL migrations, tenant transaction wrapper, RLS | Tenant A cannot read/write Tenant B in API, raw repository, or worker tests |
| FND-03 | OIDC adapter, org mapping, roles/grants | Real development IdP flow; revoked membership denied; no production mock auth |
| FND-04 | Shared schema/engine packages and fixtures | JSON contract validates example; identical browser/server engine outcomes |
| FND-05 | CI, logging, error model, request IDs, health checks | Pipeline passes; sanitized logs; failure responses conform to contract |

Gate: identity boundary and real database isolation are demonstrated before authoring features accept customer data.

## 3. P1A — manual creation and publication

| ID | Deliverable | Acceptance |
|---|---|---|
| BLD-01 | Form list/create/duplicate/archive, grants | Unauthorized form IDs return no data; duplication excludes responses/secrets |
| BLD-02 | Field registry and palette, pages, property inspector | Every advertised P1 field has renderer, codec, validator, and export serializer |
| BLD-03 | Editor commands, undo/redo, autosave | Reload keeps saved state; concurrent edit returns conflict without data loss |
| BLD-04 | Typed rules and forward page routing | Cycles/conflicts rejected; hidden required answers never block submission |
| BLD-05 | Theme, accessible responsive preview | Preview uses actual shared renderer; keyboard add/reorder works |
| PUB-01 | Validate/publish/version history/rollback | Version immutable; active pointer changes atomically; old version still interpretable |
| PUB-02 | Public link, QR, iframe, closed-state behavior | Embed works on sample host; close rejects submissions even with stale cached UI |

Gate: a manual form can be built and rendered from its published schema without editing code.

## 4. P1B — trustworthy collection and responses

| ID | Deliverable | Acceptance |
|---|---|---|
| RUN-01 | Access checks and version-bound sessions | Organization-only form denies anonymous access; cannot swap version/tenant |
| RUN-02 | Intake transaction and idempotency | Concurrent identical requests produce one submission and one event |
| RUN-03 | Quotas and limits | Concurrent last-slot submissions cannot overrun configured limit |
| FIL-01 | Upload, quarantine, scan, authorized download | Infected/foreign-session files rejected; clean files claimable once |
| RES-01 | Response table/detail/filter/keyset pagination | No duplicates/gaps for stable cutoff; field grants applied |
| RES-02 | CSV export worker | Permission revocation blocks download; formula injection neutralized |
| GOV-01 | Audit, soft delete, purge, retention | Response/file/export copies removed by test purge; audit contains no answers |

Gate: reload/retry/process crashes cannot produce duplicate acknowledged submissions; unauthorized tenants cannot retrieve responses or files.

## 5. P1C — AI and background automation

| ID | Deliverable | Acceptance |
|---|---|---|
| JOB-01 | Outbox dispatcher, durable jobs, leases, retries | Crash after commit recovers delivery; duplicate dispatch does not create duplicate jobs |
| AI-01 | Provider adapter and bounded generation jobs | Invalid output never enters draft; outage leaves manual editing usable |
| AI-02 | Proposal diff, accept/reject, revision conflict | AI cannot overwrite a newer manual draft or publish |
| AI-03 | Tenant opt-in, budget accounting, metadata logs | Spend cap enforced under concurrency; no prompt/answer logging |
| AUT-01 | Email and signed webhooks | Durable delivery history, retry, permanent-failure display, SSRF protection |
| ANA-01 | Basic aggregate analytics | Documented view/start/accept definitions, no answer telemetry |

Gate: end-to-end prompt → editable form → published form → response → email/webhook works, including provider failure tests.

## 6. P1D — release readiness

| ID | Deliverable | Acceptance |
|---|---|---|
| OPS-01 | Infrastructure and deployment pipeline | Repeatable staging/prod deployment with managed secrets |
| OPS-02 | Load/failure tests | Meets measured service objectives or documented revised targets |
| SEC-01 | Threat review and negative authorization suite | No unresolved critical tenant/answer/credential exposure |
| UX-01 | Accessibility and mobile verification | Keyboard/screen-reader journeys and mobile layouts verified |
| REC-01 | Backup restore and deletion replay | Restore drill records elapsed time and actual recovery point |
| DOC-01 | Admin/help/API docs and support runbooks | Operators can diagnose failed jobs and creators can publish/share unaided |

This completes the first usable application, not the whole reference-feature roadmap.

## 7. P2 — business platform

Implement in the following dependency order; each capability requires a schema/API amendment and test plan before implementation.

1. **ADV-01 Advanced fields/calculations:** typed formula AST, repeating groups, matrix, address/currency/signature; decimal rounding, repeat-row IDs, and dependency tests.
2. **ACC-01 Respondent continuity:** invitations, explicit save/resume, edit receipts, localization/card mode; token expiry/revocation, version pinning, masked edit rights.
3. **WFL-01 Workflow engine:** immutable DAG snapshots, conditions, delays, sequential/parallel approvals; restart, reassignment, duplicate decisions, and timer recovery tests.
4. **INT-01 Workeasy connectors:** obtain real API contracts; implement Helpdesk, HRMS, and AI Agent Platform contract suites against sandbox systems; mapping validation and deduplication. No fake integration completion.
5. **PAY-01 Hosted payments:** payment attempts/inbox/reservations/refunds/reconciliation; forged, duplicate, out-of-order, delayed, and mismatched amount callbacks tested.
6. **AI-04 Document import and translation:** scan/extract/validate/review pipeline, stale translation detection, evaluated fidelity against example documents.
7. **RPT-01 Documents and reporting:** PDF templates, saved views, typed projections, assignment/comments; template sanitization and permission tests.
8. **BIL-01 Plans and billing:** selected provider integration, entitlement transitions, reconciliation, clear downgrades; trial/expiry/webhook replay tests.

Gate: no workflow/payment state is conflated with intake acceptance; completed external actions can be reconciled after crashes; advanced editor and renderer contracts remain compatible with old versions.

## 8. P3 — enterprise and field collection

- Verified custom domains/TLS lifecycle with takeover prevention and unbinding tests.
- Enterprise SSO/group provisioning, more granular masks, residency and dedicated tenant DB options.
- Offline collector and sync with device revocation, duplicate local IDs, version incompatibility, and large file recovery tests.
- Verified lookups, barcode/location/OCR and appointment/inventory consistency with explicit online/offline restrictions.
- Warehouse export, large-volume reporting, advanced AI summaries with field masking and provenance.
- Collaboration beyond optimistic locking only if customer demand warrants CRDT complexity.
- Additional third-party connectors prioritized by demand; every connector gets permission, idempotency, retry, and deletion contracts.

## 9. Mandatory scenario suite

| Scenario | Expected result |
|---|---|
| Tenant B supplies Tenant A form/file/export/AI job ID | No data or action |
| Creator without response grant reads/export responses | Denied |
| Publish while a save advances draft revision | Conflict; no accidental snapshot |
| V2 adds/removes fields while V1 session is active | V1 validates under V1 until allowed expiry/revocation |
| Two identical requests submit concurrently | Exactly one database response and acceptance event |
| Same idempotency key has different answers | Conflict |
| Client lies about hidden answer or calculation | Hidden value removed; formula recomputed |
| Multiple requests compete for last quota slot | At most one accepted |
| Process crashes after acceptance before sending notification | Outbox eventually delivers |
| Worker crashes after remote success | Dedupe/reconciliation; no false exactly-once promise |
| AI returns executable text or cyclic rules | Rejected proposal; no side effects |
| Paid browser redirect arrives without webhook | Still pending |
| Signed paid webhook arrives after reservation expiry | Reconciliation/refund policy invoked |
| Member loses access after requesting export | No export download |
| Retention purge while job is queued | Job sees tombstone and skips deleted content |
| Restore old backup | Deletion ledger replayed before opening traffic |

## 10. Definition of done

A feature is done when its UI works against real API/persistence; authorization and tenant boundaries are enforced; errors and retries are specified; required tests pass; telemetry avoids sensitive content; migration/rollback behavior is documented; user help is updated; and acceptance criteria are demonstrated. Anything blocked by missing vendor credentials or Workeasy API contracts is reported as blocked, not simulated as production functionality.
