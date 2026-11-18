import { randomBytes } from "node:crypto";
import express, { Router, type Response } from "express";
import { identityRepo, workeasy360Repo, type Db } from "@workeasy/database";
import type { Logger } from "@workeasy/observability";
import { clearCookie, parseCookies, serializeCookie } from "../http/cookies.js";
import { requestIdOf, requestLog } from "../http/request-context.js";
import { createAttemptLimiter } from "../identity/passwords.js";
import { Workeasy360Error } from "./client.js";
import type { Workeasy360Runtime } from "./runtime.js";

/** How long a sign-in may take between the redirect to WorkEasy360 and the callback. */
export const FLOW_TTL_SECONDS = 600;
/** A logout token is a compact JWS of well under 2 KB; anything much larger is not one. */
const MAX_LOGOUT_TOKEN_LENGTH = 16 * 1024;
const MAX_CODE_LENGTH = 2048;
/** Sign-ins this server starts per minute, at most. */
const MAX_STARTS_PER_MINUTE = 600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Console pages someone may be sent back to after signing in: an organization's pages. */
const ORGANIZATION_PATH = /^\/o\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/[A-Za-z0-9/_-]{0,300})?$/i;

/**
 * Why a WorkEasy360 sign-in did not complete, as the console shows it
 * (`/?sso_error=<code>`). A fixed vocabulary: never a token, a code, a state
 * or a provider's description.
 */
export type SsoErrorCode =
  | "expired"
  | "unavailable"
  | "rate_limited"
  | "cancelled"
  | "refused"
  | "invalid_token"
  | "wrong_product"
  | "no_organization"
  | "email_unverified"
  | "wrong_organization"
  | "not_entitled"
  | "membership_inactive"
  | "organization_inactive"
  | "integration_suspended"
  | "access_policy_denied"
  | "access_unverified"
  | "tenant_suspended"
  | "membership_revoked"
  | "no_tenant"
  | "identity_conflict";

/** The provider's OAuth error codes (OIDC contract §7) this product shows a specific message for. */
const PROVIDER_ERRORS: Record<string, SsoErrorCode> = {
  access_denied: "cancelled",
  invalid_grant: "expired",
  product_not_entitled: "not_entitled",
  membership_inactive: "membership_inactive",
  organization_inactive: "organization_inactive",
  integration_suspended: "integration_suspended",
  access_policy_denied: "access_policy_denied",
  temporarily_unavailable: "unavailable",
  server_error: "unavailable",
};

/** Entitlement reasons (entitlement API §4) the console has a page for. */
const DENIAL_REASONS = new Set(["not_entitled", "expired", "suspended", "read_only", "membership_inactive", "no_seat"]);

class SignInRefused extends Error {
  constructor(
    readonly code: SsoErrorCode,
    readonly detail: string,
    readonly reason?: string,
  ) {
    super(detail);
  }
}

function codeForError(err: unknown): SsoErrorCode {
  if (err instanceof SignInRefused) return err.code;
  if (err instanceof Workeasy360Error) {
    switch (err.code) {
      case "state_mismatch":
        return "expired";
      case "sign_in_refused":
        return PROVIDER_ERRORS[err.detail] ?? "refused";
      case "wrong_product":
      case "no_organization":
      case "email_unverified":
      case "invalid_token":
      case "rate_limited":
        return err.code;
      case "provider_refused":
        return "access_unverified";
      default:
        return "unavailable";
    }
  }
  return "unavailable";
}

function describe(err: unknown): string {
  if (err instanceof SignInRefused || err instanceof Workeasy360Error) return err.detail || (err instanceof Workeasy360Error ? err.code : "");
  return err instanceof Error ? err.name : "unknown";
}

export interface Workeasy360RouterOptions {
  db: Db;
  logger: Logger;
  runtime: Workeasy360Runtime;
  consoleOrigin: string;
  secure: boolean;
  sessionCookie: string;
  sessionTtlMs: number;
  homeRegion: string;
}

