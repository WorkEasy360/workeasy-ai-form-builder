# API guide (DOC-01)

The full contract is [`contracts/openapi.json`](../contracts/openapi.json) (OpenAPI 3.1), generated from the request and response schemas and checked for drift in CI. Open it in any OpenAPI viewer, for example `npx @redocly/cli preview-docs contracts/openapi.json`. This page explains the conventions the contract relies on.

## Two APIs

| | Console API `/api/v1` | Public API `/public/v1` |
|---|---|---|
| Used by | The console (people who build forms and read responses) | Published forms (respondents) |
| Reached through | The console's address: `https://<console>/api/v1/...` | The forms address: `https://<forms>/public/v1/...` |
| Identity | Session cookie from signing in with your identity provider | A per-session capability token; sign-in only for organization-only forms |

There are no API keys for server-to-server use yet. To receive responses in another system, use a signed webhook (below).

## Console API conventions

- **Signing in:** `GET /auth/login` starts OpenID Connect; the callback sets an HttpOnly session cookie. `GET /api/v1/me` returns the user and their organizations with the permissions they hold.
- **Same origin:** every request that changes something must send the console's `Origin` header. Browsers do this; scripts must too.
- **Organizations:** routes start with `/api/v1/organizations/{orgId}`. An organization you are not an active member of, or a form you cannot read, answers `404` so its existence is not revealed. Missing a permission on something you can see answers `403`.
- **Permissions:** organization roles (owner, admin, creator, analyst, approver) plus per-form grants. Each operation's required permission is in its description in the contract.
- **Drafts and conflicts:** `GET …/forms/{id}/draft` returns an `ETag` like `"draft-7"`. `PUT …/draft` and `POST …/publish` need it in `If-Match`; if someone saved since, you get `412 DRAFT_CONFLICT` and nothing is overwritten.
- **Retries:** `POST …/publish` takes an `Idempotency-Key` (8–200 printable characters). Repeating a request with the same key returns the original result instead of publishing twice.
- **Lists:** responses, audit entries, jobs and deliveries are keyset-paginated. Pass the `nextCursor` from one page as `cursor` to get the next; a listing is fixed at the moment its first page was read, so pages never repeat or skip items.

## Public API flow

1. `GET /public/v1/forms/{slug}`: the published form, or `404`/`410` (closed, full, not open yet) with a reason.
2. `POST /public/v1/forms/{slug}/sessions`: starts a respondent session pinned to the current version. Returns `sessionId`, `versionId` and `capability`.
3. Optional files: `POST /public/v1/sessions/{id}/uploads`, upload the bytes to the returned URL, then `…/complete`; poll `GET …/uploads/{uploadId}` until it is `clean`.
4. `POST /public/v1/sessions/{id}/submissions` with `Authorization: Bearer <capability>`, an `Idempotency-Key`, and `{ formVersionId, answers }`. `201` returns a receipt. Sending the same key again returns the same receipt; a different body with the same key is `409`.

Answers are validated by the same engine the form page runs. Answers to questions hidden by rules are dropped.

## Errors

Every error is `application/problem+json`:

```json
{ "type": "urn:workeasy:error:validation_failed", "title": "Some fields need attention", "status": 422,
  "code": "VALIDATION_FAILED", "requestId": "req_…", "errors": [{ "field": "answers.f_email", "code": "INVALID_EMAIL", "message": "…" }] }
```

Branch on `code`, not on `title`. Quote `requestId` when asking for help: it finds the request in the server logs.

## Webhooks

Each accepted response is POSTed to the webhook URL as JSON (`version`, `eventId`, `eventType`, `formId`, `submissionId`, `receivedAt`, and the answers chosen when the webhook was set up), with:

- `Workeasy-Event-Id`: the same on every retry; deduplicate on it.
- `Workeasy-Timestamp` and `Workeasy-Signature: v1=<hex>`: HMAC-SHA256 of `"<timestamp>.<raw body>"` with the signing secret. Reject timestamps more than 5 minutes old. During a secret rotation two `v1=` signatures are sent; accept either.

Answer `2xx` within 10 seconds. Timeouts, `408`, `429` and `5xx` are retried for about a day; other responses fail the delivery, which an admin can send again from the console.

## Changing the contract

Edit the schemas in `apps/api/src/contract/schemas.ts` and the route list in `openapi.ts`, then run `pnpm --filter @workeasy/api openapi:write`. CI fails if `contracts/openapi.json` is out of date. Breaking changes need a new path version (`/api/v2`).
