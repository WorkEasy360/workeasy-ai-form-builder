import { createHash, randomUUID } from "node:crypto";
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
  publishRepo,
  withContext,
  type Database,
  type FormListCursor,
  type FormSummary,
  type MembershipRecord,
  type ResolvedSession,
  type VersionSummary,
} from "@workeasy/database";
import { FORM_PUBLISHED_V1, formPublishedV1 } from "@workeasy/events";
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
import type { z } from "zod";
import type { AppDependencies } from "../app.js";
import {
  AccessPolicyBodySchema,
  ActivateVersionBodySchema,
  CloseFormBodySchema,
  CreateFormBodySchema,
  IDEMPOTENCY_KEY_PATTERN,
  DuplicateFormBodySchema,
  FormGrantsBodySchema,
  FormListQuerySchema,
  type FormGrantsResponse,
  type FormListResponse,
  type AccessPolicyResponse,
  type DraftResponse,
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

export function apiV1Router({ db, settings }: AppDependencies): Router {
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
    res.json({ templates: FORM_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })) });
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
      return { page, membership, grants };
    });
    if (result === NOT_VISIBLE) {
      problems.notFound(res);
      return;
    }
    const { page, membership, grants } = result;
    const body: FormListResponse = {
      items: page.items.map((f) => summaryBody(f, formPermissions(membership, (grants.get(f.id) ?? []).filter(isFormPermission)))),
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
        body: { mode: await orgRepo.getAccessMode(trx, formId) },
      })),
    );
  });

  /**
   * Who may respond: anyone with the link, or only signed-in active members of
   * this organization. Takes effect immediately, including for sessions
   * already started (their acceptance check reads the current policy).
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
        const previous = await orgRepo.getAccessMode(trx, formId);
        if (previous !== body.data.mode) {
          await orgRepo.setAccessMode(trx, orgId, formId, body.data.mode, userId);
          await publishRepo.appendAudit(trx, {
            tenantId: orgId,
            actor: { type: "user", id: userId },
            action: "form.access_policy_changed",
            resourceType: "form",
            resourceId: formId,
            requestId: requestIdOf(res),
            metadata: { mode: body.data.mode, previousMode: previous },
          });
        }
        return { kind: "ok", body: { mode: body.data.mode } };
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
        await orgRepo.replaceFormGrants(trx, formId, orgId, unique, sessionOf(res).userId);
        return { kind: "ok", body: { grants: await currentGrants(trx, formId) } };
      }),
    );
  });

  return router;
}
