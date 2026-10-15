import { Router, type Request, type Response } from "express";
import { identityRepo, publicFormsRepo, withTenant, type PublicForm } from "@workeasy/database";
import type { AppDependencies } from "../app.js";
import type { PublicAcceptanceResponse, PublicFormResponse, SessionStartResponse } from "../contract/schemas.js";
import { parseCookies } from "../http/cookies.js";
import { problems, sendProblem } from "../http/problem.js";
import { requestLog } from "../http/request-context.js";
import { requireSameOrigin } from "../http/same-origin.js";
import { respondentAuthRouter, respondentSessionCookieName } from "./auth.js";

/** How long a public form may be cached; closing still takes effect at once at acceptance (docs/02 §5). */
export const PUBLIC_FORM_MAX_AGE_SECONDS = 30;

type Access = { kind: "allowed"; actorId: string | null } | { kind: "sign_in" } | { kind: "not_member" };

/**
 * Respondent routes (docs/05 §3). Every query runs as the public database
 * role. Anyone-with-the-link forms need no identity; organization-only forms
 * need a respondent sign-in (a cookie on the respondent origin, separate from
 * the console's) and an active membership, checked on every request.
 * Unknown, draft, archived and deleted forms are all "not found".
 */
export function publicV1Router(deps: AppDependencies): Router {
  const { publicDb, settings, logger } = deps;
  const router = Router();
  const respondentCookie = respondentSessionCookieName(settings.secureCookies);

  router.use("/auth", respondentAuthRouter(deps));

  const signInUrl = (slug: string, embed: boolean) => {
    const url = new URL("/public/v1/auth/login", settings.respondentOrigin);
    url.searchParams.set("returnTo", `/f/${slug}${embed ? "?embed=1" : ""}`);
    return url.toString();
  };

  /** Who is asking, for an organization-only form: anonymous, a non-member, or a member. */
  async function accessFor(req: Request, form: PublicForm, tenantId: string): Promise<Access> {
    if (form.accessMode === "public") return { kind: "allowed", actorId: null };
    const token = parseCookies(req.get("cookie")).get(respondentCookie);
    const session = token ? await identityRepo.resolveSession(publicDb, token) : undefined;
    if (!session) return { kind: "sign_in" };
    return (await publicFormsRepo.isActiveMember(publicDb, tenantId, session.userId)) ? { kind: "allowed", actorId: session.userId } : { kind: "not_member" };
  }

  function denied(res: Response, access: Exclude<Access, { kind: "allowed" }>, slug: string, embed: boolean) {
    res.set("Cache-Control", "no-store");
    if (access.kind === "sign_in") {
      sendProblem(res, 401, "SIGN_IN_REQUIRED", "Sign in with your organization account to fill in this form", { signInUrl: signInUrl(slug, embed) });
    } else {
      sendProblem(res, 403, "NOT_A_MEMBER", "This form is only for members of the organization that published it");
    }
  }

  function closed(res: Response, maxAge: number) {
    res.set("Cache-Control", maxAge > 0 ? `public, max-age=${maxAge}` : "no-store");
    sendProblem(res, 410, "FORM_CLOSED", "This form is closed and isn't accepting responses");
  }

  function notFound(res: Response) {
    res.set("Cache-Control", "no-store");
    problems.notFound(res);
  }

  /** Resolves a slug to a published, existing form; answers 404 itself when there is none. */
  async function load(res: Response, slug: string): Promise<{ tenantId: string; formId: string; form: PublicForm } | undefined> {
    const located = await publicFormsRepo.resolveSlug(publicDb, slug);
    const form = located ? await withTenant(publicDb, located.tenantId, (trx) => publicFormsRepo.getPublicForm(trx, located.formId)) : undefined;
    if (!located || !form || form.state === "draft" || form.state === "archived") {
      notFound(res);
      return undefined;
    }
    return { ...located, form };
  }

  function formBody(form: PublicForm): PublicFormResponse {
    return {
      slug: form.slug,
      accessMode: form.accessMode,
      versionId: form.version.id,
      versionNumber: form.version.versionNumber,
      definition: form.version.projection,
    };
  }

  /** Read-only view of the live version, for rendering the page. Respondents answer through a session. */
  router.get("/forms/:slug", async (req, res) => {
    const loaded = await load(res, req.params.slug);
    if (!loaded) return;
    const { form } = loaded;
    const access = await accessFor(req, form, loaded.tenantId);
    if (access.kind !== "allowed") {
      denied(res, access, form.slug, req.query.embed === "1");
      return;
    }
    if (form.state === "closed") {
      closed(res, form.accessMode === "public" ? PUBLIC_FORM_MAX_AGE_SECONDS : 0);
      return;
    }
    // Organization-only forms are personal to the signed-in member: never cache them (docs/05 §3).
    res.set("Cache-Control", form.accessMode === "public" ? `public, max-age=${PUBLIC_FORM_MAX_AGE_SECONDS}` : "private, no-store");
    res.json(formBody(form));
  });

  /**
   * Starts a respondent session on the form's live version. The browser keeps
   * the capability in memory and sends it as a bearer token; the session stays
   * on this version for its lifetime even if a newer one is published.
   */
  router.post("/forms/:slug/sessions", requireSameOrigin(settings.respondentOrigin), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const loaded = await load(res, String(req.params.slug));
    if (!loaded) return;
    const { form, tenantId, formId } = loaded;
    const access = await accessFor(req, form, tenantId);
    if (access.kind !== "allowed") {
      denied(res, access, form.slug, req.query.embed === "1");
      return;
    }
    if (form.state === "closed") {
      closed(res, 0);
      return;
    }
    const session = await withTenant(publicDb, tenantId, (trx) =>
      publicFormsRepo.startSession(trx, { tenantId, formId, formVersionId: form.version.id, actorId: access.actorId }),
    );
    requestLog(res, logger).info({ respondentSessionId: session.id, formId }, "respondent session started");
    const body: SessionStartResponse = {
      ...formBody(form),
      sessionId: session.id,
      capability: session.capability,
      expiresAt: session.expiresAt.toISOString(),
    };
    res.status(201).json(body);
  });

  /**
   * Whether this session may submit right now, from the authoritative state
   * and never cached: a page that loaded before the form was closed, or before
   * the respondent lost access, learns it here.
   */
  router.get("/sessions/:sessionId/acceptance", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const auth = req.get("authorization") ?? "";
    const capability = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    const session = capability ? await publicFormsRepo.resolveCapability(publicDb, capability) : undefined;
    // The capability must belong to exactly this session; anything else looks like a missing session.
    if (!session || session.id !== req.params.sessionId) {
      sendProblem(res, 401, "SESSION_INVALID", "This form session has expired. Reload the page to start again.");
      return;
    }
    const acceptance = await withTenant(publicDb, session.tenantId, (trx) => publicFormsRepo.checkSessionAcceptance(trx, session));
    if (acceptance.accepting) res.json({ accepting: true, versionId: session.formVersionId } satisfies PublicAcceptanceResponse);
    else if (acceptance.reason === "closed") closed(res, 0);
    else if (acceptance.reason === "access_revoked") sendProblem(res, 403, "NOT_A_MEMBER", "You no longer have access to this form");
    else notFound(res);
  });

  return router;
}
