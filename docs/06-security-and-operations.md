# Security, reliability, and deployment

## 1. Authentication and session design

Recommended shared Workeasy login uses OIDC authorization code flow with PKCE, issuer/audience/signature validation, state/nonce, and server-managed HttpOnly Secure cookies. Existing identity contracts remain unconfirmed. Map issuer+subject to user and external organization to tenant; verify organization membership server-side. Do not infer tenant from email domain alone. Separate console and respondent origins/cookies; do not use broad parent-domain cookies across untrusted custom domains.

SSO is not a dependency for initial local development: use a local OIDC-compatible test provider and fixtures. A temporary mock identity mechanism must be impossible to enable in production. Role and connection revocation must take effect for new requests immediately or within a documented cache TTL; high-risk changes invalidate sessions.

## 2. Threat and control matrix

| Threat | Required control | Verification |
|---|---|---|
| Cross-tenant ID substitution | Membership + resource grants + composite FKs + RLS | Negative tests on every resource family, jobs and exports |
| Answer/field tampering | Shared server engine, pinned immutable version | Unknown/hidden/forged-choice fixtures |
| Public spam/resource abuse | WAF, layered IP/form/tenant/session limits, bot challenge escalation, quotas | Burst and distributed abuse tests |
| Stored XSS in labels/answers | Escaped rendering, allowlisted sanitized rich text if introduced, CSP | Malicious labels, templates, file names, CSV cells |
| CSRF/session abuse | CSRF tokens/origin checks for cookie mutations; secure session rotation | Cross-origin mutation rejection |
| Webhook SSRF | Checked DNS/IPs, egress restrictions, no redirects | IPv4/IPv6, rebinding, metadata fixtures |
| Malicious uploads | Quarantine, magic-byte checks, malware scan, sandbox conversion | Infected/type-mismatch/oversize files |
| AI prompt injection | Untrusted input isolation, no side-effect tools, schema validation | Malicious prompts and source-document eval set |
| Payment spoofing | Raw-body signature check, amount/account verification, inbox dedupe | Forged/duplicate/out-of-order callback tests |
| Export leakage | Reauthorization, masks, private storage, expiring link | Revoked membership and changed grant tests |
| Credential exposure | Secret manager, masked logs, server-only adapters | Secret scanning and bundle checks |
| Unauthorized support access | Time-limited audited access approval when operationally necessary | No default operator response-read role |

Public submission limits start at configurable per-session and per-form rates; tenant/IP rates account for shared corporate networks. Respond with Retry-After and preserve answers. Cookie heuristics/IP checks must not be advertised as guaranteed duplicate-person prevention.

## 3. Files and content

Uploads are created only for an authorized version field and a scoped session. Presigned PUT constrains destination and lifetime; server rechecks actual bytes/type and field limits on completion. Never trust Content-Type or file extension alone. Quarantine and clean storage have separate access policies. Clean downloads require current response/file authorization and short-lived URLs, with content disposition attachment and safe filenames. Unclaimed uploads expire after 24h. Scanner outages keep files pending and tell respondents to retry; do not silently bypass scan.

Images used as theme logos also undergo validation/re-encoding. Document renderers run without external network access to prevent embedded resource fetching. HTML/rich text sanitization is centralized. CSP permits only approved renderer assets; iframe embedding uses explicit policy and safe `postMessage` origin/source checks. Embed height messages contain no answers.

## 4. Privacy and data lifecycle

Classify fields as ordinary, personal, or sensitive; default file and signature fields to personal. Mask based on grants in APIs, exports, reporting, audit displays, and AI projections. TLS in transit and managed encryption at rest are required; per-tenant envelope encryption is a possible enterprise tier, with search limitations documented before adoption.

Default proposal: 365-day response retention configurable by tenant; 24-hour unclaimed uploads, import sources, and exports; 30-day operational logs with no answer content; 90-day security/audit metadata. These are product defaults requiring business review, not legal requirements. Consent text and version can be recorded with submission timestamps. Maintain processor/subprocessor inventory and support export/deletion workflows. No GDPR, HIPAA, SOC 2, or other certification claim follows from this architecture alone.

## 5. Initial capacity model and service objectives

Planning assumptions, not observed load:

- 1,000 tenants, 20,000 active forms, 100,000 submissions/day.
- Average submission rate ~1.16/s; test 100/s sustained for 30 minutes and 300/s bursts for 60 seconds, including a single hot form.
- 10 KiB average answer payload yields roughly 1 GiB/day raw answer JSON before indexes, audit, revisions, and replication.
- If 10% attach a 2 MiB file, files add roughly 20 GiB/day; files likely dominate retention cost.
- Load tests include 100-field forms, rule evaluation, concurrent quotas, upload completions, and background exports.

Proposed initial SLOs: public intake 99.9% monthly availability; p95 submission response <=800ms excluding uploads/payment/third-party work at the test profile; p95 cached form load <=2s on a documented mobile network; p95 normal delivery queue age <60s; AI generation timeout handled within 120s. Establish baseline and revise promises after measurement. Define acceptance success metrics separately from validation/bot rejections.