/**
 * "Continue with WorkEasy360" at /auth/workeasy360 on the console origin:
 *
 * - `GET /start[?organization=<uuid>][&returnTo=/o/...]` keeps state, nonce
 *   and the PKCE verifier on the server (single use, 10 minutes), gives the
 *   browser a random flow id in an httpOnly cookie, and redirects to the
 *   provider - with the organization the launcher named, if any;
 * - `GET /callback` takes the flow first whatever happens next, compares the
 *   state, exchanges the code (private_key_jwt + PKCE), verifies the ID token,
 *   asks the entitlement endpoint, maps the organization to its tenant, ends
 *   any session this browser already holds and opens a session bound to that
 *   one tenant;
 * - `POST /backchannel-logout` is the OpenID Connect Back-Channel Logout
 *   receiver (server to server; the provider's signature is the authentication).
 *
 * Failures land on `/?sso_error=<code>`; details go to the log only.
 */
export function workeasy360Router(options: Workeasy360RouterOptions): Router {
  const { db, logger, runtime, consoleOrigin, secure } = options;
  const { client, entitlements, settings } = runtime;
  const router = Router();
  // `__Host-`: only this exact host can have set it, so a sibling domain cannot plant a flow (login CSRF).
  const flowCookie = secure ? "__Host-we_w360_flow" : "we_w360_flow";
  const flowCookiePath = secure ? "/" : "/auth/workeasy360";
  // A ceiling on sign-ins started per minute by this server, which bounds the stored flows. The API sits behind
  // the console's proxy, so a per-address limit would count everyone as one address.
  const starts = createAttemptLimiter(MAX_STARTS_PER_MINUTE, 60_000);

  function fail(res: Response, code: SsoErrorCode, detail: string, reason?: string): void {
    requestLog(res, logger).warn({ code, detail }, "workeasy360 sign-in failed");
    const target = new URL("/", consoleOrigin);
    target.searchParams.set("sso_error", code);
    if (reason && DENIAL_REASONS.has(reason)) target.searchParams.set("reason", reason);
    res.redirect(303, target.toString());
  }

  function parseReturnTo(raw: unknown): string | undefined {
    return typeof raw === "string" && ORGANIZATION_PATH.test(raw) ? raw : undefined;
  }

  router.get("/start", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (starts.blocked("all")) return fail(res, "rate_limited", "too many sign-ins started this minute");
    starts.fail("all");
    const raw = typeof req.query.organization === "string" ? req.query.organization : "";
    // Only a UUID is forwarded; anything else is dropped and the provider shows its own chooser.
    const organizationId = UUID_PATTERN.test(raw) ? raw.toLowerCase() : undefined;
    const returnTo = parseReturnTo(req.query.returnTo);
    try {
      const request = await client.beginLogin({ organizationId });
      const flowId = randomBytes(32).toString("base64url");
      await workeasy360Repo.saveLoginFlow(
        db,
        flowId,
        { state: request.state, nonce: request.nonce, codeVerifier: request.codeVerifier, organizationId: organizationId ?? null, returnTo: returnTo ?? null },
        FLOW_TTL_SECONDS,
      );
      res.append("Set-Cookie", serializeCookie(flowCookie, flowId, { path: flowCookiePath, secure, maxAgeSeconds: FLOW_TTL_SECONDS }));
      res.redirect(302, request.url.toString());
    } catch (err) {
      fail(res, codeForError(err), describe(err));
    }
  });

  router.get("/callback", async (req, res) => {
    res.set("Cache-Control", "no-store");
    // The flow is single use: taken (and its cookie dropped) before anything is checked.
    res.append("Set-Cookie", clearCookie(flowCookie, { path: flowCookiePath, secure }));
    const cookies = parseCookies(req.get("cookie"));
    const flowId = cookies.get(flowCookie);
    let flow;
    try {
      flow = flowId && /^[A-Za-z0-9_-]{43}$/.test(flowId) ? await workeasy360Repo.takeLoginFlow(db, flowId) : undefined;
    } catch (err) {
      return fail(res, "unavailable", describe(err));
    }
    const query = new URLSearchParams();
    for (const name of ["code", "state", "error", "iss"]) {
      const value = req.query[name];
      if (typeof value === "string") query.set(name, value.slice(0, MAX_CODE_LENGTH + 1));
    }
    if (!flow) {
      const providerError = query.get("error");
      if (providerError) return fail(res, PROVIDER_ERRORS[providerError] ?? "refused", `provider returned ${providerError.slice(0, 64)} without a pending flow`);
      return fail(res, "expired", "no pending sign-in for this browser");
    }
    if (!query.get("error") && (query.get("code") ?? "").length > MAX_CODE_LENGTH) return fail(res, "refused", "no usable code");

    try {
      const identity = await client.completeLogin(query, flow);
      if (flow.organizationId && identity.organizationId !== flow.organizationId) {
        // The launcher asked for one organization and the token is for another: land nowhere.
        throw new SignInRefused("wrong_organization", "organization_id differs from the launcher's");
      }

      // Entitlement when the person arrives (integration guide §7): a denial has a page of its own.
      const access = await entitlements.check(identity.organizationId, { subject: identity.subject, fresh: true });
      if (access.status === "refused") throw new SignInRefused("access_unverified", "the provider refused this product's client");
      if (!access.allowed) throw new SignInRefused("not_entitled", `entitlement denied (${access.reason})`, access.reason);

      const outcome = await workeasy360Repo.provisionSignIn(db, {
        issuer: identity.issuer,
        subject: identity.subject,
        displayName: identity.name ?? identity.email,
        organizationId: identity.organizationId,
        organizationName: identity.organizationName,
        defaultRole: settings.defaultRole,
        provisionTenants: settings.provisionTenants,
        homeRegion: options.homeRegion,
        requestId: requestIdOf(res),
      });
      if (outcome.kind === "refused") throw new SignInRefused(outcome.code, outcome.detail);

      // Account switching and fixation: whatever session this browser holds ends here.
      const presented = cookies.get(options.sessionCookie);
      const previous = presented ? await identityRepo.resolveSession(db, presented) : undefined;
      if (previous) await identityRepo.revokeSession(db, previous);

      const session = await identityRepo.createSession(db, outcome.userId, options.sessionTtlMs, {
        tenantId: outcome.tenantId,
        issuer: identity.issuer,
        subject: identity.subject,
        sid: identity.sid,
        organizationId: identity.organizationId,
        idToken: identity.idToken,
      });
      res.append(
        "Set-Cookie",
        serializeCookie(options.sessionCookie, session.token, { path: "/", secure, maxAgeSeconds: options.sessionTtlMs / 1000 }),
      );
      requestLog(res, logger).info(
        {
          userId: outcome.userId,
          tenantId: outcome.tenantId,
          sessionId: session.sessionId,
          tenantCreated: outcome.tenantCreated,
          membershipCreated: outcome.membershipCreated,
          entitlement: access.status,
          sid: Boolean(identity.sid),
        },
        "user signed in with WorkEasy360",
      );
      const returnTo = flow.returnTo && ORGANIZATION_PATH.exec(flow.returnTo)?.[1]?.toLowerCase() === outcome.tenantId ? flow.returnTo : undefined;
      res.redirect(303, new URL(returnTo ?? `/o/${outcome.tenantId}/forms`, consoleOrigin).toString());
    } catch (err) {
      fail(res, codeForError(err), describe(err), err instanceof SignInRefused ? err.reason : undefined);
    }
  });

  router.post("/backchannel-logout", express.urlencoded({ extended: false, limit: "32kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const log = requestLog(res, logger);
    const body = req.body as Record<string, unknown> | undefined;
    const raw = req.is("application/x-www-form-urlencoded") ? body?.logout_token : undefined;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LOGOUT_TOKEN_LENGTH) {
      log.warn({ detail: "no logout_token form field" }, "workeasy360 logout token rejected");
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    let token;
    try {
      token = await client.verifyLogoutToken(raw);
    } catch (err) {
      if (err instanceof Workeasy360Error && err.code === "invalid_token") {
        log.warn({ detail: err.detail }, "workeasy360 logout token rejected");
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      // The key set could not be read: not the token's fault, so the provider delivers it again.
      log.error({ detail: describe(err) }, "workeasy360 logout token could not be verified");
      res.status(503).json({ error: "temporarily_unavailable" });
      return;
    }
    try {
      const outcome = await workeasy360Repo.endSessions(db, {
        issuer: client.issuer,
        jti: token.jti,
        subject: token.sub,
        sid: token.sid,
        acceptableUntil: token.acceptableUntil,
      });
      log.info(
        { jti: token.jti, by: token.sid ? "sid" : "sub", replayed: outcome.replayed, sessionsEnded: outcome.replayed ? 0 : outcome.sessionsEnded },
        "workeasy360 back-channel logout",
      );
      // A duplicate is a success too: delivery is at least once.
      res.status(200).end();
    } catch (err) {
      log.error({ detail: describe(err) }, "workeasy360 back-channel logout failed");
      res.status(503).json({ error: "temporarily_unavailable" });
    }
  });

  return router;
}
