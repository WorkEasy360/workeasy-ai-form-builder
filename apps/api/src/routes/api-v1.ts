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
  withContext,
  type Database,
  type FormListCursor,
  type FormSummary,
  type MembershipRecord,
  type ResolvedSession,
} from "@workeasy/database";
import { blankDefinition, definitionFromTemplate, FORM_TEMPLATES, validateDraft } from "@workeasy/form-engine";
import type { z } from "zod";
import type { AppDependencies } from "../app.js";
import {
  CreateFormBodySchema,
  DuplicateFormBodySchema,
  FormGrantsBodySchema,
  FormListQuerySchema,
  type FormGrantsResponse,
  type FormListResponse,
  type DraftResponse,
  type FormResponse,
  type FormSummaryBody,
  type MeResponse,
  type SaveDraftResponse,
} from "../contract/schemas.js";
import { parseCookies } from "../http/cookies.js";
import { problems, sendProblem, type FieldError, type ProblemExtensions } from "../http/problem.js";
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

  // Restored forms return to draft. Once publishing exists (PUB-01), a form
  // with a published version will restore to closed instead.
  router.post("/organizations/:orgId/forms/:formId/restore", async (req, res) => {
    const { orgId, formId } = req.params;
    respond(
      res,
      await onForm(res, orgId, formId, "forms.publish", async (trx, { permissions }): Promise<Outcome<FormResponse>> => {
        const form = await orgRepo.transitionFormState(trx, formId, ["archived"], "draft");
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
          body: { revision: draft.revision, definition: draft.definition, issues: checked.issues },
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