Recovery targets: regional backup restoration RPO <=15 minutes and RTO <=4 hours, subject to restore drills and selected provider. Synchronous multi-zone database failover targets no acknowledged loss for supported single-zone failure; cross-region disaster recovery can lose up to the stated RPO. Do not claim zero-loss across all disasters.

## 6. Deployment topology

Local: compose PostgreSQL, Redis, S3-compatible storage, test email sink, scanner, local IdP, and application processes. Seed two tenants with different grants and sample forms. Keep secrets in ignored local config, never sample fixtures.

Staging: separate infrastructure/accounts, synthetic data, sandbox integrations/payment credentials, production-like schema and deployment pipeline.

Production baseline: CDN/WAF/TLS → load balancer → independently scalable console/respondent/API replicas; private PostgreSQL with automated backups and point-in-time recovery; Redis with memory/availability alarms; private object storage; worker pools for AI, files, automations, and exports. Cloud provider remains open. Begin with managed containers rather than introducing Kubernetes without an operational need.

Use least-privilege runtime identities and secret manager references. Jobs have resource limits; document processing and exports cannot exhaust ingestion capacity. Graceful API shutdown stops new requests and drains active ones; worker shutdown stops claiming jobs and releases/lets leases expire safely. App liveness checks process health; readiness checks essential serving dependencies without coupling public intake to AI/email availability.

## 7. Failure behavior

| Failure | User-visible / system behavior |
|---|---|
| PostgreSQL unavailable | 503 before acceptance; client retains answers and retries same request key |
| Redis unavailable | No unsafe unlimited traffic; bounded local fallback for low-risk endpoints or 503 for required abuse gates; DB remains authoritative |
| AI provider unavailable | Generation fails/retries within budget; manual builder and runtime remain available |
| Email/webhook destination down | Submissions accepted; durable retries; visible failed deliveries |
| Worker crashes after external call | Lease retry with stable idempotency key; reconciliation for ambiguous non-idempotent destinations |
| Scan service unavailable | File stays pending; no download/claim until clean |
| Payment callback missing | Pending state shown; provider reconciliation job resolves |
| CDN serves closed form | Submit API rejects under current access policy; refresh shows closed state |
| Tenant quota exceeded | Atomic rejection or explicit configured policy; no accepted response silently discarded |
| Export worker overload | Export queue waits; intake worker pool unaffected |

## 8. Observability and operations

Metrics: submission attempts/commits/replays/rejections; p50/p95/p99 latency; DB connections/locks/replication lag; outbox age; job age/attempts/dead letters; file scan backlog; AI token spend/schema failure/acceptance; connector success; payment reconciliation age; storage growth; tenant quota utilization. Avoid high-cardinality answer labels or user identifiers in metric dimensions.

Trace IDs propagate API → outbox → worker → external call. Structured logs include tenant/resource identifiers only as operationally needed; omit tokens, passwords, answers, prompts, raw callback bodies, and signed URLs. Alerts link to runbooks: DB failover, queue backlog, payment mismatch, malware incident, credential compromise, tenant isolation incident, backup restore, deletion replay, and runaway AI spend.

Analytics use privacy-conscious event IDs and aggregates for view/start/submit. No keystroke or answer capture. Document numerator/denominator: completion = accepted submissions / started sessions in the selected cohort/window, with bot/internal traffic treatment stated. Do not mix pending paid submissions into completed counts.

## 9. CI/CD, migrations, and recovery

CI: typecheck, lint, schema/fixture validation, pure engine tests, PostgreSQL integration tests with real RLS, API authorization tests, browser critical journeys, dependency/secret/container scans. Production build verifies no server-only credentials in client bundles.

Deploy expand-and-contract database migrations: add nullable/backfilled structures, deploy compatible readers/writers, backfill in bounded batches, verify, then remove old columns in a later release. Immutable schema readers remain compatible. Migrations run with a dedicated privileged identity, not runtime users. App rollback cannot safely undo every migration; include forward-fix steps.

Release with feature flags/canaries; synthetic public submission checks run in an isolated test tenant. Review error budget and queue age before expansion. Nightly backups plus continuous WAL archiving; object-store versioning/lifecycle policy; quarterly restore drills initially, increasing frequency for stricter commitments. Restore into isolated environment, replay deletion ledger, verify tenant isolation and sample counts, then cut traffic.

## 10. Commercial metering and cost model

Separate billing subscription state from effective entitlements. Server checks active forms, submissions/month, storage, collaborators, AI tokens, and advanced capabilities. Do not rely on frontend feature hiding. Billable usage events are idempotent. Downgrade behavior preserves historical data and shows required changes before restricting new publication; document policy before enabling billing.

Estimate monthly cost as infrastructure baseline + DB/backup/storage + object storage/egress + email count + AI input/output tokens + OCR pages + payment provider fees + observability. Actual currency estimates require cloud region, retention, volume, and provider pricing; none are assumed here. Reserve costly operations before starting, release unused capacity, and reconcile expired reservations.
