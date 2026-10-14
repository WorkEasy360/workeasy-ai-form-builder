import { Router, type Response } from "express";
import type { Transaction } from "kysely";
import { formPermissions, isFormPermission, orgPermissions, readsAllForms } from "@workeasy/auth";
import {
  identityRepo,
  orgRepo,
  withContext,
  type Database,
  type FormListCursor,
  type MembershipRecord,
  type ResolvedSession,
} from "@workeasy/database";
import type { z } from "zod";
import type { AppDependencies } from "../app.js";
import {
  FormGrantsBodySchema,
  FormListQuerySchema,
  type FormGrantsResponse,
  type FormListResponse,
  type MeResponse,
} from "../contract/schemas.js";
import { parseCookies } from "../http/cookies.js";
import { problems, type FieldError } from "../http/problem.js";
import { requireSameOrigin } from "../http/same-origin.js";
import { sessionCookieName } from "./auth.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

type Trx = Transaction<Database>;
const NOT_VISIBLE = Symbol("not-visible");

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
    const page = await inOrganization(req.params.orgId, userId, (trx, membership) =>
      orgRepo.listForms(trx, {
        limit,
        ...(readsAllForms(membership) ? {} : { onlyGrantedTo: userId }),
        ...(cursor ? { cursor } : {}),
        ...(state ? { state } : {}),
        ...(q ? { search: q } : {}),
      }),
    );
    if (page === NOT_VISIBLE) {
      problems.notFound(res);
      return;
    }
    const body: FormListResponse = {
      items: page.items.map((f) => ({
        id: f.id,
        slug: f.slug,
        name: f.name,
        state: f.state,
        ownerId: f.ownerId,
        createdAt: f.createdAt.toISOString(),
        updatedAt: f.updatedAt.toISOString(),
      })),
      ...(page.nextCursor ? { nextCursor: encodeCursor(page.nextCursor) } : {}),
    };
    res.json(body);
  });

  type GrantOutcome =
    | { kind: "ok"; grants: FormGrantsResponse["grants"] }
    | { kind: "not_found" }
    | { kind: "forbidden" }
    | { kind: "invalid"; errors: FieldError[] };

  /** Checks the caller may manage access on the form, then runs `action`. */
  async function withFormAccess(
    res: Response,
    orgId: string,
    formId: string,
    action: (trx: Trx) => Promise<GrantOutcome>,
  ): Promise<void> {
    const userId = sessionOf(res).userId;
    const outcome = UUID_PATTERN.test(formId)
      ? await inOrganization(orgId, userId, async (trx, membership): Promise<GrantOutcome> => {
          if (!(await orgRepo.formExists(trx, formId))) return { kind: "not_found" };
          const own = (await orgRepo.listUserFormGrants(trx, formId, userId)).filter(isFormPermission);
          const permissions = formPermissions(membership, own);
          if (!permissions.has("forms.read")) return { kind: "not_found" };
          if (!permissions.has("forms.manage_access")) return { kind: "forbidden" };
          return action(trx);
        })
      : NOT_VISIBLE;

    if (outcome === NOT_VISIBLE || outcome.kind === "not_found") problems.notFound(res);
    else if (outcome.kind === "forbidden") problems.forbidden(res);
    else if (outcome.kind === "invalid") problems.validation(res, outcome.errors);
    else res.json({ grants: outcome.grants } satisfies FormGrantsResponse);
  }

  async function currentGrants(trx: Trx, formId: string): Promise<FormGrantsResponse["grants"]> {
    return (await orgRepo.listFormGrants(trx, formId)).flatMap((g) =>
      isFormPermission(g.permission) ? [{ principalType: g.principalType, principalId: g.principalId, permission: g.permission }] : [],
    );
  }

  router.get("/organizations/:orgId/forms/:formId/grants", async (req, res) => {
    const { orgId, formId } = req.params;
    await withFormAccess(res, orgId, formId, async (trx) => ({ kind: "ok", grants: await currentGrants(trx, formId) }));
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
    await withFormAccess(res, orgId, formId, async (trx) => {
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
      return { kind: "ok", grants: await currentGrants(trx, formId) };
    });
  });

  return router;
}
