import type { RequestHandler, Response } from "express";
import { workeasy360Repo, type Db, type ResolvedSession } from "@workeasy/database";
import { problems, sendProblem } from "../http/problem.js";
import type { Workeasy360Runtime } from "./runtime.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Reads that use POST: a read-only organization can still validate a draft and export its responses. */
const READ_LIKE_POSTS = [/\/validate$/, /\/exports$/];

/**
 * The SSO-only rule, checked on every request with a session: when
 * WORKEASY360_SSO_ONLY is on, a session opened any other way (a password, the
 * generic provider) is refused, at once, even if it has not expired.
 */
export function refuseUnlessWorkeasy360(runtime: Workeasy360Runtime | undefined, session: ResolvedSession, res: Response): boolean {
  if (!runtime?.settings.ssoOnly || session.provider === "workeasy360") return false;
  sendProblem(res, 401, "WORKEASY360_SIGN_IN_REQUIRED", "Sign in with WorkEasy360 to continue");
  return true;
}

/**
 * In front of every `/organizations/:orgId/...` route (docs/workeasy360-sso.md):
 *
 * 1. A WorkEasy360 session reaches only the tenant its ID token's organization
 *    maps to; any other organization is "not found", as for a non-member.
 * 2. A tenant linked to a WorkEasy360 organization is used only while the
 *    platform says the organization (and, for a WorkEasy360 session, the
 *    person) is entitled - asked on the platform's cadence, not per request.
 *    A denial answers 403 WORKEASY360_ACCESS_ENDED with the reason; a refusal
 *    of this product's client 403 WORKEASY360_ACCESS_UNVERIFIED; a write while
 *    the organization is read-only 403 WORKEASY360_READ_ONLY. The session itself
 *    stays valid, so the person sees why and can sign out.
 *
 * Role and per-form permissions are then checked by the route, as before:
 * authorization is organization + role, never `sub` alone.
 */
export function organizationGate(db: Db, runtime: Workeasy360Runtime | undefined): RequestHandler {
  return async (req, res, next) => {
    const session = res.locals.session as ResolvedSession;
    const orgId = String(req.params.orgId ?? "").toLowerCase();
    if (session.provider === "workeasy360" && orgId !== session.tenantId) {
      problems.notFound(res);
      return;
    }
    if (!runtime) return next();

    let organizationId: string | undefined;
    let subject: string | undefined;
    if (session.provider === "workeasy360") {
      organizationId = session.workeasy360OrganizationId;
      subject = session.workeasy360Subject;
    } else {
      // Answered only for an active member, so a non-member still gets the route's 404.
      organizationId = await workeasy360Repo.memberTenantOrganization(db, orgId, session.userId);
    }
    if (!organizationId) return next();

    const access = await runtime.entitlements.check(organizationId, { subject });
    if (access.status === "refused") {
      sendProblem(res, 403, "WORKEASY360_ACCESS_UNVERIFIED", "Workeasy Forms cannot confirm your access with WorkEasy360 right now. Try again in a few minutes");
      return;
    }
    if (!access.allowed) {
      sendProblem(res, 403, "WORKEASY360_ACCESS_ENDED", "Your organization's access to Workeasy Forms has ended", { reason: access.reason });
      return;
    }
    const write = !SAFE_METHODS.has(req.method) && !READ_LIKE_POSTS.some((p) => req.method === "POST" && p.test(req.path));
    if (write && !access.writeAllowed) {
      sendProblem(res, 403, "WORKEASY360_READ_ONLY", "Your organization can view and export, but not make changes, until its subscription is renewed");
      return;
    }
    next();
  };
}
