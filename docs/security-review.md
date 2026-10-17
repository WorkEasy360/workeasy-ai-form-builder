# Threat review (SEC-01)

Review date: 17 October 2026. Scope: console, respondent app, API, worker, database. The design-level rules are in [06-security-and-operations.md](06-security-and-operations.md); this page records what is enforced today and how each control is tested.

Exit criterion: no unresolved critical exposure of tenants, answers or credentials. **Status: met.** There are no open critical or high findings; the open items are listed at the end.

## Assets and boundaries

| Asset | Who may reach it |
|---|---|
| Answers and uploaded files | Members with response grants on that form; the respondent's own session until it submits |
| Form definitions and versions | Members with form grants; the public sees only the published projection |
| Webhook secrets, SMTP and AI keys | Server only; webhook secrets are encrypted at rest |
| Sessions and invitation tokens | Their holder; only SHA-256 hashes are stored |
| Audit log | Owners and admins; it holds IDs and counts, never answers |

Trust boundaries: browser → Next.js apps → API (cookie session or respondent capability) → PostgreSQL (row-level security per tenant) and object storage; worker → external webhooks and SMTP.

## Threats and controls

| Threat | Control | Evidence |
|---|---|---|
| Tenant B reads or changes tenant A's data by supplying A's IDs | Every query runs in a transaction scoped to one tenant; forced row-level security on every tenant table; the API resolves membership before using a route's organization ID and answers 404 otherwise | `apps/api/src/authz.int.test.ts` calls **every** console route in the contract with A's real IDs as B's owner, through both organizations, and checks A's data is byte-for-byte unchanged; `packages/database/src/isolation.int.test.ts` |
| A member exceeds their role or grants | Role and per-form grant checks on every route; field privacy classes on answers and exports | `authz.int.test.ts` (member of both organizations), `responses.int.test.ts`, `exports.int.test.ts` |
| Access kept after removal | Membership status checked on every request; exports check the requester again at build and download | `members.int.test.ts`, `exports.int.test.ts` |
| Cross-site request forgery | Session cookie `HttpOnly; SameSite=Lax`; every state-changing console request must carry the console's `Origin` | `authz.int.test.ts` (every mutation without Origin is refused) |
| Clickjacking, MIME sniffing, URL leaks | Console: `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`. Respondent: only `/f/<slug>` may be framed | `apps/console/src/security-headers.test.ts` |
| Respondent tampering (hidden answers, other sessions, version swap, replays) | Server re-evaluates rules and drops hidden answers; per-session capability; version-bound sessions; idempotency keys | `intake.int.test.ts`, `sessions.int.test.ts`, `public.int.test.ts`, `authz.int.test.ts` (cross-session uploads) |
| Malicious files | Quarantine until a ClamAV scan passes; type and size limits; downloads only through authorized short-lived URLs | `uploads.int.test.ts`, `governance.int.test.ts` |
| CSV formula injection | Cells starting with `= + - @` and control characters are neutralized in spreadsheet exports | `exports.int.test.ts` |
| Server-side request forgery through webhooks | Only public addresses on allowed ports; DNS checked before each delivery and the connection pinned to the checked address; no redirects | `packages/integrations` unit tests, `integrations.int.test.ts` |
| Forged webhooks to customers | HMAC-SHA256 over timestamp and body, event IDs for de-duplication, overlapping signatures during secret rotation | `integrations.int.test.ts` |
| AI output injecting markup or breaking forms | Replies are parsed, normalized, stripped of markup and validated like a published form; one repair attempt; never applied without a person | `ai.int.test.ts`, `packages/ai` unit tests |
| AI cost abuse | Opt-in per organization; daily token budget reserved atomically before each request; per-user and per-organization concurrency limits | `ai-budget.int.test.ts` |
| Spam and floods on public forms | Honeypot, minimum fill time, per-form response limits and an atomic organization-wide cap | `settings.int.test.ts`, `quotas.int.test.ts` |
| Invitation link guessing or reuse | 256-bit random tokens, stored hashed, single use, 7-day expiry, revocable; unknown and spent links look the same | `members.int.test.ts` |
| Sensitive data in logs or telemetry | Structured logs carry IDs, routes and durations only; audit metadata holds no answers or emails | `jobs.int.test.ts`, `governance.int.test.ts`, `members.int.test.ts` |
| Vulnerable dependencies | Exact versions at least two weeks old, install scripts blocked by default, `pnpm audit --prod` in CI | CI `audit` job |

## Open items

| Item | Severity | Plan |
|---|---|---|
| The console has no script-source Content Security Policy (Next.js inline scripts need per-request nonces) | Medium | Add nonce-based CSP with the production deployment (OPS-01) |
| HTTPS and HSTS are not configured locally | Medium in production | Set at the TLS-terminating proxy in OPS-01 |
| Invitation links are not bound to an email address, because the identity provider does not share emails yet | Low | Bind when email claims are available; links are single use and revocable |
| Signed-in API routes have no per-user request rate limit (public routes do) | Low | Add with the production proxy configuration |
| No external penetration test yet | — | Commission one before the first customer goes live |
