import { Router, type Response } from "express";
import { publicFormsRepo, withTenant } from "@workeasy/database";
import type { AppDependencies } from "../app.js";
import type { PublicAcceptanceResponse, PublicFormResponse } from "../contract/schemas.js";
import { problems, sendProblem } from "../http/problem.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a published form may be cached; closing still takes effect at once at acceptance (docs/02 §5). */
export const PUBLIC_FORM_MAX_AGE_SECONDS = 30;

/**
 * Respondent routes (docs/05 §2). No cookies and no console session: every
 * query runs as the public database role, which can read only a published
 * form's state and its active version's public projection. Unknown, draft,
 * archived and deleted forms are all "not found", so a slug reveals nothing.
 */
export function publicV1Router({ publicDb }: AppDependencies): Router {
  const router = Router();

  function closed(res: Response, maxAge: number) {
    res.set("Cache-Control", maxAge > 0 ? `public, max-age=${maxAge}` : "no-store");
    sendProblem(res, 410, "FORM_CLOSED", "This form is closed and isn't accepting responses");
  }

  function notFound(res: Response) {
    res.set("Cache-Control", "no-store");
    problems.notFound(res);
  }

  router.get("/forms/:slug", async (req, res) => {
    const located = await publicFormsRepo.resolveSlug(publicDb, req.params.slug);
    if (!located) {
      notFound(res);
      return;
    }
    const form = await withTenant(publicDb, located.tenantId, (trx) => publicFormsRepo.getPublicForm(trx, located.formId));
    if (!form || form.state === "draft" || form.state === "archived") {
      notFound(res);
      return;
    }
    if (form.state === "closed") {
      closed(res, PUBLIC_FORM_MAX_AGE_SECONDS);
      return;
    }
    const body: PublicFormResponse = {
      slug: form.slug,
      versionId: form.version.id,
      versionNumber: form.version.versionNumber,
      definition: form.version.projection,
    };
    res.set("Cache-Control", `public, max-age=${PUBLIC_FORM_MAX_AGE_SECONDS}`);
    res.json(body);
  });

  /**
   * Whether the form accepts a response for the version the page was loaded
   * with, from the authoritative state and never cached. A page that was
   * cached or left open before the form closed learns here that it is closed.
   */
  router.get("/forms/:slug/acceptance", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const versionId = typeof req.query.versionId === "string" ? req.query.versionId : "";
    if (!UUID_PATTERN.test(versionId)) {
      problems.validation(res, [{ field: "versionId", code: "INVALID_VERSION_ID", message: "versionId must be the version the form was loaded with" }]);
      return;
    }
    const located = await publicFormsRepo.resolveSlug(publicDb, req.params.slug);
    if (!located) {
      notFound(res);
      return;
    }
    const acceptance = await withTenant(publicDb, located.tenantId, (trx) => publicFormsRepo.checkAcceptance(trx, located.formId, versionId));
    if (acceptance.accepting) {
      res.json({ accepting: true } satisfies PublicAcceptanceResponse);
    } else if (acceptance.reason === "closed") {
      closed(res, 0);
    } else if (acceptance.reason === "version_changed") {
      sendProblem(res, 409, "VERSION_CHANGED", "This form was updated after you opened it. Reload it to continue.");
    } else {
      notFound(res);
    }
  });

  return router;
}
