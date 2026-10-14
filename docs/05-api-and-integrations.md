# API, event, and integration contracts

## 1. API conventions

Base paths: `/api/v1` for authenticated console/API clients; `/public/v1` for respondent access; `/callbacks/v1` for provider callbacks. UUID resource IDs; ISO-8601 UTC timestamps. Private browser calls use secure HttpOnly sessions with CSRF protection; scoped API tokens use Authorization headers, rotation, and hashed storage. Never place API keys in form embeds.

Private organization routes derive tenant from authenticated membership and compare the route organization; never trust a supplied tenant ID alone. JSON body cap is 1 MiB except upload endpoints, with answer payload limited to 256 KiB. Cursor list limit defaults to 25 and caps at 100. Errors use `application/problem+json`:

```json
{
  "type": "urn:workeasy:error:validation_failed",
  "title": "Some answers need attention",
  "status": 422,
  "code": "VALIDATION_FAILED",
  "requestId": "req_opaque",
  "errors": [{"fieldId": "f_email", "code": "INVALID_EMAIL", "message": "Enter a valid email address"}]
}
```

Standard outcomes: 401 unauthenticated, 403 unauthorized, 404 absent/not visible, 409 state/idempotency conflict, 410 closed/expired public resource, 412 draft revision conflict, 413 oversized input, 422 field/schema errors, 429 throttled (Retry-After), 503 temporary dependency unavailable. Do not leak another tenant's resource existence. Every successful mutation returns a request ID; audit significant actions.

## 2. Endpoint inventory

`O = /api/v1/organizations/:orgId`. All private endpoints require membership plus the listed permission. Implement each as OpenAPI with request/response schemas before coding its handler.

| Method and route | Request / response | Permission and invariant |
|---|---|---|
| GET `/api/v1/me` | User, memberships, effective permissions | Authenticated; no secrets |
| GET `O/forms` | Cursor, search, state → form summaries | `forms.read` scoped grants |
| POST `O/forms` | Name, blank/template origin → form + draft + ETag | `forms.create`; enforce quota |
| GET `O/forms/:id/draft` | Definition, workflow draft, revision | `forms.edit` |
| PUT `O/forms/:id/draft` | Definition, If-Match → new revision | `forms.edit`; atomic revision CAS |
| POST `O/forms/:id/validate` | Draft revision → blocking errors/warnings | `forms.edit`; same validator as publish |
| POST `O/forms/:id/publish` | Expected revision, idempotency key → version | `forms.publish`; immutable snapshot |
| GET `O/forms/:id/versions` | Version summaries | `forms.read` |
| POST `O/forms/:id/activate-version` | Version ID → active pointer | `forms.publish`; same-form version only |
| POST `O/forms/:id/close` | Reason → state | `forms.publish`; ingestion closes immediately |
| POST `O/forms/:id/reopen` | Expected state → state | `forms.publish`; active valid version required |
| PATCH `O/forms/:id/access-policy` | Mode, schedule, limits | `forms.publish`; cannot supply credential hash |
| POST `O/forms/:id/duplicate` | Name → independent draft | `forms.create`; no submissions/secrets copied |
| DELETE `O/forms/:id` | Reason → purge job reference | `forms.delete`; retention semantics |
| GET/PUT `O/forms/:id/grants` | Resource permissions | `forms.manage_access` |
| GET `O/forms/:id/share` | Public link, embed options, QR payload | `forms.read`; no receipt/resume secrets |
| POST `O/forms/:id/ai-jobs` | Prompt, operation, baseRevision → 202 job | `forms.edit`, AI enabled, budget reserved |
| GET `O/ai-jobs/:jobId` | Status, proposal if authorized | Requester/admin policy |
| POST `O/ai-jobs/:jobId/apply` | Expected revision → draft | `forms.edit`; revalidate proposal |
| POST `O/ai-jobs/:jobId/cancel` | → current job state | Requester/admin |
| GET `O/forms/:id/submissions` | Cursor, filters → masked rows | `responses.read` |
| GET `O/forms/:id/submissions/:sid` | Answers + source version + delivery states | `responses.read` and field masks |
| PATCH `O/forms/:id/submissions/:sid` | Expected revision, edits, reason | P2 `responses.edit`; immutable revision audit |
| DELETE `O/forms/:id/submissions/:sid` | Reason → deletion job | `responses.delete`; hold checks |
| POST `O/forms/:id/exports` | Filters, columns, format → 202 export job | `responses.export` |
| GET `O/exports/:id` | Status, short-lived authorized download | Reauthorize requester |
| GET `O/forms/:id/analytics` | Date window/version → aggregates | `analytics.read`; no unmasked answers |
| POST `O/integrations` | Provider, OAuth initiation/config ref | `integrations.manage` |
| GET `O/deliveries` | Filters → delivery status | Form-level workflow grant |
| POST `O/deliveries/:id/retry` | Reason → scheduled retry | `workflows.manage`; preserve dedupe key |
| GET `O/approval-tasks` | Assigned tasks and field projections | P2 assignee permissions |
| POST `O/approval-tasks/:id/decision` | approve/reject, reason, expected state | P2 current assignee; CAS pending state |
| GET `O/usage` | Current meters and limits | `organization.usage.read` |
| GET `O/audit` | Cursor/filter → metadata | `organization.audit.read` |

