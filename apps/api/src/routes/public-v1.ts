import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { identityRepo, intakeRepo, publicFormsRepo, uploadsRepo, withTenant, type PublicForm, type RespondentSession, type Unavailable, type Upload } from "@workeasy/database";
import { safeFileName } from "@workeasy/files";
import type { Field, FormDefinition } from "@workeasy/form-schema";
import type { AppDependencies } from "../app.js";
import {
  IDEMPOTENCY_KEY_PATTERN,
  MAX_ANSWERS_BYTES,
  SubmitBodySchema,
  UploadCreateBodySchema,
  type UploadCreateResponse,
  type UploadStatusResponse,
  type PublicAcceptanceResponse,
  type PublicFormResponse,
  type ReceiptBody,
  type SessionStartResponse,
} from "../contract/schemas.js";
import { intake } from "../intake.js";
import { parseCookies } from "../http/cookies.js";
import { problems, sendProblem } from "../http/problem.js";
import { requestIdOf, requestLog } from "../http/request-context.js";
import { requireSameOrigin } from "../http/same-origin.js";
import { respondentAuthRouter, respondentSessionCookieName } from "./auth.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const { publicDb, settings, logger, objectStore } = deps;
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
    if (form.gate.accessMode === "public") return { kind: "allowed", actorId: null };
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

  /**
   * Why a form takes no responses, in respondent terms. Only "closed" may be
   * cached (for anyone-with-the-link forms); schedules and counts change.
   */
  function unavailable(res: Response, reason: Unavailable, opensAt: Date | undefined, cacheClosed: boolean) {
    if (reason === "not_found") return notFound(res);
    if (reason === "closed") return closed(res, cacheClosed ? PUBLIC_FORM_MAX_AGE_SECONDS : 0);
    res.set("Cache-Control", "no-store");
    if (reason === "not_open_yet") {
      sendProblem(res, 409, "FORM_NOT_OPEN", "This form isn't open for responses yet", opensAt ? { opensAt: opensAt.toISOString() } : {});
    } else if (reason === "full") {
      sendProblem(res, 410, "FORM_FULL", "This form has reached its response limit");
    } else {
      // The tenant's monthly quota resets at the start of the next month (UTC).
      const now = new Date();
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      res.set("Retry-After", String(Math.max(1, Math.ceil((next - now.getTime()) / 1000))));
      sendProblem(res, 429, "RESPONSE_QUOTA_REACHED", "This form can't take more responses right now");
    }
  }

  /** Resolves a slug to a published, existing form; answers 404 itself when there is none. */
  async function load(res: Response, slug: string): Promise<{ tenantId: string; formId: string; form: PublicForm } | undefined> {
    const located = await publicFormsRepo.resolveSlug(publicDb, slug);
    const form = located ? await withTenant(publicDb, located.tenantId, (trx) => publicFormsRepo.getPublicForm(trx, located.formId)) : undefined;
    if (!located || !form || form.gate.state === "draft" || form.gate.state === "archived") {
      notFound(res);
      return undefined;
    }
    return { ...located, form };
  }

  function formBody(form: PublicForm): PublicFormResponse {
    return {
      slug: form.slug,
      accessMode: form.gate.accessMode,
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
    const available = await withTenant(publicDb, loaded.tenantId, (trx) => publicFormsRepo.availability(trx, form.gate));
    if (!available.available) {
      unavailable(res, available.reason, available.opensAt, form.gate.accessMode === "public");
      return;
    }
    // Organization-only forms are personal to the signed-in member, and limited or
    // scheduled forms change state without a publish: neither may be cached (docs/05 §3).
    const cacheable = form.gate.accessMode === "public" && !form.gate.openAt && !form.gate.closeAt;
    res.set("Cache-Control", cacheable ? `public, max-age=${PUBLIC_FORM_MAX_AGE_SECONDS}` : "private, no-store");
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
    const started = await withTenant(publicDb, tenantId, async (trx) => {
      const available = await publicFormsRepo.availability(trx, form.gate);
      if (!available.available) return available;
      return publicFormsRepo.startSession(trx, { tenantId, formId, formVersionId: form.version.id, actorId: access.actorId });
    });
    if ("available" in started) {
      unavailable(res, started.reason, started.opensAt, false);
      return;
    }
    const session = started;
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
  /** The session behind the bearer capability, if it is exactly the session in the path; answers 401 itself otherwise. */
  async function sessionOf(req: Request, res: Response) {
    const auth = req.get("authorization") ?? "";
    const capability = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    const session = capability ? await publicFormsRepo.resolveCapability(publicDb, capability) : undefined;
    // The capability must belong to exactly this session; anything else looks like a missing session.
    if (!session || session.id !== req.params.sessionId) {
      sessionInvalid(res);
      return undefined;
    }
    return session;
  }

  function sessionInvalid(res: Response) {
    sendProblem(res, 401, "SESSION_INVALID", "This form session has expired. Reload the page to start again.");
  }

  router.get("/sessions/:sessionId/acceptance", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = await sessionOf(req, res);
    if (!session) return;
    const acceptance = await withTenant(publicDb, session.tenantId, (trx) => publicFormsRepo.checkSessionAcceptance(trx, session));
    if (acceptance.accepting) res.json({ accepting: true, versionId: session.formVersionId } satisfies PublicAcceptanceResponse);
    else if (acceptance.reason === "access_revoked") sendProblem(res, 403, "NOT_A_MEMBER", "You no longer have access to this form");
    else unavailable(res, acceptance.reason, acceptance.opensAt, false);
  });

  /**
   * Submits the session's answers (docs/04 §5). Retrying with the same
   * Idempotency-Key returns the recorded receipt; the session accepts one
   * response at most. Answers are never logged or echoed back.
   */
  router.post("/sessions/:sessionId/submissions", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = await sessionOf(req, res);
    if (!session) return;
    const idempotencyKey = req.get("idempotency-key");
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      sendProblem(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header of 8 to 200 visible characters");
      return;
    }
    const body = SubmitBodySchema.safeParse(req.body);
    if (!body.success) {
      problems.validation(
        res,
        body.error.issues.map((i) => ({ field: i.path.map(String).join(".") || "body", code: i.code.toUpperCase(), message: i.message })),
      );
      return;
    }
    if (Buffer.byteLength(JSON.stringify(body.data.answers), "utf8") > MAX_ANSWERS_BYTES) {
      sendProblem(res, 413, "ANSWERS_TOO_LARGE", "The answers are larger than this form accepts");
      return;
    }
    const outcome = await intake(publicDb, {
      session,
      idempotencyKey,
      formVersionId: body.data.formVersionId,
      answers: body.data.answers,
      requestId: requestIdOf(res),
    });
    const log = requestLog(res, logger);
    switch (outcome.kind) {
      case "accepted":
        log.info({ respondentSessionId: session.id, submissionId: outcome.receipt.submissionId }, "submission accepted");
        res.status(201).json(outcome.receipt satisfies ReceiptBody);
        return;
      case "replayed":
        res.set("Idempotent-Replayed", "true").status(outcome.status).json(outcome.receipt satisfies ReceiptBody);
        return;
      case "already_submitted":
        res.set("Submission-Already-Accepted", "true").status(200).json(outcome.receipt satisfies ReceiptBody);
        return;
      case "idempotency_conflict":
        sendProblem(res, 409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used with different answers");
        return;
      case "version_mismatch":
        sendProblem(res, 409, "VERSION_MISMATCH", "These answers are for a different version than this session's");
        return;
      case "session_invalid":
        sessionInvalid(res);
        return;
      case "unavailable":
        unavailable(res, outcome.reason, outcome.opensAt, false);
        return;
      case "access_revoked":
        sendProblem(res, 403, "NOT_A_MEMBER", "You no longer have access to this form");
        return;
      case "invalid":
        problems.validation(res, outcome.errors);
        return;
    }
  });

  // Uploads (FIL-01, docs/05 §3 and docs/06 §3) ------------------------------

  /** How long a presigned upload URL stays valid. */
  const UPLOAD_URL_SECONDS = 5 * 60;
  /** Replacements allowed beyond a field's maxFiles, so a respondent can swap a file without abuse. */
  const SPARE_UPLOADS = 5;

  function uploadBody(upload: Upload): UploadStatusResponse {
    return {
      uploadId: upload.id,
      fieldId: upload.fieldId,
      fileName: upload.fileName,
      bytes: upload.bytes,
      state: upload.state,
      rejectionReason: (upload.rejectionReason as UploadStatusResponse["rejectionReason"]) ?? null,
    };
  }

  async function fileField(session: RespondentSession, fieldId: string): Promise<Field | undefined> {
    const projection = await withTenant(publicDb, session.tenantId, (trx) => intakeRepo.versionProjection(trx, session.formId, session.formVersionId));
    const field = (projection as unknown as FormDefinition | undefined)?.fields.find((f) => f.id === fieldId);
    return field?.type === "file" ? field : undefined;
  }

  /**
   * Prepares an upload: checks the session may still respond and the file
   * suits the field, records it, and returns a presigned PUT to the
   * quarantine bucket that accepts exactly this type and size briefly.
   */
  router.post("/sessions/:sessionId/uploads", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = await sessionOf(req, res);
    if (!session) return;
    const body = UploadCreateBodySchema.safeParse(req.body);
    if (!body.success) {
      problems.validation(
        res,
        body.error.issues.map((i) => ({ field: i.path.map(String).join(".") || "body", code: i.code.toUpperCase(), message: i.message })),
      );
      return;
    }
    const { fieldId, contentType, bytes } = body.data;
    const acceptance = await withTenant(publicDb, session.tenantId, (trx) => publicFormsRepo.checkSessionAcceptance(trx, session));
    if (!acceptance.accepting) {
      if (acceptance.reason === "access_revoked") sendProblem(res, 403, "NOT_A_MEMBER", "You no longer have access to this form");
      else unavailable(res, acceptance.reason, acceptance.opensAt, false);
      return;
    }
    const field = await fileField(session, fieldId);
    if (!field) {
      problems.validation(res, [{ field: "fieldId", code: "NOT_A_FILE_FIELD", message: "This question doesn't take files" }]);
      return;
    }
    const allowed = field.settings.allowedMimeTypes ?? [];
    if (!allowed.includes(contentType)) {
      problems.validation(res, [{ field: "contentType", code: "TYPE_NOT_ALLOWED", message: "This type of file isn't accepted for this question" }]);
      return;
    }
    if (bytes > (field.settings.maxFileBytes ?? 0)) {
      problems.validation(res, [{ field: "bytes", code: "FILE_TOO_LARGE", message: "This file is larger than this question accepts" }]);
      return;
    }
    const uploadId = randomUUID();
    const storageKey = randomUUID();
    const created = await withTenant(publicDb, session.tenantId, async (trx) => {
      if ((await uploadsRepo.countActiveUploads(trx, session.id, fieldId)) >= (field.settings.maxFiles ?? 1) + SPARE_UPLOADS) return false;
      await uploadsRepo.createUpload(trx, {
        id: uploadId,
        tenantId: session.tenantId,
        formId: session.formId,
        formVersionId: session.formVersionId,
        sessionId: session.id,
        fieldId,
        fileName: safeFileName(body.data.fileName),
        declaredType: contentType,
        declaredBytes: bytes,
        storageKey,
      });
      return true;
    });
    if (!created) {
      sendProblem(res, 429, "TOO_MANY_UPLOADS", "Too many files were uploaded for this question. Remove some and try again.");
      return;
    }
    const uploadUrl = await objectStore.presignUpload(storageKey, contentType, bytes, UPLOAD_URL_SECONDS);
    const response: UploadCreateResponse = {
      uploadId,
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": contentType },
      expiresAt: new Date(Date.now() + UPLOAD_URL_SECONDS * 1000).toISOString(),
    };
    res.status(201).json(response);
  });

  /** The browser finished its PUT: check what was stored, then queue the scan. */
  router.post("/sessions/:sessionId/uploads/:uploadId/complete", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = await sessionOf(req, res);
    if (!session) return;
    const uploadId = String(req.params.uploadId);
    const upload = UUID_PATTERN.test(uploadId) ? await withTenant(publicDb, session.tenantId, (trx) => uploadsRepo.getSessionUpload(trx, session.id, uploadId)) : undefined;
    if (!upload) {
      notFound(res);
      return;
    }
    if (upload.state !== "awaiting_upload") {
      res.json(uploadBody(upload));
      return;
    }
    const stored = await objectStore.head(objectStore.quarantineBucket, upload.storageKey);
    if (!stored) {
      sendProblem(res, 409, "UPLOAD_NOT_RECEIVED", "The file hasn't arrived yet. Upload it, then try again.");
      return;
    }
    if (stored.bytes !== upload.declaredBytes) {
      await withTenant(publicDb, session.tenantId, (trx) => uploadsRepo.rejectUpload(trx, session.id, upload.id, "size_mismatch"));
      await objectStore.remove(objectStore.quarantineBucket, upload.storageKey);
      problems.validation(res, [{ field: "bytes", code: "SIZE_MISMATCH", message: "The file that arrived isn't the one that was announced. Upload it again." }]);
      return;
    }
    const updated = await withTenant(publicDb, session.tenantId, async (trx) => {
      await uploadsRepo.markReceived(trx, session.id, upload.id, stored.bytes);
      return uploadsRepo.getSessionUpload(trx, session.id, upload.id);
    });
    res.status(202).json(uploadBody(updated!));
  });

  /** Where an upload is in quarantine and scanning; nothing else about it. */
  router.get("/sessions/:sessionId/uploads/:uploadId", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = await sessionOf(req, res);
    if (!session) return;
    const uploadId = String(req.params.uploadId);
    const upload = UUID_PATTERN.test(uploadId) ? await withTenant(publicDb, session.tenantId, (trx) => uploadsRepo.getSessionUpload(trx, session.id, uploadId)) : undefined;
    if (!upload) {
      notFound(res);
      return;
    }
    res.json(uploadBody(upload));
  });

  return router;
}
