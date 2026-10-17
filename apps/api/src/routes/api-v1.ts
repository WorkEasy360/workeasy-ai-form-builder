import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import type { Transaction } from "kysely";
import {
  FORM_PERMISSIONS,
  formPermissions,
  isFormPermission,
  orgPermissions,
  readsAllForms,
  type FormPermission,
} from "@workeasy/auth";
import {
  identityRepo,
  orgRepo,
  membersRepo,
  exportsRepo,
  aiRepo,
  analyticsRepo,
  governanceRepo,
  integrationsRepo,
  jobsRepo,
  publishRepo,
  responsesRepo,
  uploadsRepo,
  withContext,
  type Database,
  type AccessPolicy,
  type AiGeneration,
  type Delivery,
  type Integration,
  type Invitation,
  type Member,
  type ExportRecord,
  type Job,
  type FormListCursor,
  type ReadableClass,
  type FormSummary,
  type MembershipRecord,
  type ResolvedSession,
  type VersionSummary,
} from "@workeasy/database";
import { AI_DEADLINE_SECONDS, AI_GENERATE_JOB, AI_GENERATE_MAX_ATTEMPTS, reservationTokens, TEMPLATE_VERSION } from "@workeasy/ai";
import { FORM_PUBLISHED_V1, formPublishedV1 } from "@workeasy/events";
import { checkWebhookUrl, DELIVER_JOB, encryptSecret, newWebhookSecret } from "@workeasy/integrations";
import {
  blankDefinition,
  canonicalJson,
  definitionFromTemplate,
  FORM_TEMPLATES,
  publicProjection,
  validateDefinition,
  validateDraft,
} from "@workeasy/form-engine";
import type { DefinitionIssue, FormDefinition } from "@workeasy/form-schema";
import { isLayoutType, privacyOf } from "@workeasy/form-engine";
import type { z } from "zod";
import type { AppDependencies } from "../app.js";
import {
  AccessPolicyBodySchema,
  ActivateVersionBodySchema,
  AiApplyBodySchema,
  ANALYTICS_DEFINITIONS,
  AnalyticsQuerySchema,
  AiSettingsBodySchema,
  DeliveryQuerySchema,
  IntegrationCreateBodySchema,
  InvitationAcceptBodySchema,
  InvitationCreateBodySchema,
  MemberPatchBodySchema,
  IntegrationPatchBodySchema,
  AiJobCreateBodySchema,
  AuditQuerySchema,
  CloseFormBodySchema,
  JobQuerySchema,
  DeletionBodySchema,
  ExportCreateBodySchema,
  RetentionBodySchema,
  ResponseListQuerySchema,
  CreateFormBodySchema,
  IDEMPOTENCY_KEY_PATTERN,
  DuplicateFormBodySchema,
  FormGrantsBodySchema,
  FormListQuerySchema,
  type FormGrantsResponse,
  type FormListResponse,
  type AccessPolicyResponse,
  type AiApplyResponse,
  type AnalyticsResponse,
  type AiSettingsResponse,
  type DeliveryBody,
  type DeliveryDetailResponse,
  type DeliveryListResponse,
  type IntegrationBody,
  type InvitationAcceptResponse,
  type InvitationBody,
  type InvitationCreatedResponse,
  type InvitationListResponse,
  type InvitationResponse,
  type MemberListResponse,
  type MemberResponse,
  type IntegrationListResponse,
  type IntegrationResponse,
  type AiGenerationBody,
  type AiJobResponse,
  type AuditListResponse,
  type JobBody,
  type JobListResponse,
  type JobResponse,
  type RetentionResponse,
  type DraftResponse,
  type ExportBody,
  type ExportDownloadResponse,
  type FileDownloadResponse,
  type ResponseDetailResponse,
  type ResponseListResponse,
  type FormResponse,
  type FormSummaryBody,
  type MeResponse,
  type PublishResponse,
  type SaveDraftResponse,
  type ShareResponse,
  type ValidateResponse,
  type VersionListResponse,
  type VersionResponse,
  type VersionSummaryBody,
} from "../contract/schemas.js";
import { parseCookies } from "../http/cookies.js";
import { problems, sendProblem, type FieldError, type ProblemExtensions } from "../http/problem.js";
import { requestIdOf } from "../http/request-context.js";
import { canRead, indexVersions, presentAnswer, readableClasses, shortReceipt } from "@workeasy/responses";
import { requireSameOrigin } from "../http/same-origin.js";
import { sessionCookieName } from "./auth.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Grants given to whoever creates or duplicates a form. Creators hold no
 * implicit form permissions, and creating a form does not imply response
 * access or delete rights (docs/01 §4).
 */
const CREATOR_GRANTS: readonly FormPermission[] = ["forms.edit", "forms.publish", "forms.manage_access"];
const SLUG_ATTEMPTS = 3;
const MAX_VERSIONS_LISTED = 100;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest();

function versionBody(version: VersionSummary, activeVersionId: string | null): VersionSummaryBody {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    schemaVersion: version.schemaVersion,
    draftRevision: version.draftRevision,
    contentHash: version.contentHash.toString("hex"),
    publishedAt: version.publishedAt.toISOString(),
    publishedBy: version.publishedBy,
    active: version.id === activeVersionId,
  };
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

/**
 * The snippet a host page pastes in: an iframe plus a script that resizes it
 * when the form reports its height. The script accepts messages only from
 * the respondent origin and only from this iframe, and the messages carry
 * nothing but a height (docs/06 §3).
 */
function embedSnippet(embedUrl: string, respondentOrigin: string, slug: string, title: string): string {
  const id = `workeasy-form-${slug}`;
  return [
    `<iframe id="${id}" src="${escapeHtml(embedUrl)}" title="${escapeHtml(title)}" loading="lazy" style="width:100%;height:480px;border:0"></iframe>`,
    "<script>",
    "(function () {",
    `  var frame = document.getElementById(${JSON.stringify(id)});`,
    "  window.addEventListener(\"message\", function (event) {",
    `    if (event.origin !== ${JSON.stringify(respondentOrigin)} || !frame || event.source !== frame.contentWindow) return;`,
    "    var data = event.data;",
    "    if (data && data.type === \"workeasy:form-height\" && typeof data.height === \"number\" && data.height > 0 && data.height < 100000) {",
    "      frame.style.height = Math.ceil(data.height) + \"px\";",
    "    }",
    "  });",
    "})();",
    "</script>",
  ].join("\n");
}

function policyBody(policy: AccessPolicy, acceptedResponses: number): AccessPolicyResponse {
  return {
    mode: policy.mode,
    maxResponses: policy.maxResponses,
    openAt: policy.openAt?.toISOString() ?? null,
    closeAt: policy.closeAt?.toISOString() ?? null,
    spamProtection: policy.spamProtection,
    acceptedResponses,
  };
}

function issuesAsErrors(issues: readonly DefinitionIssue[]): FieldError[] {
  return issues.map((i) => ({ field: i.path || "/", code: i.code, message: i.message }));
}

function sessionOf(res: Response): ResolvedSession {
  return res.locals.session as ResolvedSession;
}

function issuesToErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map(String).join(".") : "body",
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
}

function encodeCursor(cursor: FormListCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id]), "utf8").toString("base64url");
}

function decodeCursor(value: string): FormListCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [updatedAt, id] = parsed as unknown[];
    if (typeof updatedAt !== "string" || updatedAt.length > 64 || Number.isNaN(Date.parse(updatedAt))) return undefined;
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) return undefined;
    return { updatedAt, id };
  } catch {
    return undefined;
  }
}

function summaryBody(form: FormSummary, permissions: Set<FormPermission>): FormSummaryBody {
  return {
    id: form.id,
    slug: form.slug,
    name: form.name,
    state: form.state,
    ownerId: form.ownerId,
    activeVersionId: form.activeVersionId,
    createdAt: form.createdAt.toISOString(),
    updatedAt: form.updatedAt.toISOString(),
    // Stable order, so clients and tests can compare lists.
    permissions: FORM_PERMISSIONS.filter((p) => permissions.has(p)),
  };
}

function draftEtag(revision: number): string {
  return `"draft-${revision}"`;
}

/** Parses `"draft-N"`; undefined for anything else (weak or list ETags are not accepted). */
function parseDraftEtag(header: string): number | undefined {
  const match = /^"draft-([1-9]\d{0,9})"$/.exec(header.trim());
  return match ? Number(match[1]) : undefined;
}

/** Retries `fn` when a freshly generated slug collides with an existing one. */
async function withSlugRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!orgRepo.isSlugCollision(err) || attempt >= SLUG_ATTEMPTS) throw err;
    }
  }
}

type Trx = Transaction<Database>;
const NOT_VISIBLE = Symbol("not-visible");

type Outcome<T> =
  | { kind: "ok"; body: T; status?: number; headers?: Record<string, string> }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "invalid"; errors: FieldError[] }
  | { kind: "conflict"; code: string; title: string }
  | { kind: "problem"; status: number; code: string; title: string; extra?: ProblemExtensions };

function respond<T>(res: Response, outcome: Outcome<T> | typeof NOT_VISIBLE): void {
  if (outcome === NOT_VISIBLE || outcome.kind === "not_found") problems.notFound(res);
  else if (outcome.kind === "forbidden") problems.forbidden(res);
  else if (outcome.kind === "invalid") problems.validation(res, outcome.errors);
  else if (outcome.kind === "conflict") sendProblem(res, 409, outcome.code, outcome.title);
  else if (outcome.kind === "problem") sendProblem(res, outcome.status, outcome.code, outcome.title, outcome.extra);
  else {
    if (outcome.headers) res.set(outcome.headers);
    res.status(outcome.status ?? 200).json(outcome.body);
  }
}

interface FormContext {
  form: FormSummary;
  permissions: Set<FormPermission>;
  membership: MembershipRecord;
}