P2 workflow CRUD includes draft validation, immutable activation snapshots, run inspection, cancellation, and task reassignment. P3 domains include add, ownership verification, status, and revoke; billing includes checkout/portal initiation and signed callbacks. Implement route schemas with their phase, not fake success endpoints.

## 3. Public runtime contract

| Route | Contract |
|---|---|
| GET `/public/v1/forms/:slug` | Safe published metadata/projection only after access checks; private forms no-store |
| POST `/public/v1/forms/:slug/sessions` | Resolve auth/invite/password if applicable; issue session capability, versionId, expiry, projection |
| POST `/public/v1/sessions/:id/uploads` | Session capability, fieldId, declared size/type → constrained signed upload URL + uploadId |
| POST `/public/v1/sessions/:id/uploads/:uploadId/complete` | Verify actual object metadata; enqueue scan; returns processing state |
| GET `/public/v1/sessions/:id/uploads/:uploadId` | Capability-scoped scan status only |
| POST `/public/v1/sessions/:id/submissions` | Capability header, Idempotency-Key, versionId, answers → receipt |
| POST `/public/v1/sessions/:id/payment-session` | P2 pending submission ID → hosted provider redirect |
| PUT `/public/v1/sessions/:id/draft` | P2 version-bound partial answers, consent → resume setup |
| POST `/public/v1/resume/exchange` | P2 token → scoped session, rotate token as policy requires |

Capability tokens: cryptographically random >=256 bits, hashed at rest, scoped to exact session/form/version, short lived, never logged. A capability permits writing that session and inspecting its uploads/receipt; it does not permit listing responses. Browser stores in memory; save/resume is explicit P2. Private embeds must accommodate authentication restrictions rather than weaken access control for third-party cookie compatibility.

Example submit:

```http
POST /public/v1/sessions/SESSION_UUID/submissions
Authorization: Bearer SESSION_CAPABILITY
Idempotency-Key: CLIENT_GENERATED_UUID
Content-Type: application/json

{
  "formVersionId": "VERSION_UUID",
  "answers": {
    "f_name": "Asha",
    "f_email": "asha@example.com",
    "f_category": "opt_technical",
    "f_details": "I cannot access my account",
    "f_consent": true
  }
}
```

Success: `201 {submissionId, receiptId, receivedAt, intakeState:"accepted", message}`. Retrying the identical request returns the recorded receipt with a replay header; it cannot enqueue duplicate work. Receipt contains no answer payload by default.

## 4. Versioned event envelope

```json
{
  "eventId": "EVENT_UUID",
  "eventType": "submission.accepted.v1",
  "occurredAt": "2026-10-14T12:00:00Z",
  "tenantId": "TENANT_UUID",
  "aggregateId": "SUBMISSION_UUID",
  "traceId": "TRACE_ID",
  "data": {
    "formId": "FORM_UUID",
    "formVersionId": "VERSION_UUID",
    "submissionId": "SUBMISSION_UUID",
    "submissionRevision": 1
  }
}
```

Events refer to protected records rather than broadcasting answers. Consumers fetch only their approved field projection. Types include `form.published.v1`, `submission.accepted.v1`, `submission.updated.v1`, `approval.completed.v1`, `payment.succeeded.v1`, `file.scan_completed.v1`, and `integration.delivery_failed.v1`. New event versions accompany breaking changes; additive fields must be ignored safely by older consumers.

## 5. Workeasy integration contracts

Existing endpoint URLs and auth schemes are unknown. The following are **adapter interfaces to implement**, not claims about current systems.

| Destination | Proposed action | Example mapping | Required safeguards |
|---|---|---|---|
| workeasy-Helpdesk | `createTicket` | name/email/subject/details/category → requester/title/body/queue | Explicit queue mapping, attachment authorization, dedupe by submission/action |
| workeasy-HRMS | `createIntakeRequest` | employee reference/request type/dates/documents → HR intake | Verify employee against tenant identity; no automatic employee mutation from anonymous input |
| workeasy-Ai-agent-platform | `startAgentRun` | authorized field projection + approved agent ID → run input | Allowlisted agent, tenant credentials, no tool expansion from form answers |

