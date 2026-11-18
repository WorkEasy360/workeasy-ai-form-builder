# Sign-in with WorkEasy360 Accounts

Workeasy Forms can sign people in with **WorkEasy360 Accounts**, the identity provider of the WorkEasy360 product family. The console never sees a WorkEasy360 password. It receives an ID token that names:

- the person (`sub`);
- the WorkEasy360 organization they chose (`organization_id`);
- this product (`product_code`).

It then keeps its own session, authorizes on organization and role, asks WorkEasy360 whether the organization is still entitled, and ends the session when WorkEasy360 says so (back-channel logout).

It is **off** until `WORKEASY360_ISSUER` is set. Email and password sign-in keeps working unless `WORKEASY360_SSO_ONLY=true` ([Migration](#migration-safety)).

## What happens, step by step

| Step | What Forms does | Where |
|---|---|---|
| Start | `GET /auth/workeasy360/start[?organization=<uuid>]`. Generates state, nonce and a PKCE S256 verifier and stores them **in PostgreSQL** (`app.workeasy360_login_flows`, 10 minutes). The browser holds only a random flow id in an httpOnly cookie (`__Host-we_w360_flow` over https). The launcher's organization is forwarded as the `organization` hint. | `apps/api/src/workeasy360/routes.ts`, `client.ts` |
| Callback | `GET /auth/workeasy360/callback`. **Takes** (deletes) the flow before anything else, so it is used once. Compares the state in constant time. | `routes.ts` |
| Code exchange | openid-client 6 `authorizationCodeGrant` with the PKCE verifier. Client authentication is **`private_key_jwt`**: the assertion has `iss = sub = client id`, `aud` = the token endpoint, a 60 s lifetime and a fresh `jti`, signed with `WORKEASY360_PRIVATE_KEY_FILE` (kid `WORKEASY360_KEY_ID`). No client secret exists. | `client.ts` |
| ID token | Verified **again, by Forms itself, with jose against the provider's key set** (`jwks_uri`), whatever the exchange already checked: key by `kid`, algorithm from an allow-list (RS256, ES256), `iss` exactly `WORKEASY360_ISSUER`, `aud` exactly the client id, `exp`/`iat` with 30 s skew, `typ` = `id_token`, `nonce`, `product_code` = `WORKEASY360_PRODUCT_CODE`, `organization_id` present, `email_verified` = true. | `client.ts` `verifyIdToken` |
| Launcher check | If the sign-in started with `?organization=`, the token must name that organization. | `routes.ts` |
| Entitlement | Asks the entitlement endpoint from discovery (`workeasy360_entitlement_endpoint`) for the organization and the person, with a `private_key_jwt` client assertion. A denial ends the sign-in on a "no access" page with a purchase path. | `entitlements.ts` |
| Tenant | Maps the organization to its tenant (`tenants.external_org_id`). The organization's first sign-in creates the tenant, unless `WORKEASY360_PROVISION_TENANTS=false`. An existing tenant is linked with an operator command. | `packages/database/src/repositories/workeasy360.ts` |
| Person | Linked on **(issuer, sub)**, never on email. | `provisionSignIn` |
| Membership | An active membership keeps its role. A revoked one is refused. None yet: created with `WORKEASY360_DEFAULT_ROLE` (`creator`); the first person of a new tenant is its `owner`. | `provisionSignIn` |
| Session | Any session the browser already held ends. A new server-side session is bound to **that one tenant**, with the provider's `sid`. The cookie is httpOnly, `__Host-we_session` over https: Secure, host-only, never a `.workeasy360.com` cookie. | `identity.ts` `createSession` |

Every failure lands on `/?sso_error=<code>` (a fixed vocabulary; see `SsoErrorCode` in `routes.ts`). The console shows one message per code. Codes, tokens, state and nonce are never logged.

## Authorization: organization and role, never `sub` alone

- A WorkEasy360 session reaches **only** the tenant its token named. Any other organization answers 404, exactly as for a non-member, even when the person has memberships elsewhere. `GET /api/v1/me` lists only that organization.
- A WorkEasy360 session cannot create organizations (`POST /api/v1/organizations` → 403 `WORKEASY360_ORGANIZATIONS`); organizations come from WorkEasy360. It cannot accept an invitation to another organization (403 `WORKEASY360_OTHER_ORGANIZATION`).
- Inside the tenant, the role and per-form grants decide, as before. Removing someone in Forms (Members → revoke) keeps them out: their next WorkEasy360 sign-in is refused (`membership_revoked`).

## Entitlement, on WorkEasy360's schedule

Every `/api/v1/organizations/:orgId/...` request to a tenant linked to WorkEasy360 goes through `organizationGate` (`apps/api/src/workeasy360/access.ts`). This includes password sessions of members of a linked tenant: they are asked about per organization.

- **Cache:** the answer is kept for `min(revalidate_after, 900)` seconds (at least 30), in PostgreSQL (`app.workeasy360_entitlements`), shared by every API instance, plus each process's own copy. WorkEasy360 is never asked per request.
- **Denial:** re-asked after 60 s. Until then, and through any outage, it stands. A known denial is kept without expiry, so neither a restart nor an outage hands access back. The answer is 403 `WORKEASY360_ACCESS_ENDED` with `reason` (`not_entitled`, `expired`, `suspended`, `membership_inactive`, `no_seat`). The session stays valid, so the console shows "access has ended" with a purchase link and sign-out.
- **Read-only:** while `write_allowed` is false, writes answer 403 `WORKEASY360_READ_ONLY`. Reads, validation and exports still work.
- **Outage:** a 5xx, a 429, a timeout or a network error is never a denial. The last answer stands; with none yet, access continues. WorkEasy360 is asked again after 60 s.
- **Refusal of the client:** a 400, 401 or 403 from the entitlement endpoint (a revoked credential, a suspended integration) fails **closed** for the whole client. For 60 s every question answers 403 `WORKEASY360_ACCESS_UNVERIFIED`, and a 429 within five minutes of the refusal counts as one. Then one question is asked again.
- **When the person arrives:** the callback asks afresh, and a denial ends the sign-in on the "no access" page. An outage at that moment does not lock anyone out, because WorkEasy360 has just checked the entitlement before issuing the code.

## Back-channel logout, and the session check on every request

`POST /auth/workeasy360/backchannel-logout` with the form field `logout_token`. The call is server to server, so no cookie and no CSRF token are involved; the provider's signature is the authentication.

The logout token is verified with jose against the provider's key set:

- JOSE `typ` is `logout+jwt`, and a `typ` claim, if present, is `logout_token`;
- the signature is by `kid` (RS256 or ES256);
- `iss` is exactly ours and `aud` is our client id;
- `iat` is not in the future and at most 10 minutes old, and `exp` has not passed;
- the back-channel-logout event is present, and there is **no `nonce`**;
- `sub` and/or `sid` are present, and so is a `jti`.

Then, in **one PostgreSQL transaction** (`app.workeasy360_end_sessions`):

1. The `jti` is recorded once per issuer (`app.workeasy360_logout_tokens`).
2. With `sid`, the sessions that WorkEasy360 sign-in opened end (narrowed to `sub` when both are present). With `sub` alone, every session of that person ends.

The receiver answers:

- **200** when the token is verified. A **duplicate** delivery also gets 200 and changes nothing.
- **400** `invalid_request` when the token is invalid.
- **503** when the key set or the database is unreachable, so WorkEasy360 delivers again. Nothing was recorded.

**The per-request check:** every authenticated request resolves its cookie through `app.resolve_session` in PostgreSQL, and nothing is cached in a process. A session ended by a logout token delivered to *any* instance is refused (401) by *every* instance on its next request.

## Signing out

- **Sign out** (`POST /auth/logout`) ends the Forms session only.
- **Sign out of WorkEasy360 too** (`POST /auth/logout?workeasy360=1`, shown only for a WorkEasy360 session) first ends the Forms session. It then sends the browser to WorkEasy360's `end_session_endpoint` with `id_token_hint`, `client_id` and the registered `WORKEASY360_POST_LOGOUT_REDIRECT_URI`. WorkEasy360 asks the person to confirm.

## Register in Super Admin

The platform catalog has **no `workeasy_forms` product yet**: create it first (Products → Add product), or set `WORKEASY360_PRODUCT_CODE` to whatever code it gets. Then, under Product → Integration:

| Field | Value |
|---|---|
| Launch URL | `https://<console host>/auth/workeasy360/start` (the launcher appends `?organization=<uuid>`) |
| Redirect URI | `https://<console host>/auth/workeasy360/callback`, exactly |
| Back-channel logout URI | `https://<console host>/auth/workeasy360/backchannel-logout` (same origin as the redirect URI) |
| Post-logout redirect URI | `https://<console host>/`, exactly what `WORKEASY360_POST_LOGOUT_REDIRECT_URI` says |
| Scopes | `openid email profile organization`. `email` is required: `email_verified` comes with it. `organization` labels a tenant created on a first sign-in. |
| Token endpoint auth method | `private_key_jwt` |
| Sign-in mode | `sso_optional` with login URL `https://<console host>/` while password sign-in is on. `sso_only` once `WORKEASY360_SSO_ONLY=true`. |
| Credential | The **public** key below. Its credential id is `WORKEASY360_KEY_ID`. |

Generate the key pair on the product's machine. The private key goes only into the secret manager, mounted into the api container as a file:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out workeasy360-forms.pem   # private: never commit
openssl pkey -in workeasy360-forms.pem -pubout -out workeasy360-forms.pub.pem              # public: paste into Super Admin
```

RSA keys (RS256) work too.

### Hostnames: a prerequisite to go live

WorkEasy360 activates an integration only once **every hostname in it is proven by a DNS TXT record** (`_w360-product-verify.<host>`, ADR-070).

The deployed console runs on `forms-admin.54-255-105-162.sslip.io`, and the forms on `forms.54-255-105-162.sslip.io`. Nobody here controls the `sslip.io` zone, so those names **cannot be proven**. A real hostname on `workeasy360.com` (or another owned domain) for the console is a prerequisite for going live, for example `forms-admin.workeasy360.com`. Until then, only local loopback hosts work: they need no record.

## Environment

All names are those of the WorkEasy360 integration kit's `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `WORKEASY360_ISSUER` | (empty: off) | Exactly the issuer WorkEasy360's discovery document names, **no trailing slash**. https; plain http only for a loopback issuer (`127.0.0.1`, `localhost`) outside production. |
| `WORKEASY360_CLIENT_ID` | | The client id from the registration. |
| `WORKEASY360_PRODUCT_CODE` | `workeasy_forms` | Must equal the ID token's `product_code`. |
| `WORKEASY360_REDIRECT_URI` | `<CONSOLE_PUBLIC_URL>/auth/workeasy360/callback` | Must be exactly that address. |
| `WORKEASY360_POST_LOGOUT_REDIRECT_URI` | `<CONSOLE_PUBLIC_URL>/` | On the console origin; registered exactly. |
| `WORKEASY360_KEY_ID` | | The credential id (`kid` of the client assertion). |
| `WORKEASY360_PRIVATE_KEY_FILE` | | PEM file, RSA or EC P-256. Never in the repository or an image. |
| `WORKEASY360_SCOPES` | `openid email profile organization` | Must include `openid` and `email`. |
| `WORKEASY360_SSO_ONLY` | `false` | `true`: WorkEasy360 is the only way in ([Migration](#migration-safety)). |
| `WORKEASY360_DEFAULT_ROLE` | `creator` | Role for someone joining an existing tenant. |
| `WORKEASY360_PROVISION_TENANTS` | `true` | `false`: only tenants linked by the operator can be signed in to. |
| `WORKEASY360_PURCHASE_URL` | the issuer | The "Get Workeasy Forms" link on the no-access page. |

`ISSUER`, `CLIENT_ID`, `KEY_ID` and `PRIVATE_KEY_FILE` must all be set, or none. The API refuses to start otherwise, or with a trailing slash, a non-https issuer in production, a redirect URI elsewhere, or `OIDC_ISSUER_URL` equal to the WorkEasy360 issuer. The generic `OIDC_*` provider is now optional: set all three, or none.

## Migration safety

**Password sign-in keeps working** while `WORKEASY360_SSO_ONLY` is false, which is the default. Deployed customers are not locked out by this change. Their password sessions in a tenant that an operator links to WorkEasy360 are then subject to that organization's entitlement.

**With `WORKEASY360_SSO_ONLY=true`:**

- `/auth/password/*` answers 403 `PASSWORD_SIGN_IN_DISABLED`;
- the generic single sign-on redirects to WorkEasy360;
- every session opened another way is refused at once (401 `WORKEASY360_SIGN_IN_REQUIRED`);
- nobody can create an organization in Forms.

Switch it on only after every customer's owners can sign in with WorkEasy360. Link their tenants and accounts first (below).

**What happens to existing accounts.** People are keyed on `(issuer, subject)`. Nothing is merged by email.

| Existing account | On the person's first WorkEasy360 sign-in |
|---|---|
| Password account (`urn:workeasy:password`, subject = email) | Untouched. The WorkEasy360 person is a **separate** user: in a linked tenant they join with the default role. To carry the password account's role, forms and grants over instead, run `link-workeasy360-user` **before** their first WorkEasy360 sign-in. Otherwise an owner promotes the new member on the Members page. |
| Generic OIDC account (`OIDC_ISSUER_URL`, e.g. Cognito or Dex) | Untouched, and never matched: its subjects are not WorkEasy360's. Use `link-workeasy360-user` per person if you want the account carried over. |
| WorkEasy360 account under a **previous issuer name** (an issuer move, ADR-067, for example `https://app.workeasy360.com` to `https://accounts.workeasy360.com`) | **Refused** with `sso_error=identity_conflict`, and logged, instead of silently creating a second account for the same `sub`. Run `move-identity-issuer` in the same release that changes `WORKEASY360_ISSUER`. |

`workeasy360-identities` shows how many users and live sessions each issuer holds, so you can see whether a move is needed.

## Operator commands

They run as the owner role (`DATABASE_MIGRATION_URL`) from the repository root: `pnpm --filter @workeasy/database db <command>`. On a server, run them in the api container with the same environment.

| Command | What it does |
|---|---|
| `link-workeasy360-organization <tenant-id> <workeasy360-organization-id> [--replace-empty]` | Sign-ins from that organization land in this existing tenant. A tenant already linked to another organization is never re-pointed. If a first sign-in already created a tenant for the organization, the command refuses. Add `--replace-empty` to unlink and suspend that tenant if it holds no forms; its WorkEasy360 sessions end. Audited (`organization.linked_to_workeasy`). |
| `link-workeasy360-user <user-id> <workeasy360-sub> [--issuer <issuer>]` | You vouch that an existing account (password or another provider) is this WorkEasy360 person. It is re-keyed to `(issuer, sub)` and keeps its memberships, forms and grants. Refused when that WorkEasy360 identity already has its own user. `--issuer` defaults to `WORKEASY360_ISSUER`. |
| `move-identity-issuer --from <old> --to <new> [--apply]` | The identity move of an issuer change. Every user `(old, sub)` becomes `(new, sub)`, and so do live WorkEasy360 sessions. Without `--apply` it only reports. It refuses, listing the pairs, when a subject already has a user under the new issuer: two accounts are never merged. |
| `workeasy360-identities` | Users and live sessions per issuer. |

## Run it locally against a WorkEasy360 provider on `http://127.0.0.1:8031`

1. Run a WorkEasy360 platform locally with issuer `http://127.0.0.1:8031`.
2. Create the catalog product `workeasy_forms`.
3. Register the integration with these addresses:
   - redirect URI `http://localhost:3000/auth/workeasy360/callback`;
   - back-channel logout URI `http://localhost:3000/auth/workeasy360/backchannel-logout`;
   - post-logout URI `http://localhost:3000/`;
   - scopes `openid email profile organization`.
4. Add the public key, activate, and grant the product to a test organization. Loopback hosts need no DNS proof; http redirect URIs are accepted outside production.
5. Fill in `.env`:

   ```dotenv
   WORKEASY360_ISSUER=http://127.0.0.1:8031
   WORKEASY360_CLIENT_ID=<client id>
   WORKEASY360_KEY_ID=<credential id>
   WORKEASY360_PRIVATE_KEY_FILE=../secrets/workeasy360-forms.pem
   WORKEASY360_REDIRECT_URI=http://localhost:3000/auth/workeasy360/callback
   WORKEASY360_POST_LOGOUT_REDIRECT_URI=http://localhost:3000/
   ```

6. Start the stack: `pnpm infra:up && pnpm db:setup && pnpm dev`.
7. Open `http://localhost:3000/` and choose **Continue with WorkEasy360**. You can also open `http://localhost:3000/auth/workeasy360/start?organization=<organization uuid>` as the launcher would.

The platform must reach `http://localhost:3000/auth/workeasy360/backchannel-logout` from where it runs. The console proxies `/auth/*` to the API.

### Proving 200 vs 401 from a script

The protected endpoint is **`GET /api/v1/me`** on the console origin. The credential is the **session cookie** set by the callback: `we_session` over http, `__Host-we_session` over https.

```bash
# after signing in in a browser, copy the cookie value from the browser's dev tools
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: we_session=<value>' http://localhost:3000/api/v1/me   # 200
# sign out everywhere in WorkEasy360 (or let it deliver a logout token), then the same call:
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: we_session=<value>' http://localhost:3000/api/v1/me   # 401
```

Over https, use `Cookie: __Host-we_session=<value>` against `https://<console host>/api/v1/me`.

`GET /api/v1/organizations/<tenant id>/access` answers 200 `{ ok, role }` while the organization is entitled, and 403 `WORKEASY360_ACCESS_ENDED` once it is not.

## Tests

`apps/api/src/workeasy360.int.test.ts` runs against a fake WorkEasy360 provider built in the test suite (`apps/api/src/workeasy360/fake-provider.ts`). Its keys are generated when it starts. It serves discovery, the key set, authorize, token (checking `private_key_jwt` and PKCE as the platform does), entitlement and end-session. The tests cover:

- the happy path;
- a wrong issuer, audience, signature, nonce or `typ`;
- a missing or used flow, and a wrong state;
- a wrong product code;
- a missing organization;
- an unverified email;
- a token for another organization than the launcher asked for;
- an organization that is not entitled;
- cross-organization access refused;
- the operator link, including `--replace-empty`;
- revoked members;
- entitlement re-checks: read-only, denial, outage, refusal of the client;
- logout tokens: valid (sid and sub), forged (bad signature, other issuer, other audience, wrong `typ`, missing event, with nonce, too old, neither sub nor sid), duplicate, and a replayed `jti`;
- sessions refused at once on **two app instances** sharing the database;
- both sign-outs;
- SSO-only;
- the identity moves.

`apps/api/src/workeasy360/config.test.ts` covers the configuration rules.

## Not covered yet

- **Respondent sign-in for organization-only forms** still uses the generic `OIDC_*` provider on the respondent origin. With only WorkEasy360 configured, organization-only forms cannot be filled in by signed-in members until a respondent-side WorkEasy360 flow is added. That flow needs a second redirect URI on the forms host, with its own DNS proof.
- **Automatic start** for SSO-only products (integration guide §6b): when someone opens Forms with no session, it shows its sign-in page with "Continue with WorkEasy360" rather than starting the sign-in by itself.
- `prompt=login` ("confirm it's you") for sensitive actions is not used.