export function apiV1Router({ db, settings, objectStore }: AppDependencies): Router {
  const router = Router();
  const sessionCookie = sessionCookieName(settings.secureCookies);

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.use(async (req, res, next) => {
    const token = parseCookies(req.get("cookie")).get(sessionCookie);
    const session = token ? await identityRepo.resolveSession(db, token) : undefined;
    if (!session) {
      problems.unauthenticated(res);
      return;
    }
    res.locals.session = session;
    next();
  });

  router.use(requireSameOrigin(settings.consoleOrigin));

  /**
   * Runs `fn` in a transaction scoped to the route organization and the
   * signed-in user. The tenant comes from the route but is only used after an
   * active membership is confirmed; otherwise the organization is reported as
   * not found so its existence is never revealed.
   */
  function inOrganization<T>(
    orgId: string,
    userId: string,
    fn: (trx: Trx, membership: MembershipRecord) => Promise<T>,
  ): Promise<T | typeof NOT_VISIBLE> {
    if (!UUID_PATTERN.test(orgId)) return Promise.resolve(NOT_VISIBLE);
    return withContext(db, { tenantId: orgId, userId }, async (trx) => {
      const membership = await orgRepo.getMembership(trx, userId);
      if (!membership || membership.status !== "active") return NOT_VISIBLE;
      return fn(trx, membership);
    });
  }

  /**
   * Loads a form for the caller. Forms the caller cannot read are reported
   * as not found; readable forms without `required` are forbidden.
   */
  function onForm<T>(
    res: Response,
    orgId: string,
    formId: string,
    required: FormPermission,
    action: (trx: Trx, context: FormContext) => Promise<Outcome<T>>,
  ): Promise<Outcome<T> | typeof NOT_VISIBLE> {
    if (!UUID_PATTERN.test(formId)) return Promise.resolve(NOT_VISIBLE);
    const userId = sessionOf(res).userId;
    return inOrganization(orgId, userId, async (trx, membership): Promise<Outcome<T>> => {
      const form = await orgRepo.getFormSummary(trx, formId);
      if (!form) return { kind: "not_found" };
      const grants = (await orgRepo.listUserFormGrants(trx, formId, userId)).filter(isFormPermission);
      const permissions = formPermissions(membership, grants);
      if (!permissions.has("forms.read")) return { kind: "not_found" };
      if (!permissions.has(required)) return { kind: "forbidden" };
      return action(trx, { form, permissions, membership });
    });
  }

  async function formResponse(trx: Trx, form: FormSummary, permissions: Set<FormPermission>): Promise<FormResponse> {
    const draft = await orgRepo.getDraft(trx, form.id);
    if (!draft) throw new Error(`Form ${form.id} has no draft`);
    return { form: summaryBody(form, permissions), draft: { revision: draft.revision } };
  }

  function created(orgId: string, body: FormResponse): Outcome<FormResponse> {
    return {
      kind: "ok",
      status: 201,
      body,
      headers: {
        ETag: draftEtag(body.draft.revision),
        Location: `/api/v1/organizations/${orgId}/forms/${body.form.id}`,
      },
    };
  }

  router.get("/me", async (_req, res) => {
    const profile = await identityRepo.getUserProfile(db, sessionOf(res).userId);
    if (!profile) {
      problems.unauthenticated(res);
      return;
    }
    const body: MeResponse = {
      user: { id: profile.id, displayName: profile.displayName },
      organizations: profile.memberships.map((m) => ({
        id: m.tenantId,
        name: m.tenantName,
        role: m.role,
        permissions: [...orgPermissions(m)],
      })),
    };
    res.json(body);
  });

  router.get("/form-templates", (_req, res) => {
    res.json({
      templates: FORM_TEMPLATES.map(({ id, name, description, definition }) => ({
        id,
        name,
        description,
        pages: definition.pages.length,
        fields: definition.fields.map((f) => ({ label: f.label, type: f.type, required: f.required })),
      })),
    });
  });

  router.get("/organizations/:orgId/forms", async (req, res) => {
    const query = FormListQuerySchema.safeParse(req.query);
    if (!query.success) {
      problems.validation(res, issuesToErrors(query.error));
      return;
    }
    const { limit, cursor: rawCursor, state, q } = query.data;
    const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
    if (rawCursor !== undefined && !cursor) {
      problems.validation(res, [{ field: "cursor", code: "INVALID_CURSOR", message: "Cursor is not valid" }]);
      return;
    }
    const userId = sessionOf(res).userId;
    const result = await inOrganization(req.params.orgId, userId, async (trx, membership) => {
      const page = await orgRepo.listForms(trx, {
        limit,
        ...(readsAllForms(membership) ? {} : { onlyGrantedTo: userId }),
        ...(cursor ? { cursor } : {}),
        ...(state ? { state } : {}),
        ...(q ? { search: q } : {}),
      });
      const grants = await orgRepo.userGrantsForForms(trx, page.items.map((f) => f.id), userId);
      // Response figures only for forms whose responses the caller may read.
      const readable = page.items
        .filter((f) => formPermissions(membership, (grants.get(f.id) ?? []).filter(isFormPermission)).has("responses.read"))
        .map((f) => f.id);
      const stats = await orgRepo.responseStats(trx, readable);
      return { page, membership, grants, stats, readable: new Set(readable) };
    });
    if (result === NOT_VISIBLE) {
      problems.notFound(res);
      return;
    }
    const { page, membership, grants, stats, readable } = result;
    const body: FormListResponse = {
      items: page.items.map((f) => {
        const stat = stats.get(f.id);
        return {
          ...summaryBody(f, formPermissions(membership, (grants.get(f.id) ?? []).filter(isFormPermission))),
          responseCount: readable.has(f.id) ? (stat?.count ?? 0) : null,
          lastResponseAt: readable.has(f.id) ? (stat?.lastAt?.toISOString() ?? null) : null,
        };
      }),
      ...(page.nextCursor ? { nextCursor: encodeCursor(page.nextCursor) } : {}),
    };
    res.json(body);
  });

  router.post("/organizations/:orgId/forms", async (req, res) => {
    const body = CreateFormBodySchema.safeParse(req.body);
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { name, template } = body.data;
    const definition = template ? definitionFromTemplate(template, name)! : blankDefinition(name);
    const { orgId } = req.params;
    const userId = sessionOf(res).userId;
    const outcome = await withSlugRetry(() =>
      inOrganization(orgId, userId, async (trx, membership): Promise<Outcome<FormResponse>> => {
        if (!orgPermissions(membership).has("forms.create")) return { kind: "forbidden" };
        const result = await orgRepo.createForm(trx, {
          tenantId: orgId,
          ownerId: userId,
          name,
          slug: orgRepo.newFormSlug(),
          definition: definition as unknown as Record<string, unknown>,
          ownerGrants: CREATOR_GRANTS,
        });
        await audit(trx, res, orgId, "form.created", "form", result.form.id, { template: template ?? null });
        return created(orgId, {
          form: summaryBody(result.form, formPermissions(membership, CREATOR_GRANTS)),
          draft: { revision: result.draftRevision },
        });
      }),
    );
    respond(res, outcome);
  });

  router.get("/organizations/:orgId/forms/:formId", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.read", async (trx, { form, permissions }) => ({
        kind: "ok",
        body: await formResponse(trx, form, permissions),
      })),
    );
  });

  /**
   * Copies only the source's current draft definition into an independent
   * form. Grants, workflow configuration (which may reference integration
   * credentials), versions and responses are never copied.
   */
  router.post("/organizations/:orgId/forms/:formId/duplicate", async (req, res) => {
    const body = DuplicateFormBodySchema.safeParse(req.body);
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    const outcome = await withSlugRetry(() =>
      onForm(res, orgId, formId, "forms.edit", async (trx, { membership }): Promise<Outcome<FormResponse>> => {
        if (!orgPermissions(membership).has("forms.create")) return { kind: "forbidden" };
        const source = await orgRepo.getDraft(trx, formId);
        if (!source) throw new Error(`Form ${formId} has no draft`);
        const result = await orgRepo.createForm(trx, {
          tenantId: orgId,
          ownerId: userId,
          name: body.data.name,
          slug: orgRepo.newFormSlug(),
          definition: { ...structuredClone(source.definition), title: body.data.name },
          ownerGrants: CREATOR_GRANTS,
        });
        await audit(trx, res, orgId, "form.duplicated", "form", result.form.id, { sourceFormId: formId });
        return created(orgId, {
          form: summaryBody(result.form, formPermissions(membership, CREATOR_GRANTS)),
          draft: { revision: result.draftRevision },
        });
      }),
    );
    respond(res, outcome);
  });

  router.post("/organizations/:orgId/forms/:formId/archive", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.publish", async (trx, { permissions }): Promise<Outcome<FormResponse>> => {
        const form = await orgRepo.transitionFormState(trx, formId, ["draft", "published", "closed"], "archived");
        if (!form) return { kind: "conflict", code: "FORM_STATE_CONFLICT", title: "The form is already archived" };
        await audit(trx, res, orgId, "form.archived", "form", formId, {});
        return { kind: "ok", body: await formResponse(trx, form, permissions) };
      }),
    );
  });

  // A restored form returns to draft if it was never published, otherwise to
  // closed: reopening it to respondents is a separate, deliberate step.
  router.post("/organizations/:orgId/forms/:formId/restore", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.publish", async (trx, { form: current, permissions }): Promise<Outcome<FormResponse>> => {
        const form = await orgRepo.transitionFormState(trx, formId, ["archived"], current.activeVersionId ? "closed" : "draft");
        if (!form) return { kind: "conflict", code: "FORM_STATE_CONFLICT", title: "The form is not archived" };
        await audit(trx, res, orgId, "form.restored", "form", formId, { state: form.state });
        return { kind: "ok", body: await formResponse(trx, form, permissions) };
      }),
    );
  });

  router.get("/organizations/:orgId/forms/:formId/draft", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.edit", async (trx): Promise<Outcome<DraftResponse>> => {
        const draft = await orgRepo.getDraft(trx, formId);
        if (!draft) throw new Error(`Form ${formId} has no draft`);
        const checked = validateDraft(draft.definition);
        return {
          kind: "ok",
          body: {
            revision: draft.revision,
            definition: draft.definition,
            issues: checked.issues,
            updatedAt: draft.updatedAt.toISOString(),
            updatedBy: draft.updatedBy,
          },
          headers: { ETag: draftEtag(draft.revision) },
        };
      }),
    );
  });

  /**
   * Saves the whole draft (the request body is the definition) if the
   * If-Match revision is still current (docs/03 §2). A stale revision is
   * rejected with 412 so changes are never silently overwritten.
   */
  router.put("/organizations/:orgId/forms/:formId/draft", async (req, res) => {
    const ifMatch = req.get("if-match");
    if (!ifMatch) {
      sendProblem(res, 428, "IF_MATCH_REQUIRED", "Send the draft revision you edited in an If-Match header");
      return;
    }
    const expected = parseDraftEtag(ifMatch);
    if (expected === undefined) {
      sendProblem(res, 400, "INVALID_IF_MATCH", 'If-Match must be a draft ETag such as "draft-3"');
      return;
    }
    const checked = validateDraft(req.body);
    if (!checked.ok) {
      problems.validation(res, checked.issues.map((i) => ({ field: i.path || "/", code: i.code, message: i.message })));
      return;
    }
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.edit", async (trx, { form }): Promise<Outcome<SaveDraftResponse>> => {
        if (form.state === "archived") return { kind: "conflict", code: "FORM_ARCHIVED", title: "Restore the form before editing it" };
        const definition = checked.definition as unknown as Record<string, unknown>;
        const revision = await orgRepo.saveDraft(trx, formId, expected, definition, userId);
        if (revision === undefined) {
          const current = await orgRepo.getDraft(trx, formId);
          return {
            kind: "problem",
            status: 412,
            code: "DRAFT_CONFLICT",
            title: "This draft was changed by someone else",
            extra: current ? { currentRevision: current.revision } : {},
          };
        }
        return { kind: "ok", body: { revision, issues: checked.issues }, headers: { ETag: draftEtag(revision) } };
      }),
    );
  });

  // Publishing (PUB-01, docs/02 §5) -----------------------------------------

  /** The same checks publishing runs, for the publish checklist. Nothing is changed. */
  router.post("/organizations/:orgId/forms/:formId/validate", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.edit", async (trx, { form }): Promise<Outcome<ValidateResponse>> => {
        const draft = await orgRepo.getDraft(trx, formId);
        if (!draft) throw new Error(`Form ${formId} has no draft`);
        const checked = validateDefinition(draft.definition);
        const warnings: ValidateResponse["warnings"] = [];
        if (checked.ok && form.activeVersionId) {
          const active = await publishRepo.getVersion(trx, formId, form.activeVersionId);
          if (active && active.contentHash.equals(sha256(canonicalJson(checked.definition)))) {
            warnings.push({ code: "NO_CHANGES", message: `The draft is the same as version ${active.versionNumber}, which is already live.` });
          }
        }
        return {
          kind: "ok",
          body: { revision: draft.revision, publishable: checked.ok, issues: checked.ok ? [] : checked.issues, warnings },
          headers: { ETag: draftEtag(draft.revision) },
        };
      }),
    );
  });

  /**
   * Publishes the draft revision named in If-Match as a new immutable
   * version and makes it active, in one transaction with its audit entry and
   * outbox event. The Idempotency-Key makes retries safe: the same key returns
   * the version it created; reusing it for a different revision is a conflict.
   */
  router.post("/organizations/:orgId/forms/:formId/publish", async (req, res) => {
    const ifMatch = req.get("if-match");
    if (!ifMatch) {
      sendProblem(res, 428, "IF_MATCH_REQUIRED", "Send the draft revision you are publishing in an If-Match header");
      return;
    }
    const expected = parseDraftEtag(ifMatch);
    if (expected === undefined) {
      sendProblem(res, 400, "INVALID_IF_MATCH", 'If-Match must be a draft ETag such as "draft-3"');
      return;
    }
    const idempotencyKey = req.get("idempotency-key");
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      sendProblem(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header of 8 to 200 visible characters");
      return;
    }
    const keyHash = sha256(idempotencyKey);
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    const requestId = requestIdOf(res);
    respond(
      res,
      await onForm(res, orgId, formId, "forms.publish", async (trx, { permissions }): Promise<Outcome<PublishResponse>> => {
        const locked = await publishRepo.lockForm(trx, formId);
        if (!locked) return { kind: "not_found" };

        const replay = await publishRepo.versionByPublishKey(trx, formId, keyHash);
        if (replay) {
          if (replay.draftRevision !== expected) {
            return { kind: "conflict", code: "IDEMPOTENCY_CONFLICT", title: "This Idempotency-Key was already used to publish a different revision" };
          }
          const form = await orgRepo.getFormSummary(trx, formId);
          return {
            kind: "ok",
            body: { form: summaryBody(form!, permissions), version: versionBody(replay, form!.activeVersionId) },
            headers: { "Idempotent-Replayed": "true" },
          };
        }

        if (locked.state === "archived") return { kind: "conflict", code: "FORM_ARCHIVED", title: "Restore the form before publishing it" };
        const draft = await orgRepo.getDraft(trx, formId);
        if (!draft) throw new Error(`Form ${formId} has no draft`);
        if (draft.revision !== expected) {
          return {
            kind: "problem",
            status: 412,
            code: "DRAFT_CONFLICT",
            title: "The draft changed since you checked it",
            extra: { currentRevision: draft.revision },
          };
        }
        const checked = validateDefinition(draft.definition);
        if (!checked.ok) {
          return { kind: "problem", status: 422, code: "NOT_PUBLISHABLE", title: "Fix these problems before publishing", extra: { errors: issuesAsErrors(checked.issues) } };
        }

        const definition: FormDefinition = checked.definition;
        const { version, state } = await publishRepo.insertActiveVersion(trx, {
          tenantId: orgId,
          formId,
          schemaVersion: definition.schemaVersion,
          definition: definition as unknown as Record<string, unknown>,
          publicProjection: publicProjection(definition) as unknown as Record<string, unknown>,
          contentHash: sha256(canonicalJson(definition)),
          draftRevision: draft.revision,
          publishKeyHash: keyHash,
          publishedBy: userId,
          currentState: locked.state,
        });
        await publishRepo.appendAudit(trx, {
          tenantId: orgId,
          actor: { type: "user", id: userId },
          action: "form.published",
          resourceType: "form",
          resourceId: formId,
          requestId,
          metadata: { versionId: version.id, versionNumber: version.versionNumber, draftRevision: draft.revision, previousVersionId: locked.activeVersionId },
        });
        const event = formPublishedV1({
          eventId: randomUUID(),
          occurredAt: version.publishedAt,
          tenantId: orgId,
          traceId: requestId,
          data: { formId, formVersionId: version.id, versionNumber: version.versionNumber },
        });
        await publishRepo.appendOutbox(trx, {
          id: event.eventId,
          tenantId: orgId,
          eventType: FORM_PUBLISHED_V1,
          aggregateId: event.aggregateId,
          occurredAt: version.publishedAt,
          payload: { ...event.data },
          traceId: requestId,
        });
        const form = await orgRepo.getFormSummary(trx, formId);
        if (!form || form.state !== state) throw new Error(`Form ${formId} changed during publish`);
        return {
          kind: "ok",
          status: 201,
          body: { form: summaryBody(form, permissions), version: versionBody(version, version.id) },
          headers: { Location: `/api/v1/organizations/${orgId}/forms/${formId}/versions/${version.id}` },
        };
      }),
    );
  });

  router.get("/organizations/:orgId/forms/:formId/versions", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.read", async (trx, { form }): Promise<Outcome<VersionListResponse>> => ({
        kind: "ok",
        body: { items: (await publishRepo.listVersions(trx, formId, MAX_VERSIONS_LISTED)).map((v) => versionBody(v, form.activeVersionId)) },
      })),
    );
  });

  router.get("/organizations/:orgId/forms/:formId/versions/:versionId", async (req, res) => {
    const { orgId, formId, versionId } = req.params;
    if (!UUID_PATTERN.test(versionId)) {
      problems.notFound(res);
      return;
    }
    respond(
      res,
      await onForm(res, orgId, formId, "forms.read", async (trx, { form }): Promise<Outcome<VersionResponse>> => {
        const version = await publishRepo.getVersion(trx, formId, versionId);
        if (!version) return { kind: "not_found" };
        // Versions never change, but the active flag does, so clients revalidate.
        return { kind: "ok", body: { version: versionBody(version, form.activeVersionId), definition: version.definition } };
      }),
    );
  });

  /** Rollback (or roll forward): makes an existing version of this form the one new respondents get. */
  router.post("/organizations/:orgId/forms/:formId/activate-version", async (req, res) => {
    const body = ActivateVersionBodySchema.safeParse(req.body);
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.publish", async (trx, { permissions }): Promise<Outcome<PublishResponse>> => {
        const locked = await publishRepo.lockForm(trx, formId);
        if (!locked) return { kind: "not_found" };
        if (locked.state === "archived") return { kind: "conflict", code: "FORM_ARCHIVED", title: "Restore the form before changing its live version" };
        const version = await publishRepo.getVersion(trx, formId, body.data.versionId);
        if (!version) {
          return { kind: "invalid", errors: [{ field: "versionId", code: "UNKNOWN_VERSION", message: "This form has no such version" }] };
        }
        if (locked.activeVersionId !== version.id) {
          await publishRepo.setActiveVersion(trx, formId, version.id);
          await publishRepo.appendAudit(trx, {
            tenantId: orgId,
            actor: { type: "user", id: userId },
            action: "form.version_activated",
            resourceType: "form",
            resourceId: formId,
            requestId: requestIdOf(res),
            metadata: { versionId: version.id, versionNumber: version.versionNumber, previousVersionId: locked.activeVersionId },
          });
        }
        const form = await orgRepo.getFormSummary(trx, formId);
        return { kind: "ok", body: { form: summaryBody(form!, permissions), version: versionBody(version, version.id) } };
      }),
    );
  });

  // Sharing and closing (PUB-02) --------------------------------------------

  router.get("/organizations/:orgId/forms/:formId/share", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.read", async (trx, { form }): Promise<Outcome<ShareResponse>> => {
        const url = new URL(`/f/${form.slug}`, settings.respondentOrigin).toString();
        const embedUrl = `${url}?embed=1`;
        return {
          kind: "ok",
          body: {
            url,
            embedUrl,
            embedHtml: embedSnippet(embedUrl, settings.respondentOrigin, form.slug, form.name),
            qrPayload: url,
            live: form.state === "published",
            accessMode: await orgRepo.getAccessMode(trx, formId),
          },
        };
      }),
    );
  });

  router.get("/organizations/:orgId/forms/:formId/access-policy", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.read", async (trx): Promise<Outcome<AccessPolicyResponse>> => ({
        kind: "ok",
        body: policyBody(await orgRepo.getAccessPolicy(trx, formId), await orgRepo.countResponses(trx, formId)),
      })),
    );
  });

  /**
   * Who may respond (anyone with the link, or only signed-in active members),
   * when (an optional opening and closing time) and how many (an optional
   * response limit). Takes effect immediately, including for sessions already
   * started: their acceptance check and intake read the current policy.
   */
  router.patch("/organizations/:orgId/forms/:formId/access-policy", async (req, res) => {
    const body = AccessPolicyBodySchema.safeParse(req.body);
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.publish", async (trx): Promise<Outcome<AccessPolicyResponse>> => {
        const previous = await orgRepo.getAccessPolicy(trx, formId);
        const change = body.data;
        const next: AccessPolicy = {
          mode: change.mode ?? previous.mode,
          maxResponses: change.maxResponses === undefined ? previous.maxResponses : change.maxResponses,
          openAt: change.openAt === undefined ? previous.openAt : change.openAt === null ? null : new Date(change.openAt),
          closeAt: change.closeAt === undefined ? previous.closeAt : change.closeAt === null ? null : new Date(change.closeAt),
          spamProtection: change.spamProtection ?? previous.spamProtection,
        };
        if (next.openAt && next.closeAt && next.closeAt <= next.openAt) {
          return { kind: "invalid", errors: [{ field: "closeAt", code: "CLOSE_BEFORE_OPEN", message: "The closing time must be after the opening time" }] };
        }
        const changed = (Object.keys(next) as Array<keyof AccessPolicy>).filter((k) => String(next[k]?.valueOf() ?? null) !== String(previous[k]?.valueOf() ?? null));
        if (changed.length > 0) {
          await orgRepo.setAccessPolicy(trx, orgId, formId, next, userId);
          const audited = (p: AccessPolicy) => Object.fromEntries(changed.map((k) => [k, p[k] instanceof Date ? (p[k] as Date).toISOString() : p[k]]));
          await publishRepo.appendAudit(trx, {
            tenantId: orgId,
            actor: { type: "user", id: userId },
            action: "form.access_policy_changed",
            resourceType: "form",
            resourceId: formId,
            requestId: requestIdOf(res),
            metadata: { changed: audited(next), previous: audited(previous) },
          });
        }
        return { kind: "ok", body: policyBody(next, await orgRepo.countResponses(trx, formId)) };
      }),
    );
  });

  /** Stops accepting responses immediately, including from pages already open (docs/02 §5). */
  router.post("/organizations/:orgId/forms/:formId/close", async (req, res) => {
    const body = CloseFormBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.publish", async (trx, { permissions }): Promise<Outcome<FormResponse>> => {
        const form = await orgRepo.transitionFormState(trx, formId, ["published"], "closed");
        if (!form) return { kind: "conflict", code: "FORM_STATE_CONFLICT", title: "Only a published form can be closed" };
        await publishRepo.appendAudit(trx, {
          tenantId: orgId,
          actor: { type: "user", id: userId },
          action: "form.closed",
          resourceType: "form",
          resourceId: formId,
          requestId: requestIdOf(res),
          metadata: { activeVersionId: form.activeVersionId, ...(body.data.reason ? { reason: body.data.reason } : {}) },
        });
        return { kind: "ok", body: await formResponse(trx, form, permissions) };
      }),
    );
  });

  /** Accepts responses again, for the active version. */
  router.post("/organizations/:orgId/forms/:formId/reopen", async (req, res) => {
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.publish", async (trx, { permissions }): Promise<Outcome<FormResponse>> => {
        const form = await orgRepo.transitionFormState(trx, formId, ["closed"], "published");
        if (!form) return { kind: "conflict", code: "FORM_STATE_CONFLICT", title: "Only a closed form can be reopened" };
        await publishRepo.appendAudit(trx, {
          tenantId: orgId,
          actor: { type: "user", id: userId },
          action: "form.reopened",
          resourceType: "form",
          resourceId: formId,
          requestId: requestIdOf(res),
          metadata: { activeVersionId: form.activeVersionId },
        });
        return { kind: "ok", body: await formResponse(trx, form, permissions) };
      }),
    );
  });

  // Responses (RES-01, docs/04 §7) -----------------------------------------

  function encodeResponseCursor(cutoff: string, receivedAt: string, id: string): string {
    return Buffer.from(JSON.stringify([cutoff, receivedAt, id]), "utf8").toString("base64url");
  }

  function decodeResponseCursor(value: string): { cutoff: string; receivedAt: string; id: string } | undefined {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
      const [cutoff, receivedAt, id] = parsed as unknown[];
      const isTime = (v: unknown) => typeof v === "string" && v.length <= 64 && !Number.isNaN(Date.parse(v));
      if (!isTime(cutoff) || !isTime(receivedAt) || typeof id !== "string" || !UUID_PATTERN.test(id)) return undefined;
      return { cutoff: cutoff as string, receivedAt: receivedAt as string, id };
    } catch {
      return undefined;
    }
  }

  /**
   * Responses, newest first, with every field the caller is not cleared for
   * masked. The first page fixes a cutoff carried in the cursor, so later
   * pages neither repeat nor skip responses while new ones arrive.
   */
  router.get("/organizations/:orgId/forms/:formId/submissions", async (req, res) => {
    const query = ResponseListQuerySchema.safeParse(req.query);
    if (!query.success) {
      problems.validation(res, issuesToErrors(query.error));
      return;
    }
    const q = query.data;
    const cursor = q.cursor === undefined ? undefined : decodeResponseCursor(q.cursor);
    if (q.cursor !== undefined && !cursor) {
      problems.validation(res, [{ field: "cursor", code: "INVALID_CURSOR", message: "Cursor is not valid" }]);
      return;
    }
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "responses.read", async (trx, { permissions }): Promise<Outcome<ResponseListResponse>> => {
        const readable = readableClasses(permissions);
        const versions = indexVersions(await responsesRepo.formVersions(trx, formId));
        if (q.version && !versions.byId.has(q.version)) {
          return { kind: "invalid", errors: [{ field: "version", code: "UNKNOWN_VERSION", message: "This form has no such version" }] };
        }
        if (q.field) {
          const field = versions.latestField.get(q.field);
          if (!field) return { kind: "invalid", errors: [{ field: "field", code: "UNKNOWN_FIELD", message: "This form has no such question" }] };
          // Filtering on a hidden field would reveal its answers, one yes/no at a time.
          if (!canRead(field, readable)) return { kind: "invalid", errors: [{ field: "field", code: "FIELD_MASKED", message: "You can't filter on a question you can't see" }] };
        }
        const cutoff = cursor?.cutoff ?? (await responsesRepo.currentCutoff(trx));
        const page = await responsesRepo.listResponses(trx, formId, {
          limit: q.limit,
          cutoff,
          after: cursor ? { receivedAt: cursor.receivedAt, id: cursor.id } : undefined,
          versionId: q.version,
          receivedFrom: q.from ? new Date(q.from) : undefined,
          receivedTo: q.to ? new Date(q.to) : undefined,
          answer: q.field && q.op ? { fieldId: q.field, op: q.op, value: q.value } : undefined,
        });
        const files = await responsesRepo.filesFor(trx, page.rows.map((r) => r.id));
        const last = page.rows.at(-1);
        return {
          kind: "ok",
          body: {
            columns: versions.order.map((id) => {
              const field = versions.latestField.get(id)!;
              return { fieldId: id, label: field.label, type: field.type, privacy: privacyOf(field), masked: !canRead(field, readable) };
            }),
            items: page.rows.map((row) => {
              const version = versions.byId.get(row.formVersionId)!;
              return {
                id: row.id,
                receiptNumber: shortReceipt(row.receiptId),
                receivedAt: row.receivedAt.toISOString(),
                versionNumber: version.versionNumber,
                answers: Object.fromEntries(
                  version.definition.fields
                    .filter((f) => !isLayoutType(f.type))
                    .map((f) => [f.id, presentAnswer(f, row.answers[f.id], files.get(row.id) ?? [], readable)]),
                ),
              };
            }),
            total: await responsesRepo.countResponses(trx, formId, cutoff),
            cutoff: new Date(cutoff).toISOString(),
            ...(page.more && last ? { nextCursor: encodeResponseCursor(cutoff, last.receivedAtKey, last.id) } : {}),
          },
        };
      }),
    );
  });

  router.get("/organizations/:orgId/forms/:formId/submissions/:submissionId", async (req, res) => {
    const { orgId, formId, submissionId } = req.params;
    if (!UUID_PATTERN.test(submissionId)) {
      problems.notFound(res);
      return;
    }
    respond(
      res,
      await onForm(res, orgId, formId, "responses.read", async (trx, { permissions }): Promise<Outcome<ResponseDetailResponse>> => {
        const row = await responsesRepo.getResponse(trx, formId, submissionId);
        if (!row) return { kind: "not_found" };
        const readable = readableClasses(permissions);
        const versions = indexVersions(await responsesRepo.formVersions(trx, formId));
        const version = versions.byId.get(row.formVersionId)!;
        const files = (await responsesRepo.filesFor(trx, [row.id])).get(row.id) ?? [];
        const definition = version.definition;
        // Headings and descriptions take no answer, so a response never lists them.
        const byId = new Map(definition.fields.filter((f) => !isLayoutType(f.type)).map((f) => [f.id, f]));
        const ordered = definition.pages.flatMap((p) => p.fieldIds.flatMap((id) => byId.get(id) ?? []));
        return {
          kind: "ok",
          body: {
            id: row.id,
            receiptNumber: shortReceipt(row.receiptId),
            receivedAt: row.receivedAt.toISOString(),
            version: { id: row.formVersionId, versionNumber: version.versionNumber, active: version.active },
            respondent: !row.actor
              ? { kind: "anonymous" }
              : readable.has("personal")
                ? { kind: "member", masked: false, userId: row.actor.id, displayName: row.actor.displayName }
                : { kind: "member", masked: true },
            fields: ordered.map((field) => {
              const visible = canRead(field, readable);
              const fieldFiles = files.filter((f) => f.fieldId === field.id);
              return {
                fieldId: field.id,
                label: field.label,
                type: field.type,
                privacy: privacyOf(field),
                masked: !visible,
                answer: presentAnswer(field, row.answers[field.id], fieldFiles, readable),
                ...(visible && field.type === "file" ? { files: fieldFiles } : {}),
              };
            }),
          },
        };
      }),
    );
  });

  /** Appends an audit entry for the signed-in user. Metadata holds identifiers and counts, never answers. */
  function audit(trx: Trx, res: Response, tenantId: string, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>) {
    return publishRepo.appendAudit(trx, {
      tenantId,
      actor: { type: "user", id: sessionOf(res).userId },
      action,
      resourceType,
      resourceId,
      requestId: requestIdOf(res),
      metadata,
    });
  }

  // Governance (GOV-01, docs/04 §7) -----------------------------------------

  const LEGAL_HOLD = { kind: "conflict", code: "LEGAL_HOLD", title: "This form is on legal hold; nothing on it can be deleted" } as const;

  /** Deletes one response: hidden at once, then purged (content, files and exports) by the worker. */
  router.delete("/organizations/:orgId/forms/:formId/submissions/:submissionId", async (req, res) => {
    const body = DeletionBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, formId, submissionId } = req.params;
    if (!UUID_PATTERN.test(submissionId)) {
      problems.notFound(res);
      return;
    }
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "responses.delete", async (trx): Promise<Outcome<{ deleted: true }>> => {
        const retention = await governanceRepo.getRetention(trx, formId);
        if (retention?.legalHold) return LEGAL_HOLD;
        if (!(await governanceRepo.deleteResponse(trx, formId, submissionId, userId, body.data.reason))) return { kind: "not_found" };
        // The reason stays with the deletion record; the audit entry only says one was given.
        await audit(trx, res, orgId, "response.deleted", "submission", submissionId, { formId });
        return { kind: "ok", status: 202, body: { deleted: true } };
      }),
    );
  });

  /** Deletes a form and every response on it; the worker purges their content. */
  router.delete("/organizations/:orgId/forms/:formId", async (req, res) => {
    const body = DeletionBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.delete", async (trx): Promise<Outcome<{ deleted: true; responses: number }>> => {
        const retention = await governanceRepo.getRetention(trx, formId);
        if (retention?.legalHold) return LEGAL_HOLD;
        const responses = await governanceRepo.deleteForm(trx, formId, userId, body.data.reason);
        await audit(trx, res, orgId, "form.deleted", "form", formId, { responses });
        return { kind: "ok", status: 202, body: { deleted: true, responses } };
      }),
    );
  });

  router.get("/organizations/:orgId/forms/:formId/retention", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.read", async (trx): Promise<Outcome<RetentionResponse>> => ({
        kind: "ok",
        body: (await governanceRepo.getRetention(trx, formId))!,
      })),
    );
  });

  /**
   * How long responses are kept (needs forms.publish), and the legal hold,
   * which stops all deletion on the form (owners and admins only).
   */
  router.patch("/organizations/:orgId/forms/:formId/retention", async (req, res) => {
    const body = RetentionBodySchema.safeParse(req.body);
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.publish", async (trx, { membership }): Promise<Outcome<RetentionResponse>> => {
        const current = (await governanceRepo.getRetention(trx, formId))!;
        if (body.data.legalHold !== undefined && body.data.legalHold !== current.legalHold && membership.role !== "owner" && membership.role !== "admin") {
          return { kind: "forbidden" };
        }
        // Shortening retention would delete responses: not while they are on hold.
        const next = { retentionDays: body.data.retentionDays ?? current.retentionDays, legalHold: body.data.legalHold ?? current.legalHold };
        if (next.retentionDays !== current.retentionDays || next.legalHold !== current.legalHold) {
          await governanceRepo.setRetention(trx, formId, next);
          await audit(trx, res, orgId, "form.retention_changed", "form", formId, { ...next, previous: current });
        }
        return { kind: "ok", body: next };
      }),
    );
  });

  function encodeAuditCursor(occurredAt: string, id: string): string {
    return Buffer.from(JSON.stringify([occurredAt, id]), "utf8").toString("base64url");
  }

  function decodeAuditCursor(value: string): { occurredAt: string; id: string } | undefined {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
      const [occurredAt, id] = parsed as unknown[];
      if (typeof occurredAt !== "string" || occurredAt.length > 64 || Number.isNaN(Date.parse(occurredAt))) return undefined;
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) return undefined;
      return { occurredAt, id };
    } catch {
      return undefined;
    }
  }

  /** The organization's audit log, newest first (owners and admins: organization.audit.read). */
  router.get("/organizations/:orgId/audit", async (req, res) => {
    const query = AuditQuerySchema.safeParse(req.query);
    if (!query.success) {
      problems.validation(res, issuesToErrors(query.error));
      return;
    }
    const cursor = query.data.cursor === undefined ? undefined : decodeAuditCursor(query.data.cursor);
    if (query.data.cursor !== undefined && !cursor) {
      problems.validation(res, [{ field: "cursor", code: "INVALID_CURSOR", message: "Cursor is not valid" }]);
      return;
    }
    const outcome = await inOrganization(req.params.orgId, sessionOf(res).userId, async (trx, membership): Promise<Outcome<AuditListResponse>> => {
      if (!orgPermissions(membership).has("organization.audit.read")) return { kind: "forbidden" };
      const page = await governanceRepo.listAudit(trx, { limit: query.data.limit, after: cursor, action: query.data.action, resourceId: query.data.resourceId });
      const last = page.entries.at(-1);
      return {
        kind: "ok",
        body: {
          items: page.entries.map((e) => ({
            id: e.id,
            occurredAt: e.occurredAt.toISOString(),
            actor: e.actor,
            action: e.action,
            resourceType: e.resourceType,
            resourceId: e.resourceId,
            requestId: e.requestId,
            metadata: e.metadata,
          })),
          ...(page.more && last ? { nextCursor: encodeAuditCursor(last.occurredAtKey, last.id) } : {}),
        },
      };
    });
    respond(res, outcome);
  });

  // Members and invitations (PAR-05, docs/01 §4) -------------------------------

  /** Roles ranked so a manager can only hand out roles at or below their own. */
  const ROLE_RANK = { owner: 4, admin: 3, creator: 2, analyst: 1, approver: 1 } as const;
  const INVITE_TOKEN_BYTES = 32;
  const MAX_PENDING_INVITATIONS = 50;

  function memberBody(m: Member): MemberResponse["member"] {
    return { userId: m.userId, displayName: m.displayName, role: m.role, status: m.status, joinedAt: m.joinedAt.toISOString() };
  }

  function invitationBody(i: Invitation): InvitationBody {
    return {
      id: i.id,
      email: i.email,
      role: i.role,
      status: i.status,
      createdBy: i.createdBy,
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
      acceptedBy: i.acceptedBy,
      acceptedAt: i.acceptedAt?.toISOString() ?? null,
    };
  }

  router.get("/organizations/:orgId/members", async (req, res) => {
    respond(
      res,
      await inOrganization(req.params.orgId, sessionOf(res).userId, async (trx, membership): Promise<Outcome<MemberListResponse>> => {
        if (!orgPermissions(membership).has("members.manage")) return { kind: "forbidden" };
        return { kind: "ok", body: { members: (await membersRepo.listMembers(trx)).map(memberBody) } };
      }),
    );
  });

  /**
   * Changes a member's role or removes (revokes) them. Only owners change
   * owners or make new ones, and the organization always keeps one active
   * owner. Memberships are never deleted, so removed members can come back.
   */
  router.patch("/organizations/:orgId/members/:userId", async (req, res) => {
    const body = MemberPatchBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, userId: targetId } = req.params;
    const userId = sessionOf(res).userId;
    if (!UUID_PATTERN.test(targetId)) {
      problems.notFound(res);
      return;
    }
    respond(
      res,
      await inOrganization(orgId, userId, async (trx, membership): Promise<Outcome<MemberResponse>> => {
        if (!orgPermissions(membership).has("members.manage")) return { kind: "forbidden" };
        const owners = await membersRepo.lockActiveOwners(trx);
        const target = await membersRepo.getMember(trx, targetId);
        if (!target) return { kind: "not_found" };
        const { role, status } = body.data;
        if ((target.role === "owner" || role === "owner") && membership.role !== "owner") return { kind: "forbidden" };
        const losesOwner = target.role === "owner" && target.status === "active" && ((role !== undefined && role !== "owner") || status === "revoked");
        if (losesOwner && owners.length <= 1) {
          return { kind: "conflict", code: "LAST_OWNER", title: "An organization needs at least one owner; make someone else an owner first" };
        }
        const change = { ...(role === undefined ? {} : { role }), ...(status === undefined ? {} : { status }) };
        await membersRepo.updateMember(trx, targetId, change);
        let action = "member.role_changed";
        if (status === "revoked" && target.status === "active") action = "member.removed";
        else if (status === "active" && target.status === "revoked") action = "member.restored";
        await publishRepo.appendAudit(trx, {
          tenantId: orgId,
          actor: { type: "user", id: userId },
          action,
          resourceType: "member",
          resourceId: targetId,
          requestId: requestIdOf(res),
          metadata: { before: { role: target.role, status: target.status }, after: change },
        });
        const updated = await membersRepo.getMember(trx, targetId);
        return { kind: "ok", body: { member: memberBody(updated ?? target) } };
      }),
    );
  });

  router.get("/organizations/:orgId/invitations", async (req, res) => {
    respond(
      res,
      await inOrganization(req.params.orgId, sessionOf(res).userId, async (trx, membership): Promise<Outcome<InvitationListResponse>> => {
        if (!orgPermissions(membership).has("members.manage")) return { kind: "forbidden" };
        return { kind: "ok", body: { invitations: (await membersRepo.listInvitations(trx)).map(invitationBody) } };
      }),
    );
  });

  /**
   * Creates a single-use join link for a role no higher than the inviter's.
   * The link is returned once; only a hash of its token is stored.
   */
  router.post("/organizations/:orgId/invitations", async (req, res) => {
    const body = InvitationCreateBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId } = req.params;
    const userId = sessionOf(res).userId;
    const token = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
    respond(
      res,
      await inOrganization(orgId, userId, async (trx, membership): Promise<Outcome<InvitationCreatedResponse>> => {
        if (!orgPermissions(membership).has("members.manage")) return { kind: "forbidden" };
        if (ROLE_RANK[body.data.role] > ROLE_RANK[membership.role]) return { kind: "forbidden" };
        const pending = (await membersRepo.listInvitations(trx)).filter((i) => i.status === "pending").length;
        if (pending >= MAX_PENDING_INVITATIONS) {
          return { kind: "problem", status: 429, code: "TOO_MANY_INVITATIONS", title: `At most ${MAX_PENDING_INVITATIONS} open invitations; revoke some first` };
        }
        const invitation = await membersRepo.createInvitation(trx, {
          tenantId: orgId,
          email: body.data.email ?? null,
          role: body.data.role,
          tokenHash: sha256(token),
          createdBy: userId,
          expiresAt: new Date(Date.now() + body.data.expiresInDays * 86_400_000),
        });
        await publishRepo.appendAudit(trx, {
          tenantId: orgId,
          actor: { type: "user", id: userId },
          action: "invitation.created",
          resourceType: "invitation",
          resourceId: invitation.id,
          requestId: requestIdOf(res),
          metadata: { role: invitation.role, expiresAt: invitation.expiresAt.toISOString() },
        });
        return { kind: "ok", status: 201, body: { invitation: invitationBody(invitation), url: `${settings.consoleOrigin}/invite/${token}` } };
      }),
    );
  });

  router.post("/organizations/:orgId/invitations/:invitationId/revoke", async (req, res) => {
    const { orgId, invitationId } = req.params;
    const userId = sessionOf(res).userId;
    if (!UUID_PATTERN.test(invitationId)) {
      problems.notFound(res);
      return;
    }
    respond(
      res,
      await inOrganization(orgId, userId, async (trx, membership): Promise<Outcome<InvitationResponse>> => {
        if (!orgPermissions(membership).has("members.manage")) return { kind: "forbidden" };
        const invitation = await membersRepo.revokeInvitation(trx, invitationId);
        if (!invitation) {
          const exists = (await membersRepo.listInvitations(trx, 1000)).some((i) => i.id === invitationId);
          return exists ? { kind: "conflict", code: "INVITATION_CLOSED", title: "This invitation was already used or revoked" } : { kind: "not_found" };
        }
        await publishRepo.appendAudit(trx, {
          tenantId: orgId,
          actor: { type: "user", id: userId },
          action: "invitation.revoked",
          resourceType: "invitation",
          resourceId: invitation.id,
          requestId: requestIdOf(res),
        });
        return { kind: "ok", body: { invitation: invitationBody(invitation) } };
      }),
    );
  });

  /**
   * Joins the signed-in user to the invitation's organization. An unknown,
   * used, revoked or expired link is reported the same way, so links cannot
   * be probed. Using the link and joining commit together.
   */
  router.post("/invitations/accept", async (req, res) => {
    const body = InvitationAcceptBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const userId = sessionOf(res).userId;
    const tokenHash = sha256(body.data.token);
    const invalid = { kind: "problem", status: 404, code: "INVITATION_INVALID", title: "This invitation link is not valid any more; ask for a new one" } as const;
    const tenantId = await membersRepo.resolveInvitation(db, tokenHash);
    if (!tenantId) {
      respond(res, invalid);
      return;
    }
    respond(
      res,
      await withContext(db, { tenantId, userId }, async (trx): Promise<Outcome<InvitationAcceptResponse>> => {
        const existing = await orgRepo.getMembership(trx, userId);
        if (existing?.status === "active") {
          return { kind: "conflict", code: "ALREADY_MEMBER", title: "You are already a member of this organization" };
        }
        const invitation = await membersRepo.markInvitationAccepted(trx, tokenHash, userId);
        if (!invitation) return invalid;
        await membersRepo.upsertMember(trx, tenantId, userId, invitation.role);
        await publishRepo.appendAudit(trx, {
          tenantId,
          actor: { type: "user", id: userId },
          action: "invitation.accepted",
          resourceType: "invitation",
          resourceId: invitation.id,
          requestId: requestIdOf(res),
          metadata: { role: invitation.role },
        });
        return { kind: "ok", body: { organization: { id: tenantId, role: invitation.role } } };
      }),
    );
  });

  // AI generation (AI-01, docs/03 §4) ---------------------------------------

  /** One active generation per user and five per organization (docs/03 §4). */
  const AI_ACTIVE_PER_USER = 1;
  const AI_ACTIVE_PER_TENANT = 5;
  const AI_UNAVAILABLE = {
    kind: "problem",
    status: 503,
    code: "AI_UNAVAILABLE",
    title: "AI generation isn't available right now; you can keep editing the form yourself",
  } as const;

  function aiBody(g: AiGeneration): AiGenerationBody {
    return {
      id: g.id,
      formId: g.formId,
      operation: g.operation,
      status: g.status,
      baseRevision: g.baseRevision,
      requestedBy: g.requestedBy,
      provider: g.provider,
      model: g.model,
      proposal: g.proposal,
      summary: g.summary,
      failureCode: g.failureCode,
      usage: g.usage,
      createdAt: g.createdAt.toISOString(),
      deadlineAt: g.deadlineAt.toISOString(),
      finishedAt: g.finishedAt?.toISOString() ?? null,
      decision: g.decision ? { ...g.decision, at: g.decision.at.toISOString() } : null,
    };
  }

  /**
   * Asks the worker for a proposal for this draft. Nothing changes the draft:
   * the result is a validated proposal to review (AI-02 applies it). The
   * generation and its job commit together, so a crash cannot lose one.
   */
  router.post("/organizations/:orgId/forms/:formId/ai-jobs", async (req, res) => {
    const body = AiJobCreateBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.edit", async (trx, { form }): Promise<Outcome<AiJobResponse>> => {
        if (!settings.aiEnabled) return AI_UNAVAILABLE;
        const aiSettings = await aiRepo.getSettings(trx);
        if (!aiSettings.enabled) {
          return { kind: "problem", status: 403, code: "AI_NOT_ENABLED", title: "AI is turned off for this organization; an owner can turn it on" };
        }
        if (form.state === "archived") return { kind: "conflict", code: "FORM_ARCHIVED", title: "Restore the form before editing it" };
        const draft = await orgRepo.getDraft(trx, formId);
        if (!draft) return { kind: "not_found" };
        if (draft.revision !== body.data.baseRevision) {
          return { kind: "problem", status: 412, code: "DRAFT_CONFLICT", title: "This draft was changed by someone else", extra: { currentRevision: draft.revision } };
        }
        await aiRepo.lockTenantGenerations(trx, orgId);
        await aiRepo.expireOverdue(trx);
        const active = await aiRepo.countActive(trx, userId);
        if (active.user >= AI_ACTIVE_PER_USER) {
          return { kind: "conflict", code: "AI_GENERATION_IN_PROGRESS", title: "Wait for your current AI request to finish, or cancel it" };
        }
        if (active.tenant >= AI_ACTIVE_PER_TENANT) {
          return { kind: "problem", status: 429, code: "AI_BUSY", title: "Your organization has too many AI requests running; try again shortly" };
        }
        // Worst case reserved now, against today's limit; the worker charges actual use and releases the rest.
        const reserved = reservationTokens({
          operation: body.data.operation,
          prompt: body.data.prompt,
          base: draft.definition as unknown as FormDefinition,
        });
        if (!(await aiRepo.reserveTokens(trx, orgId, reserved, aiSettings.dailyTokenLimit))) {
          const today = await aiRepo.usageToday(trx);
          return {
            kind: "problem",
            status: 429,
            code: "AI_BUDGET_EXCEEDED",
            title: "Your organization has used today's AI budget; try again tomorrow or ask an owner to raise it",
            extra: { dailyTokenLimit: aiSettings.dailyTokenLimit, usedTokens: today.used, reservedTokens: today.reserved, requestTokens: reserved },
          };
        }
        const generation = await aiRepo.createGeneration(trx, {
          tenantId: orgId,
          formId,
          requestedBy: userId,
          operation: body.data.operation,
          baseRevision: draft.revision,
          baseDefinition: draft.definition,
          prompt: body.data.prompt,
          promptDigest: createHash("sha256").update(body.data.prompt, "utf8").digest("hex"),
          templateVersion: TEMPLATE_VERSION,
          deadlineSeconds: AI_DEADLINE_SECONDS,
          reservedTokens: reserved,
        });
        await jobsRepo.enqueueJob(trx, {
          tenantId: orgId,
          type: AI_GENERATE_JOB,
          dedupeKey: generation.id,
          payload: { generationId: generation.id },
          traceId: requestIdOf(res),
          maxAttempts: AI_GENERATE_MAX_ATTEMPTS,
        });
        // The prompt stays out of the audit log; its digest is on the generation.
        await audit(trx, res, orgId, "ai.generation_requested", "form", formId, { generationId: generation.id, operation: generation.operation });
        return { kind: "ok", status: 202, body: { job: aiBody(generation) }, headers: { Location: `/api/v1/organizations/${orgId}/ai-jobs/${generation.id}` } };
      }),
    );
  });

  /** Loads a generation for someone who can read its form; `action` decides the rest. */
  function onGeneration<T>(
    res: Response,
    orgId: string,
    jobId: string,
    action: (trx: Trx, generation: AiGeneration, permissions: Set<FormPermission>, membership: MembershipRecord) => Promise<Outcome<T>>,
  ) {
    const userId = sessionOf(res).userId;
    if (!UUID_PATTERN.test(jobId)) return Promise.resolve(NOT_VISIBLE);
    return inOrganization(orgId, userId, async (trx, membership): Promise<Outcome<T>> => {
      await aiRepo.expireOverdue(trx, jobId);
      const generation = await aiRepo.getGeneration(trx, jobId);
      if (!generation || !(await orgRepo.getFormSummary(trx, generation.formId))) return { kind: "not_found" };
      const grants = (await orgRepo.listUserFormGrants(trx, generation.formId, userId)).filter(isFormPermission);
      const permissions = formPermissions(membership, grants);
      if (!permissions.has("forms.read")) return { kind: "not_found" };
      return action(trx, generation, permissions, membership);
    });
  }

  /** A generation's state, and its proposal once ready (forms.edit on its form). */
  router.get("/organizations/:orgId/ai-jobs/:jobId", async (req, res) => {
    const { orgId, jobId } = req.params;
    respond(
      res,
      await onGeneration(res, orgId, jobId, async (_trx, generation, permissions): Promise<Outcome<AiJobResponse>> =>
        permissions.has("forms.edit") ? { kind: "ok", body: { job: aiBody(generation) } } : { kind: "forbidden" },
      ),
    );
  });

  /**
   * Cancels a generation (its requester, or an owner or admin). Best effort
   * for a provider call already running, but its result is then discarded.
   */
  router.post("/organizations/:orgId/ai-jobs/:jobId/cancel", async (req, res) => {
    const { orgId, jobId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onGeneration(res, orgId, jobId, async (trx, generation, _permissions, membership): Promise<Outcome<AiJobResponse>> => {
        if (generation.requestedBy !== userId && membership.role !== "owner" && membership.role !== "admin") return { kind: "forbidden" };
        const cancelled = await aiRepo.cancelGeneration(trx, jobId);
        if (!cancelled) return { kind: "ok", body: { job: aiBody(generation) } };
        await audit(trx, res, orgId, "ai.generation_cancelled", "form", generation.formId, { generationId: jobId });
        return { kind: "ok", body: { job: aiBody(cancelled) } };
      }),
    );
  });

  // AI opt-in and budget (AI-03, docs/03 §4) ----------------------------------

  async function aiSettingsBody(trx: Trx): Promise<AiSettingsResponse> {
    const [current, today] = await Promise.all([aiRepo.getSettings(trx), aiRepo.usageToday(trx)]);
    return { settings: current, available: settings.aiEnabled, today: { usedTokens: today.used, reservedTokens: today.reserved } };
  }

  /** AI settings and today's use, for any member (so the builder can explain why AI is off). */
  router.get("/organizations/:orgId/ai-settings", async (req, res) => {
    respond(
      res,
      await inOrganization(req.params.orgId, sessionOf(res).userId, async (trx): Promise<Outcome<AiSettingsResponse>> => ({ kind: "ok", body: await aiSettingsBody(trx) })),
    );
  });

  /** Turns AI on or off and sets the daily budget (organization.manage). Audited. */
  router.put("/organizations/:orgId/ai-settings", async (req, res) => {
    const body = AiSettingsBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await inOrganization(orgId, userId, async (trx, membership): Promise<Outcome<AiSettingsResponse>> => {
        if (!orgPermissions(membership).has("organization.manage")) return { kind: "forbidden" };
        const before = await aiRepo.getSettings(trx);
        await aiRepo.saveSettings(trx, orgId, body.data, userId);
        await publishRepo.appendAudit(trx, {
          tenantId: orgId,
          actor: { type: "user", id: userId },
          action: "organization.ai_settings_changed",
          resourceType: "organization",
          resourceId: orgId,
          requestId: requestIdOf(res),
          metadata: { before, after: body.data },
        });
        return { kind: "ok", body: await aiSettingsBody(trx) };
      }),
    );
  });

  // Deciding AI proposals (AI-02, docs/03 §4) ---------------------------------

  /** Why a proposal cannot be decided now, or undefined if it can. */
  function undecidable(generation: AiGeneration): Outcome<never> | undefined {
    if (generation.status !== "succeeded") return { kind: "conflict", code: "AI_PROPOSAL_NOT_READY", title: "This AI request has no proposal to decide on" };
    if (generation.decision) return { kind: "conflict", code: "AI_PROPOSAL_DECIDED", title: `This proposal was already ${generation.decision.kind}` };
    return undefined;
  }

  /**
   * Applies a proposal to the draft: an ordinary optimistic draft save
   * against the revision the proposal was built on, after validating it
   * again. If anyone saved the draft since, nothing is written and the
   * author is told to ask again against the current draft. Never publishes.
   */
  router.post("/organizations/:orgId/ai-jobs/:jobId/apply", async (req, res) => {
    const body = AiApplyBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, jobId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onGeneration(res, orgId, jobId, async (trx, found, permissions): Promise<Outcome<AiApplyResponse>> => {
        if (!permissions.has("forms.edit")) return { kind: "forbidden" };
        // Serializes concurrent decisions on the same proposal.
        const generation = (await aiRepo.lockGeneration(trx, found.id))!;
        const blocked = undecidable(generation);
        if (blocked) return blocked;
        const form = (await orgRepo.getFormSummary(trx, generation.formId))!;
        if (form.state === "archived") return { kind: "conflict", code: "FORM_ARCHIVED", title: "Restore the form before editing it" };
        const draft = await orgRepo.getDraft(trx, generation.formId);
        if (!draft) return { kind: "not_found" };
        const stale = {
          kind: "problem",
          status: 412,
          code: "DRAFT_CONFLICT",
          title: "The draft changed after this proposal was made; ask again to build on the current draft",
          extra: { currentRevision: draft.revision, baseRevision: generation.baseRevision },
        } as const;
        if (draft.revision !== generation.baseRevision || body.data.expectedRevision !== draft.revision) return stale;
        // Validated again: the proposal is stored data, and the rules may have moved on since.
        const checked = validateDefinition(generation.proposal);
        if (!checked.ok) {
          return {
            kind: "problem",
            status: 422,
            code: "AI_PROPOSAL_INVALID",
            title: "This proposal is no longer a valid form; ask again",
            extra: { errors: checked.issues.slice(0, 50).map((i) => ({ field: i.path || "/", code: i.code, message: i.message })) },
          };
        }
        const revision = await orgRepo.saveDraft(trx, generation.formId, generation.baseRevision, checked.definition as unknown as Record<string, unknown>, userId);
        if (revision === undefined) return stale;
        const decided = (await aiRepo.decideGeneration(trx, generation.id, { kind: "applied", revision }, userId))!;
        await audit(trx, res, orgId, "ai.proposal_applied", "form", generation.formId, { generationId: generation.id, revision });
        return { kind: "ok", body: { job: aiBody(decided), draft: { revision } }, headers: { ETag: draftEtag(revision) } };
      }),
    );
  });

  /** Rejects a proposal; the draft is untouched. */
  router.post("/organizations/:orgId/ai-jobs/:jobId/reject", async (req, res) => {
    const { orgId, jobId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onGeneration(res, orgId, jobId, async (trx, found, permissions): Promise<Outcome<AiJobResponse>> => {
        if (!permissions.has("forms.edit")) return { kind: "forbidden" };
        const generation = (await aiRepo.lockGeneration(trx, found.id))!;
        const blocked = undecidable(generation);
        if (blocked) return blocked;
        const decided = (await aiRepo.decideGeneration(trx, generation.id, { kind: "rejected" }, userId))!;
        await audit(trx, res, orgId, "ai.proposal_rejected", "form", generation.formId, { generationId: generation.id });
        return { kind: "ok", body: { job: aiBody(decided) } };
      }),
    );
  });

  // Analytics (ANA-01) ----------------------------------------------------------

  /** At most a year of days per request. */
  const ANALYTICS_MAX_DAYS = 366;
  const DAY_MS = 86_400_000;

  /**
   * Views, starts and accepts per UTC day for a form (analytics.read).
   * Aggregated from respondent sessions only: no answers are read.
   */
  router.get("/organizations/:orgId/forms/:formId/analytics", async (req, res) => {
    const query = AnalyticsQuerySchema.safeParse(req.query);
    if (!query.success) {
      problems.validation(res, issuesToErrors(query.error));
      return;
    }
    const to = query.data.to ?? new Date().toISOString().slice(0, 10);
    const from = query.data.from ?? new Date(Date.parse(to) - 29 * DAY_MS).toISOString().slice(0, 10);
    const span = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
    if (span < 1 || span > ANALYTICS_MAX_DAYS) {
      problems.validation(res, [{ field: "from", code: "INVALID_RANGE", message: `Choose 1 to ${ANALYTICS_MAX_DAYS} days, with from on or before to` }]);
      return;
    }
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "analytics.read", async (trx): Promise<Outcome<AnalyticsResponse>> => {
        const counted = new Map((await analyticsRepo.formDays(trx, formId, from, to)).map((d) => [d.day, d]));
        const days = Array.from({ length: span }, (_, i) => {
          const day = new Date(Date.parse(from) + i * DAY_MS).toISOString().slice(0, 10);
          return counted.get(day) ?? { day, views: 0, starts: 0, accepts: 0 };
        });
        const sum = (k: "views" | "starts" | "accepts") => days.reduce((n, d) => n + d[k], 0);
        const [views, starts, accepts] = [sum("views"), sum("starts"), sum("accepts")];
        return {
          kind: "ok",
          body: {
            from,
            to,
            days,
            totals: { views, starts, accepts, startRate: views ? starts / views : null, completionRate: starts ? accepts / starts : null },
            definitions: { ...ANALYTICS_DEFINITIONS },
          },
        };
      }),
    );
  });

  // Email and webhooks (AUT-01, docs/05 §6) ----------------------------------

  /** After a rotation the previous secret keeps signing (as a second signature) this long. */
  const SECRET_OVERLAP_SECONDS = 24 * 60 * 60;

  function integrationBody(i: Integration): IntegrationBody {
    return {
      id: i.id,
      formId: i.formId,
      kind: i.kind,
      name: i.name,
      enabled: i.enabled,
      url: i.url,
      recipients: i.recipients,
      fieldIds: i.fieldIds,
      previousSecretExpiresAt: i.previousSecretExpiresAt?.toISOString() ?? null,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    };
  }

  function deliveryBody(d: Delivery): DeliveryBody {
    return {
      id: d.id,
      integrationId: d.integrationId,
      submissionId: d.submissionId,
      eventId: d.eventId,
      status: d.status,
      attempts: d.attempts,
      lastStatusCode: d.lastStatusCode,
      lastError: d.lastError,
      ambiguous: d.ambiguous,
      nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
      completedAt: d.completedAt?.toISOString() ?? null,
    };
  }

  /**
   * Webhook payload fields must exist in the draft, and the person choosing
   * them must be allowed to read their answers: a webhook cannot be used to
   * send out answers its creator could not see (docs/06 §3).
   */
  async function payloadFieldErrors(trx: Trx, formId: string, fieldIds: string[], permissions: Set<FormPermission>): Promise<FieldError[]> {
    const draft = await orgRepo.getDraft(trx, formId);
    const fields = new Map(((draft?.definition as unknown as FormDefinition | undefined)?.fields ?? []).map((f) => [f.id, f]));
    const errors: FieldError[] = [];
    fieldIds.forEach((id, i) => {
      const field = fields.get(id);
      if (!field || isLayoutType(field.type)) {
        errors.push({ field: `fieldIds[${i}]`, code: "UNKNOWN_FIELD", message: field ? "Headings and descriptions have no answer to send" : "This question is not on the form" });
        return;
      }
      const privacy = privacyOf(field);
      const needed: FormPermission =
        privacy === "sensitive" ? "responses.read_sensitive" : privacy === "personal" ? "responses.read_personal" : "responses.read";
      if (!permissions.has("responses.read") || !permissions.has(needed)) {
        errors.push({ field: `fieldIds[${i}]`, code: "FIELD_NOT_READABLE", message: "You can't send answers you aren't allowed to read" });
      }
    });
    return errors;
  }

  /** A form's integrations for people who manage integrations and can read the form. */
  router.get("/organizations/:orgId/forms/:formId/integrations", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.read", async (trx, { membership }): Promise<Outcome<IntegrationListResponse>> => {
        if (!orgPermissions(membership).has("integrations.manage")) return { kind: "forbidden" };
        return { kind: "ok", body: { items: (await integrationsRepo.listIntegrations(trx, formId)).map(integrationBody) } };
      }),
    );
  });

  /** Adds an email notification or a signed webhook; a webhook's signing secret is returned once. */
  router.post("/organizations/:orgId/forms/:formId/integrations", async (req, res) => {
    const body = IntegrationCreateBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    const input = body.data;
    if (input.kind === "webhook") {
      const problem = checkWebhookUrl(input.url, settings.webhookPolicy);
      if (problem) {
        problems.validation(res, [{ field: "url", code: problem.code, message: problem.message }]);
        return;
      }
    }
    respond(
      res,
      await onForm(res, orgId, formId, "forms.read", async (trx, { membership, permissions }): Promise<Outcome<IntegrationResponse>> => {
        if (!orgPermissions(membership).has("integrations.manage")) return { kind: "forbidden" };
        let secret: string | undefined;
        let integration: Integration;
        if (input.kind === "webhook") {
          const errors = await payloadFieldErrors(trx, formId, input.fieldIds, permissions);
          if (errors.length > 0) return { kind: "invalid", errors };
          secret = newWebhookSecret();
          integration = await integrationsRepo.createIntegration(trx, orgId, formId, userId, {
            kind: "webhook",
            name: input.name,
            url: input.url,
            fieldIds: [...new Set(input.fieldIds)],
            secretCiphertext: encryptSecret(secret, settings.integrationSecretKey),
          });
        } else {
          integration = await integrationsRepo.createIntegration(trx, orgId, formId, userId, {
            kind: "email",
            name: input.name,
            recipients: [...new Set(input.recipients.map((r) => r.toLowerCase()))],
          });
        }
        // Destinations stay out of the audit log: URLs can carry tokens and addresses are personal data.
        await audit(trx, res, orgId, "integration.created", "integration", integration.id, { formId, kind: integration.kind, fields: integration.fieldIds.length });
        return { kind: "ok", status: 201, body: { integration: integrationBody(integration), ...(secret ? { secret } : {}) } };
      }),
    );
  });

  /** Loads an integration for someone who manages integrations and can read its form. */
  function onIntegration<T>(
    res: Response,
    orgId: string,
    integrationId: string,
    action: (trx: Trx, integration: Integration, permissions: Set<FormPermission>) => Promise<Outcome<T>>,
  ) {
    const userId = sessionOf(res).userId;
    if (!UUID_PATTERN.test(integrationId)) return Promise.resolve(NOT_VISIBLE);
    return inOrganization(orgId, userId, async (trx, membership): Promise<Outcome<T>> => {
      const integration = await integrationsRepo.getIntegration(trx, integrationId);
      if (!integration || !(await orgRepo.getFormSummary(trx, integration.formId))) return { kind: "not_found" };
      const grants = (await orgRepo.listUserFormGrants(trx, integration.formId, userId)).filter(isFormPermission);
      const permissions = formPermissions(membership, grants);
      if (!permissions.has("forms.read")) return { kind: "not_found" };
      if (!orgPermissions(membership).has("integrations.manage")) return { kind: "forbidden" };
      return action(trx, integration, permissions);
    });
  }

  /** Renames, pauses or resumes an integration, or changes its destination or fields. */
  router.patch("/organizations/:orgId/integrations/:integrationId", async (req, res) => {
    const body = IntegrationPatchBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const { orgId, integrationId } = req.params;
    respond(
      res,
      await onIntegration(res, orgId, integrationId, async (trx, integration, permissions): Promise<Outcome<IntegrationResponse>> => {
        const patch = body.data;
        const wrongKind =
          integration.kind === "webhook" ? (patch.recipients !== undefined ? "recipients" : undefined) : patch.url !== undefined ? "url" : patch.fieldIds !== undefined ? "fieldIds" : undefined;
        if (wrongKind) return { kind: "invalid", errors: [{ field: wrongKind, code: "NOT_FOR_THIS_KIND", message: `A ${integration.kind} integration has no ${wrongKind}` }] };
        if (patch.url !== undefined) {
          const problem = checkWebhookUrl(patch.url, settings.webhookPolicy);
          if (problem) return { kind: "invalid", errors: [{ field: "url", code: problem.code, message: problem.message }] };
        }
        if (patch.fieldIds !== undefined) {
          const errors = await payloadFieldErrors(trx, integration.formId, patch.fieldIds, permissions);
          if (errors.length > 0) return { kind: "invalid", errors };
        }
        const updated = (await integrationsRepo.updateIntegration(trx, integration.id, {
          ...patch,
          ...(patch.fieldIds ? { fieldIds: [...new Set(patch.fieldIds)] } : {}),
          ...(patch.recipients ? { recipients: [...new Set(patch.recipients.map((r) => r.toLowerCase()))] } : {}),
        }))!;
        await audit(trx, res, orgId, "integration.updated", "integration", integration.id, { formId: integration.formId, changed: Object.keys(patch).toSorted() });
        return { kind: "ok", body: { integration: integrationBody(updated) } };
      }),
    );
  });

  /** Removes an integration; deliveries not yet sent are skipped. */
  router.delete("/organizations/:orgId/integrations/:integrationId", async (req, res) => {
    const { orgId, integrationId } = req.params;
    respond(
      res,
      await onIntegration(res, orgId, integrationId, async (trx, integration): Promise<Outcome<{ deleted: true }>> => {
        await integrationsRepo.deleteIntegration(trx, integration.id);
        await audit(trx, res, orgId, "integration.deleted", "integration", integration.id, { formId: integration.formId, kind: integration.kind });
        return { kind: "ok", body: { deleted: true } };
      }),
    );
  });

  /** New webhook signing secret, returned once; the old one is still sent for 24 hours. */
  router.post("/organizations/:orgId/integrations/:integrationId/rotate-secret", async (req, res) => {
    const { orgId, integrationId } = req.params;
    respond(
      res,
      await onIntegration(res, orgId, integrationId, async (trx, integration): Promise<Outcome<IntegrationResponse>> => {
        if (integration.kind !== "webhook") return { kind: "conflict", code: "NOT_A_WEBHOOK", title: "Only webhooks have signing secrets" };
        const secret = newWebhookSecret();
        const rotated = (await integrationsRepo.rotateSecret(trx, integration.id, encryptSecret(secret, settings.integrationSecretKey), SECRET_OVERLAP_SECONDS))!;
        await audit(trx, res, orgId, "integration.secret_rotated", "integration", integration.id, { formId: integration.formId });
        return { kind: "ok", body: { integration: integrationBody(rotated), secret } };
      }),
    );
  });

  /** An integration's delivery history, newest first. */
  router.get("/organizations/:orgId/integrations/:integrationId/deliveries", async (req, res) => {
    const query = DeliveryQuerySchema.safeParse(req.query);
    if (!query.success) {
      problems.validation(res, issuesToErrors(query.error));
      return;
    }
    const cursor = query.data.cursor === undefined ? undefined : decodeAuditCursor(query.data.cursor);
    if (query.data.cursor !== undefined && !cursor) {
      problems.validation(res, [{ field: "cursor", code: "INVALID_CURSOR", message: "Cursor is not valid" }]);
      return;
    }
    const { orgId, integrationId } = req.params;
    respond(
      res,
      await onIntegration(res, orgId, integrationId, async (trx, integration): Promise<Outcome<DeliveryListResponse>> => {
        const page = await integrationsRepo.listDeliveries(trx, integration.id, {
          limit: query.data.limit,
          after: cursor ? { createdAt: cursor.occurredAt, id: cursor.id } : undefined,
          status: query.data.status,
        });
        const last = page.deliveries.at(-1);
        return { kind: "ok", body: { items: page.deliveries.map(deliveryBody), ...(page.more && last ? { nextCursor: encodeAuditCursor(last.createdAtKey, last.id) } : {}) } };
      }),
    );
  });

  /** Loads a delivery through its integration's access rules. */
  function onDelivery<T>(res: Response, orgId: string, deliveryId: string, action: (trx: Trx, delivery: Delivery) => Promise<Outcome<T>>) {
    const userId = sessionOf(res).userId;
    if (!UUID_PATTERN.test(deliveryId)) return Promise.resolve(NOT_VISIBLE);
    return inOrganization(orgId, userId, async (trx): Promise<Outcome<T>> => {
      const delivery = await integrationsRepo.getDelivery(trx, deliveryId);
      if (!delivery) return { kind: "not_found" };
      const outcome = await onIntegrationIn(trx, res, delivery.integrationId);
      return outcome ?? action(trx, delivery);
    });
  }

  /** The same checks as onIntegration, inside an existing transaction; undefined when allowed. */
  async function onIntegrationIn(trx: Trx, res: Response, integrationId: string): Promise<Outcome<never> | undefined> {
    const userId = sessionOf(res).userId;
    const membership = (await orgRepo.getMembership(trx, userId))!;
    const integration = await trx.selectFrom("integrations").select("form_id").where("id", "=", integrationId).executeTakeFirst();
    if (!integration || !(await orgRepo.getFormSummary(trx, integration.form_id))) return { kind: "not_found" };
    const grants = (await orgRepo.listUserFormGrants(trx, integration.form_id, userId)).filter(isFormPermission);
    if (!formPermissions(membership, grants).has("forms.read")) return { kind: "not_found" };
    if (!orgPermissions(membership).has("integrations.manage")) return { kind: "forbidden" };
    return undefined;
  }

  /** One delivery and every attempt at it. */
  router.get("/organizations/:orgId/deliveries/:deliveryId", async (req, res) => {
    const { orgId, deliveryId } = req.params;
    respond(
      res,
      await onDelivery(res, orgId, deliveryId, async (trx, delivery): Promise<Outcome<DeliveryDetailResponse>> => {
        const detail = (await integrationsRepo.getDelivery(trx, delivery.id))!;
        return {
          kind: "ok",
          body: {
            delivery: deliveryBody(detail),
            attempts: detail.attemptLog.map((a) => ({ ...a, startedAt: a.startedAt.toISOString() })),
          },
        };
      }),
    );
  });

  /**
   * Sends a failed delivery again, with the same event ID, so a destination
   * that did receive it can recognize the repeat. Audited.
   */
  router.post("/organizations/:orgId/deliveries/:deliveryId/retry", async (req, res) => {
    const { orgId, deliveryId } = req.params;
    respond(
      res,
      await onDelivery(res, orgId, deliveryId, async (trx, delivery): Promise<Outcome<{ delivery: DeliveryBody }>> => {
        if (delivery.status !== "failed") return { kind: "conflict", code: "DELIVERY_NOT_FAILED", title: "Only failed deliveries can be sent again" };
        const job = await jobsRepo.findJob(trx, DELIVER_JOB, delivery.id);
        if (!job || !(await jobsRepo.replayJob(trx, job.id))) return { kind: "conflict", code: "DELIVERY_NOT_FAILED", title: "This delivery is already being retried" };
        const requeued = (await integrationsRepo.requeueDelivery(trx, delivery.id))!;
        await audit(trx, res, orgId, "delivery.retried", "delivery", delivery.id, { integrationId: delivery.integrationId, lastError: delivery.lastError });
        return { kind: "ok", body: { delivery: deliveryBody(requeued) } };
      }),
    );
  });

  // Durable jobs (JOB-01, docs/04 §6) ---------------------------------------

  function jobBody(job: Job): JobBody {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      sourceEventId: job.sourceEventId,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      lastError: job.lastError,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      nextAttemptAt: job.nextAttemptAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  }

  /** The organization's background jobs, newest first (owners and admins: organization.audit.read). */
  router.get("/organizations/:orgId/jobs", async (req, res) => {
    const query = JobQuerySchema.safeParse(req.query);
    if (!query.success) {
      problems.validation(res, issuesToErrors(query.error));
      return;
    }
    const cursor = query.data.cursor === undefined ? undefined : decodeAuditCursor(query.data.cursor);
    if (query.data.cursor !== undefined && !cursor) {
      problems.validation(res, [{ field: "cursor", code: "INVALID_CURSOR", message: "Cursor is not valid" }]);
      return;
    }
    const outcome = await inOrganization(req.params.orgId, sessionOf(res).userId, async (trx, membership): Promise<Outcome<JobListResponse>> => {
      if (!orgPermissions(membership).has("organization.audit.read")) return { kind: "forbidden" };
      const page = await jobsRepo.listJobs(trx, {
        limit: query.data.limit,
        after: cursor ? { createdAt: cursor.occurredAt, id: cursor.id } : undefined,
        status: query.data.status,
        type: query.data.type,
      });
      const last = page.jobs.at(-1);
      return {
        kind: "ok",
        body: { items: page.jobs.map(jobBody), ...(page.more && last ? { nextCursor: encodeAuditCursor(last.createdAtKey, last.id) } : {}) },
      };
    });
    respond(res, outcome);
  });

  /**
   * Requeues a dead job with a few more attempts (integrations.manage). It
   * keeps its dedupe key, so a destination that already took the action
   * recognizes the repeat.
   */
  router.post("/organizations/:orgId/jobs/:jobId/replay", async (req, res) => {
    const { orgId, jobId } = req.params;
    if (!UUID_PATTERN.test(jobId)) {
      problems.notFound(res);
      return;
    }
    const outcome = await inOrganization(orgId, sessionOf(res).userId, async (trx, membership): Promise<Outcome<JobResponse>> => {
      if (!orgPermissions(membership).has("integrations.manage")) return { kind: "forbidden" };
      const current = await jobsRepo.getJob(trx, jobId);
      if (!current) return { kind: "not_found" };
      const job = await jobsRepo.replayJob(trx, jobId);
      if (!job) return { kind: "conflict", code: "JOB_NOT_DEAD", title: "Only dead-lettered jobs can be replayed" };
      await audit(trx, res, orgId, "job.replayed", "job", jobId, { type: job.type, attempts: current.attempt, lastError: current.lastError });
      return { kind: "ok", body: { job: jobBody(job) } };
    });
    respond(res, outcome);
  });

  // Exports (RES-02, docs/04 §7) -------------------------------------------

  /** How long an export download link works (docs/04 §7). */
  const EXPORT_LINK_SECONDS = 15 * 60;

  function exportBody(record: ExportRecord): ExportBody {
    return {
      id: record.id,
      formId: record.formId,
      state: record.state,
      failureCode: record.failureCode as ExportBody["failureCode"],
      raw: record.raw,
      cutoff: record.cutoff.toISOString(),
      rowCount: record.rowCount,
      bytes: record.bytes,
      createdAt: record.createdAt.toISOString(),
      completedAt: record.completedAt?.toISOString() ?? null,
      expiresAt: record.expiresAt?.toISOString() ?? null,
    };
  }

  /** May this caller still have this export? Export permission, response access and every class it holds. */
  function mayHaveExport(record: ExportRecord, permissions: Set<FormPermission>): boolean {
    const readable = readableClasses(permissions);
    return permissions.has("responses.export") && permissions.has("responses.read") && record.readableClasses.every((c) => readable.has(c));
  }

  /**
   * Requests a CSV of the responses matching the filters, received up to now,
   * with only the field classes the caller can read. The worker builds it.
   */
  router.post("/organizations/:orgId/forms/:formId/exports", async (req, res) => {
    const body = ExportCreateBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const q = body.data;
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "responses.export", async (trx, { permissions }): Promise<Outcome<ExportBody>> => {
        if (!permissions.has("responses.read")) return { kind: "forbidden" };
        const readable = readableClasses(permissions);
        const versions = indexVersions(await responsesRepo.formVersions(trx, formId));
        if (q.version && !versions.byId.has(q.version)) {
          return { kind: "invalid", errors: [{ field: "version", code: "UNKNOWN_VERSION", message: "This form has no such version" }] };
        }
        if (q.field) {
          const field = versions.latestField.get(q.field);
          if (!field) return { kind: "invalid", errors: [{ field: "field", code: "UNKNOWN_FIELD", message: "This form has no such question" }] };
          if (!canRead(field, readable)) return { kind: "invalid", errors: [{ field: "field", code: "FIELD_MASKED", message: "You can't filter on a question you can't see" }] };
        }
        const requested = await exportsRepo.createExport(trx, {
          id: randomUUID(),
          tenantId: orgId,
          formId,
          requestedBy: userId,
          filters: {
            versionId: q.version,
            receivedFrom: q.from,
            receivedTo: q.to,
            answer: q.field && q.op ? { fieldId: q.field, op: q.op, value: q.value } : undefined,
          },
          cutoff: await responsesRepo.currentCutoff(trx),
          readableClasses: [...readable] as ReadableClass[],
          raw: q.raw,
        });
        await publishRepo.appendAudit(trx, {
          tenantId: orgId,
          actor: { type: "user", id: userId },
          action: "responses.export_requested",
          resourceType: "form",
          resourceId: formId,
          requestId: requestIdOf(res),
          metadata: { exportId: requested.id, raw: q.raw, classes: [...readable].toSorted() },
        });
        return { kind: "ok", status: 202, body: exportBody(requested), headers: { Location: `/api/v1/organizations/${orgId}/exports/${requested.id}` } };
      }),
    );
  });

  /** The caller's own recent exports of this form. */
  router.get("/organizations/:orgId/forms/:formId/exports", async (req, res) => {
    const { orgId, formId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onForm(res, orgId, formId, "responses.export", async (trx): Promise<Outcome<{ items: ExportBody[] }>> => ({
        kind: "ok",
        body: { items: (await exportsRepo.listOwnExports(trx, formId, userId, 20)).map(exportBody) },
      })),
    );
  });

  /** Loads the caller's own export and their current permissions on its form, rechecked every time. */
  function onOwnExport<T>(res: Response, orgId: string, exportId: string, action: (trx: Trx, record: ExportRecord, permissions: Set<FormPermission>) => Promise<Outcome<T>>) {
    const userId = sessionOf(res).userId;
    if (!UUID_PATTERN.test(exportId)) return Promise.resolve(NOT_VISIBLE);
    return inOrganization(orgId, userId, async (trx, membership): Promise<Outcome<T>> => {
      const record = await exportsRepo.getExport(trx, exportId);
      // Exports are personal to their requester: anyone else sees nothing.
      if (!record || record.requestedBy !== userId) return { kind: "not_found" };
      const form = await orgRepo.getFormSummary(trx, record.formId);
      if (!form) return { kind: "not_found" };
      const grants = (await orgRepo.listUserFormGrants(trx, record.formId, userId)).filter(isFormPermission);
      return action(trx, record, formPermissions(membership, grants));
    });
  }

  router.get("/organizations/:orgId/exports/:exportId", async (req, res) => {
    const { orgId, exportId } = req.params;
    respond(
      res,
      await onOwnExport(res, orgId, exportId, async (_trx, record, permissions): Promise<Outcome<ExportBody>> =>
        mayHaveExport(record, permissions) ? { kind: "ok", body: exportBody(record) } : { kind: "forbidden" },
      ),
    );
  });

  /**
   * A 15-minute link to a finished export. Access is checked now, so losing
   * response access, export permission or any field class in the file
   * blocks the download at once (docs/06 §2).
   */
  router.get("/organizations/:orgId/exports/:exportId/download", async (req, res) => {
    const { orgId, exportId } = req.params;
    const userId = sessionOf(res).userId;
    respond(
      res,
      await onOwnExport(res, orgId, exportId, async (trx, record, permissions): Promise<Outcome<ExportDownloadResponse>> => {
        if (!mayHaveExport(record, permissions)) {
          return { kind: "problem", status: 403, code: "EXPORT_ACCESS_REVOKED", title: "You no longer have access to the responses in this export" };
        }
        if (record.state !== "succeeded" || !record.expiresAt || record.expiresAt <= new Date()) {
          return { kind: "conflict", code: "EXPORT_NOT_READY", title: record.state === "expired" ? "This export has expired" : "This export isn't ready" };
        }
        const form = (await orgRepo.getFormSummary(trx, record.formId))!;
        const stem = form.name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60) || "form";
        const fileName = `${stem}-responses-${record.cutoff.toISOString().slice(0, 10)}${record.raw ? "-raw" : ""}.csv`;
        await publishRepo.appendAudit(trx, {
          tenantId: orgId,
          actor: { type: "user", id: userId },
          action: "responses.export_downloaded",
          resourceType: "form",
          resourceId: record.formId,
          requestId: requestIdOf(res),
          metadata: { exportId: record.id },
        });
        return {
          kind: "ok",
          body: {
            url: await objectStore.presignDownload(record.id, fileName, "text/csv; charset=utf-8", EXPORT_LINK_SECONDS, objectStore.exportsBucket),
            expiresAt: new Date(Date.now() + EXPORT_LINK_SECONDS * 1000).toISOString(),
            fileName,
          },
        };
      }),
    );
  });

  // Files (FIL-01) ----------------------------------------------------------

  /** How long a download link works. */
  const DOWNLOAD_URL_SECONDS = 60;

  /**
   * A short-lived link to a clean file attached to a response (docs/06 §3).
   * Authorization is checked now, on every request: removing someone's
   * response access stops new links at once.
   */
  router.get("/organizations/:orgId/forms/:formId/submissions/:submissionId/files/:uploadId", async (req, res) => {
    const { orgId, formId, submissionId, uploadId } = req.params;
    if (!UUID_PATTERN.test(submissionId) || !UUID_PATTERN.test(uploadId)) {
      problems.notFound(res);
      return;
    }
    respond(
      res,
      await onForm(res, orgId, formId, "responses.read", async (trx, { permissions }): Promise<Outcome<FileDownloadResponse>> => {
        const upload = await uploadsRepo.getClaimedUpload(trx, formId, submissionId, uploadId);
        if (!upload) return { kind: "not_found" };
        // Files follow their field's classification, like every other answer (docs/06 §3).
        const versions = indexVersions(await responsesRepo.formVersions(trx, formId));
        const field = versions.byId.get(upload.formVersionId)?.definition.fields.find((f) => f.id === upload.fieldId);
        if (!field || !canRead(field, readableClasses(permissions))) return { kind: "forbidden" };
        const contentType = upload.detectedType ?? "application/octet-stream";
        return {
          kind: "ok",
          body: {
            url: await objectStore.presignDownload(upload.storageKey, upload.fileName, contentType, DOWNLOAD_URL_SECONDS),
            expiresAt: new Date(Date.now() + DOWNLOAD_URL_SECONDS * 1000).toISOString(),
            fileName: upload.fileName,
            contentType,
            bytes: upload.bytes ?? 0,
          },
        };
      }),
    );
  });

  async function currentGrants(trx: Trx, formId: string): Promise<FormGrantsResponse["grants"]> {
    return (await orgRepo.listFormGrants(trx, formId)).flatMap((g) =>
      isFormPermission(g.permission) ? [{ principalType: g.principalType, principalId: g.principalId, permission: g.permission }] : [],
    );
  }

  router.get("/organizations/:orgId/forms/:formId/grants", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.manage_access", async (trx) => ({
        kind: "ok",
        body: { grants: await currentGrants(trx, formId) } satisfies FormGrantsResponse,
      })),
    );
  });

  router.put("/organizations/:orgId/forms/:formId/grants", async (req, res) => {
    const body = FormGrantsBodySchema.safeParse(req.body);
    if (!body.success) {
      problems.validation(res, issuesToErrors(body.error));
      return;
    }
    const unique = [
      ...new Map(body.data.grants.map((g) => [`${g.principalType}:${g.principalId}:${g.permission}`, g])).values(),
    ];
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.manage_access", async (trx): Promise<Outcome<FormGrantsResponse>> => {
        const members = await orgRepo.activeMemberIds(trx, [...new Set(unique.map((g) => g.principalId))]);
        const errors: FieldError[] = [];
        body.data.grants.forEach((g, index) => {
          if (!members.has(g.principalId)) {
            errors.push({
              field: `grants.${index}.principalId`,
              code: "NOT_A_MEMBER",
              message: "Grants can only be given to active members of this organization",
            });
          }
        });
        if (errors.length > 0) return { kind: "invalid", errors };
        const before = await currentGrants(trx, formId);
        await orgRepo.replaceFormGrants(trx, formId, orgId, unique, sessionOf(res).userId);
        const key = (g: { principalId: string; permission: string }) => `${g.principalId}:${g.permission}`;
        const beforeKeys = new Set(before.map(key));
        const afterKeys = new Set(unique.map(key));
        const added = unique.filter((g) => !beforeKeys.has(key(g))).map((g) => ({ principalId: g.principalId, permission: g.permission }));
        const removed = before.filter((g) => !afterKeys.has(key(g))).map((g) => ({ principalId: g.principalId, permission: g.permission }));
        if (added.length > 0 || removed.length > 0) await audit(trx, res, orgId, "form.grants_changed", "form", formId, { added, removed });
        return { kind: "ok", body: { grants: await currentGrants(trx, formId) } };
      }),
    );
  });

  return router;
}