Each adapter exposes `validateConnection`, `describeDestinationFields`, `validateMapping`, `execute`, and `reconcile`. Persist external record/run ID and a safe deep link after success. Mapping uses stable field IDs, explicit transformations, and version compatibility checks. Test/sandbox connections are distinct from production connections. Public input cannot choose destination organization, connector credential, agent ID, or queue outside allowlisted options.

Credential references live in a secret manager. OAuth uses state/PKCE where supported and narrow scopes. Revocation stops pending deliveries with a visible reconnect status. Token refresh is serialized per connection. Destination records are not silently deleted when source responses are purged; deletion propagation is an explicit audited policy/contract.

## 6. Webhooks and email

Webhook payloads contain only configured fields, version, event/submission identifiers, and timestamp. Sign exact request bytes with HMAC-SHA256 and secret rotation, sending event ID, signature, and timestamp headers. Document a five-minute replay tolerance for consumers. Initial delivery: 10s timeout, bounded response body, retries after approximately 1m/5m/30m/2h/8h/24h with jitter; 429 honors bounded Retry-After. Retry 408/429/5xx/network errors; most other 4xx fail permanently. Surface ambiguous timeouts and dedupe requirements.

Before connections and every delivery: resolve destination, block loopback/private/link-local/metadata addresses for IPv4 and IPv6, restrict scheme to HTTPS and allowed ports, disable redirects, and bind connection to a checked address while preserving TLS hostname validation. Use an egress proxy for defense against DNS rebinding. See [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

Email uses a trusted provider, escaped templates, verified sender domain, and bounded recipient lists. Respondent email fields must not allow arbitrary CC/BCC or template injection. Rate-limit public autoresponders to prevent mail bombing. Prefer response links over sensitive answer bodies. Track accepted/sent/bounced status separately; do not equate API acceptance with inbox delivery.

## 7. Approval workflow design (P2)

Workflow is a versioned DAG of trigger, condition, action, approval, delay, and end nodes. Validate acyclicity, bounded node count, reachable end, and valid assignees before activation. Snapshot workflow and connector mappings when publishing; runs pin submission revision and snapshot hash. Later configuration changes do not rewrite active runs.

Run states: `pending -> running -> waiting -> succeeded | rejected | failed | cancelled`. Step states: `pending -> running -> waiting | succeeded | failed | skipped`. Approved/rejected decisions append immutable audit entries. Parallel approval policy explicitly chooses all/any/quorum; count decisions transactionally and close remaining tasks when policy resolves. A task decision is accepted only once from its current eligible assignee.

Timeout action must be configured as reminder, escalation, or rejection; never silently approve. Delay deadlines live in PostgreSQL and survive restarts. Deleted/deactivated assignees require reassignment. Submission edits create a new revision; default policy invalidates pending approval tasks and requires explicit restart before downstream actions. Completed side effects are not undone automatically.

## 8. Payment design (P2)

Use hosted checkout or provider-hosted fields. Never collect or store card PAN/CVV in Workeasy fields. Tenant payment connections receive funds under the provider's supported merchant/account model; platform subscription billing is a different module.

1. Validate form and create `pending_payment` submission with server-derived amount/currency and expiring capacity/usage reservation; no accepted event yet.
2. Create checkout with stable provider idempotency key from payment attempt ID.
3. Client redirect is informational; only verified provider webhook/reconciliation can mark paid.
4. Callback verifies signature against raw bytes, account ownership, amount, currency, and provider object. Deduplicate event in provider inbox, acknowledge durably, process asynchronously.
5. State transition to paid atomically consumes reservations and emits one `submission.accepted.v1` plus `payment.succeeded.v1`. Do not increment normal response quota again.
6. Reconcile missing callbacks and ambiguous attempts with provider API. Expired checkout releases reservations; a late paid event enters explicit reconciliation/refund handling rather than being discarded.

Payment states: `not_required`, `pending`, `paid`, `failed`, `expired`, `partially_refunded`, `refunded`, `disputed`. Intake, approval, and payment are separate state axes. Partial refunds use cumulative amount checks and immutable refund records. Refund authority is an explicit permission. Provider callbacks can arrive out of order or more than once; [Stripe's webhook documentation](https://docs.stripe.com/webhooks) describes these delivery characteristics. Exact behavior must also be verified for whichever provider is selected.

## 9. Offline sync (P3)

Explicit opt-in for authorized field collectors, not automatic anonymous browser persistence. Device registration and version download bind a tenant/user/device. Encrypt local database where platform capabilities permit; define retention and remote revocation limitations. Each local response has device ID + local UUID as a durable server uniqueness key. Sync authenticates current device, checks pinned version policy, uploads files resumably, then accepts response idempotently.

Server rejection for revoked access/closed version/quota does not delete local data silently; show resolution state and authorized export options. Device time is metadata only; server received time is authoritative. Payment, live lookups, and online identity checks are unavailable offline. No promise of browser encryption protecting data from a fully compromised device.
