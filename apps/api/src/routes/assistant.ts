import { randomUUID } from "node:crypto";
import type { Response, Router } from "express";
import type { Transaction } from "kysely";
import {
  ASSISTANT_ACTIONS,
  ASSISTANT_TOOLS,
  assistantCapabilities,
  assistantSystem,
  runAssistantTurn,
  type AssistantMessage,
  type FormTab,
  type Navigation,
  type ProposedAction,
} from "@workeasy/ai";
import { formPermissions, isFormPermission, orgPermissions, readsAllForms, type FormPermission } from "@workeasy/auth";
import {
  aiRepo,
  analyticsRepo,
  governanceRepo,
  identityRepo,
  integrationsRepo,
  jobsRepo,
  membersRepo,
  orgRepo,
  publishRepo,
  type Database,
  type MembershipRecord,
  type ResolvedSession,
} from "@workeasy/database";
import { FORM_TEMPLATES, validateDefinition } from "@workeasy/form-engine";
import type { AppDependencies } from "../app.js";
import { ANALYTICS_DEFINITIONS, AssistantAskBodySchema, CloseFormBodySchema, CreateFormBodySchema, DuplicateFormBodySchema } from "../contract/schemas.js";
import { problems, sendProblem } from "../http/problem.js";

/**
 * The console assistant (packages/ai/src/assistant.ts, docs/09). One POST is
 * one question: the API checks the member and the day's allowance, runs the
 * model, and runs each tool the model asks for in its own short transaction
 * scoped to this organization and re-checked
 * against the member's role and form access. Tools return form metadata and
 * counts, never respondents' answers. Nothing is changed here: a proposed
 * action is verified and returned for the member to confirm, and the console
 * then calls the existing, audited endpoint.
 */

type Trx = Transaction<Database>;
type Membership = MembershipRecord;

/** The access the API router grants this module: a transaction in one organization as one member, or undefined when they aren't an active member. */
export interface OrganizationAccess {
  inOrganization<T>(orgId: string, userId: string, fn: (trx: Trx, membership: Membership) => Promise<T>): Promise<{ value: T } | undefined>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const HISTORY_SENT = 12;

const clamp = (v: unknown, min: number, max: number, fallback: number) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v as number)) : fallback);
const text = (v: unknown, max = 100) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const today = () => new Date().toISOString().slice(0, 10);

type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

interface ToolContext {
  orgId: string;
  userId: string;
  organizationName: string;
  membership: Membership;
  orgPerms: ReadonlySet<string>;
  respondentOrigin: string;
  assistantLimit: number;
}

/** A form the member may read, with what they may do on it; undefined when it doesn't exist for them. */
async function readableForm(trx: Trx, ctx: Pick<ToolContext, "userId" | "membership">, id: unknown) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return undefined;
  const form = await orgRepo.getFormSummary(trx, id);
  if (!form) return undefined;
  const grants = (await orgRepo.listUserFormGrants(trx, id, ctx.userId)).filter(isFormPermission);
  const perms = formPermissions(ctx.membership, grants);
  return perms.has("forms.read") ? { form, perms } : undefined;
}

const NO_FORM = "No form with that id that this member can see. Use search_forms to find it.";

function abilities(perms: Set<FormPermission>) {
  return { edit: perms.has("forms.edit"), publish: perms.has("forms.publish"), readResponses: perms.has("responses.read"), analytics: perms.has("analytics.read") };
}

/** The read-only tools. Each runs inside the member's organization transaction; the caller has checked the organization permission. */
const TOOLS: Record<string, (trx: Trx, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>> = {
  async organization_overview(trx, _args, ctx) {
    const [forms, ai, usage, asked] = await Promise.all([
      orgRepo.formStateCounts(trx, readsAllForms(ctx.membership) ? undefined : ctx.userId),
      aiRepo.getSettings(trx),
      aiRepo.usageToday(trx),
      aiRepo.assistantUsedToday(trx),
    ]);
    const members = ctx.orgPerms.has("members.manage") ? (await membersRepo.listMembers(trx)).filter((m) => m.status === "active").length : undefined;
    return {
      ok: true,
      result: {
        organization: ctx.organizationName,
        yourRole: ctx.membership.role,
        todayUtc: today(),
        formsYouCanSee: forms,
        ...(members === undefined ? {} : { activeMembers: members }),
        ai: { dailyTokenLimit: ai.dailyTokenLimit, tokensUsedToday: usage.used + usage.reserved, assistantQuestionsToday: asked, assistantDailyLimit: ctx.assistantLimit },
      },
    };
  },
  async search_forms(trx, args, ctx) {
    const state = ["draft", "published", "closed", "archived"].includes(args.state as string) ? (args.state as "draft") : undefined;
    const q = text(args.query, 200);
    const page = await orgRepo.listForms(trx, {
      limit: clamp(args.limit, 1, 10, 10),
      ...(readsAllForms(ctx.membership) ? {} : { onlyGrantedTo: ctx.userId }),
      ...(state ? { state } : {}),
      ...(q ? { search: q } : {}),
    });
    const grants = await orgRepo.userGrantsForForms(trx, page.items.map((f) => f.id), ctx.userId);
    const permsOf = (id: string) => formPermissions(ctx.membership, (grants.get(id) ?? []).filter(isFormPermission));
    // Response figures only for forms whose responses the member may read, as on the Forms page.
    const readable = page.items.filter((f) => permsOf(f.id).has("responses.read")).map((f) => f.id);
    const stats = await orgRepo.responseStats(trx, readable);
    return {
      ok: true,
      result: {
        items: page.items.map((f) => ({
          id: f.id,
          name: f.name,
          state: f.state,
          live: f.activeVersionId !== null,
          responses: readable.includes(f.id) ? (stats.get(f.id)?.count ?? 0) : "not visible to this member",
          lastResponseAt: readable.includes(f.id) ? iso(stats.get(f.id)?.lastAt) : null,
          updatedAt: iso(f.updatedAt),
          youCan: abilities(permsOf(f.id)),
        })),
        ...(page.nextCursor ? { more: true } : {}),
      },
    };
  },
  async get_form(trx, args, ctx) {
    const found = await readableForm(trx, ctx, args.id);
    if (!found) return { ok: false, error: NO_FORM };
    const { form, perms } = found;
    const [draft, versions, policy] = await Promise.all([orgRepo.getDraft(trx, form.id), publishRepo.listVersions(trx, form.id, 1), orgRepo.getAccessPolicy(trx, form.id)]);
    const definition = (draft?.definition ?? {}) as { title?: string; pages?: Array<{ title?: string; fieldIds?: string[] }>; fields?: Array<{ id: string; type: string; label?: string; required?: boolean }> };
    const fields = definition.fields ?? [];
    const responses = perms.has("responses.read") ? await orgRepo.countResponses(trx, form.id) : undefined;
    const live = versions[0];
    return {
      ok: true,
      result: {
        id: form.id,
        name: form.name,
        state: form.state,
        titleShownToRespondents: definition.title ?? form.name,
        liveVersion: live ? { number: live.versionNumber, publishedAt: iso(live.publishedAt) } : null,
        publicLink: form.activeVersionId ? `${ctx.respondentOrigin}/f/${form.slug}` : null,
        draft: {
          pages: (definition.pages ?? []).map((p, i) => ({ title: p.title || `Page ${i + 1}`, questions: p.fieldIds?.length ?? 0 })),
          // Labels and types only: the questions, never anyone's answers.
          questions: fields.slice(0, 60).map((f) => ({ label: f.label ?? "", type: f.type, required: f.required === true })),
          ...(fields.length > 60 ? { moreQuestions: fields.length - 60 } : {}),
        },
        whoCanRespond: policy?.mode === "organization" ? "only members of this organization" : "anyone with the link",
        responseLimit: policy?.maxResponses ?? null,
        opensAt: iso(policy?.openAt),
        closesAt: iso(policy?.closeAt),
        ...(responses === undefined ? { responses: "not visible to this member" } : { responses }),
        youCan: abilities(perms),
      },
    };
  },
  async form_analytics(trx, args, ctx) {
    const found = await readableForm(trx, ctx, args.id);
    if (!found) return { ok: false, error: NO_FORM };
    if (!found.perms.has("analytics.read")) return { ok: false, error: "This member's role can't see this form's analytics" };
    const days = [7, 30, 90].includes(args.days as number) ? (args.days as number) : 30;
    const to = today();
    const from = new Date(Date.parse(to) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    const rows = await analyticsRepo.formDays(trx, found.form.id, from, to);
    const sum = (k: "views" | "starts" | "accepts") => rows.reduce((n, d) => n + d[k], 0);
    const [views, starts, accepts] = [sum("views"), sum("starts"), sum("accepts")];
    const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
    return {
      ok: true,
      result: { form: found.form.name, fromUtc: from, toUtc: to, views, starts, accepted: accepts, startRatePercent: rate(starts, views), completionRatePercent: rate(accepts, starts), definitions: ANALYTICS_DEFINITIONS },
    };
  },
  async form_integrations(trx, args, ctx) {
    const found = await readableForm(trx, ctx, args.id);
    if (!found) return { ok: false, error: NO_FORM };
    const items = await integrationsRepo.listIntegrations(trx, found.form.id);
    // Kind, name and state only: URLs, recipients and secrets never leave the server.
    return { ok: true, result: { form: found.form.name, items: items.map((i) => ({ kind: i.kind, name: i.name, enabled: i.enabled })) } };
  },
  async failed_jobs(trx, args) {
    const { jobs } = await jobsRepo.listJobs(trx, { status: "dead", limit: clamp(args.limit, 1, 20, 10) });
    return {
      ok: true,
      result: { items: jobs.map((j) => ({ id: j.id, type: j.type, attempts: j.attempt, maxAttempts: j.maxAttempts, error: j.lastError?.slice(0, 120) ?? null, failedAt: iso(j.finishedAt ?? j.updatedAt) })) },
    };
  },
  async list_members(trx) {
    const [members, invitations] = await Promise.all([membersRepo.listMembers(trx), membersRepo.listInvitations(trx)]);
    return {
      ok: true,
      result: {
        items: members.slice(0, 50).map((m) => ({ name: m.displayName ?? "Unnamed member", role: m.role, status: m.status === "active" ? "active" : "removed", joinedAt: iso(m.joinedAt) })),
        pendingInvitations: invitations.filter((i) => i.status === "pending").length,
      },
    };
  },
  async recent_activity(trx, args) {
    const resourceId = typeof args.formId === "string" && UUID_PATTERN.test(args.formId) ? args.formId : undefined;
    const { entries } = await governanceRepo.listAudit(trx, { limit: clamp(args.limit, 1, 20, 10), ...(resourceId ? { resourceId } : {}) });
    const formIds = [...new Set(entries.filter((e) => e.resourceType === "form").map((e) => e.resourceId))];
    const names = new Map((await Promise.all(formIds.map((id) => orgRepo.getFormSummary(trx, id)))).filter((f) => f !== undefined).map((f) => [f.id, f.name]));
    return {
      ok: true,
      // Metadata stays out: it can hold reasons written by members.
      result: { items: entries.map((e) => ({ action: e.action, on: e.resourceType === "form" ? (names.get(e.resourceId) ?? "a deleted form") : e.resourceType, by: e.actor.type === "system" ? "Workeasy" : (e.actor.displayName ?? "a member"), at: iso(e.occurredAt) })) },
    };
  },
};

export interface Proposal {
  kind: ProposedAction["kind"];
  title: string;
  /** Checked facts for the member to review, label then value. */
  summary: Array<[string, string]>;
  /** What confirming does, in a sentence. */
  effect: string;
  confirmLabel: string;
  danger: boolean;
  /** The existing endpoint the console calls on confirmation, with any headers it needs (publishing pins the draft revision). */
  request: { method: "POST" | "PUT"; path: string; body: Record<string, unknown>; headers?: Record<string, string> };
  /** Where to send the member once it's done (shown as "Open <label>"); `:id` is filled from the response's form. */
  done?: { label: string; path: string; idFrom?: "form" };
}

type Checked = { ok: true; proposal: Proposal } | { ok: false; reason: string };

/** The first validation message, as the form's own page would show it. */
const firstProblem = (issues: ReadonlyArray<{ message: string }>) => `That doesn't pass the checks: ${issues[0]?.message ?? "something is missing"}.`;
const STATE_NAMES = { draft: "Draft", published: "Published, accepting responses", closed: "Closed", archived: "Archived" } as const;

/** Checks a proposed action against the organization as it is now; refuses what the endpoint would refuse. */
async function verifyAction(trx: Trx, ctx: ToolContext, action: ProposedAction): Promise<Checked> {
  const api = `/api/v1/organizations/${ctx.orgId}`;
  if (action.kind === "create_form") {
    const body = { name: action.name, ...(action.template ? { template: action.template } : {}) };
    const checked = CreateFormBodySchema.safeParse(body);
    if (!checked.success) return { ok: false, reason: firstProblem(checked.error.issues) };
    const template = FORM_TEMPLATES.find((t) => t.id === action.template);
    return {
      ok: true,
      proposal: {
        kind: action.kind,
        title: `Create form: ${checked.data.name}`,
        summary: [
          ["Name", checked.data.name],
          ["Starts from", template ? `The ${template.name} template` : "A blank form"],
        ],
        effect: "Creates a new draft form and opens it in the builder. Nobody can respond until you publish it.",
        confirmLabel: "Create form",
        danger: false,
        request: { method: "POST", path: `${api}/forms`, body },
        done: { label: checked.data.name, path: "/forms/:id/build", idFrom: "form" },
      },
    };
  }
  if (action.kind === "retry_job") {
    const job = await jobsRepo.getJob(trx, action.jobId);
    if (!job) return { ok: false, reason: "I couldn't find that job in this organization. Check Background jobs." };
    if (job.status !== "dead") return { ok: false, reason: `That job isn't waiting for a retry (it's ${job.status}).` };
    return {
      ok: true,
      proposal: {
        kind: action.kind,
        title: `Retry ${job.type}`,
        summary: [
          ["Job", job.type],
          ["Attempts so far", `${job.attempt} of ${job.maxAttempts}`],
          ["Last error", job.lastError?.slice(0, 120) ?? "none recorded"],
        ],
        effect: "Queues it again with a few more attempts. If the cause hasn't been fixed, it will stop again.",
        confirmLabel: "Retry job",
        danger: false,
        request: { method: "POST", path: `${api}/jobs/${job.id}/replay`, body: {} },
        done: { label: "Background jobs", path: "/jobs" },
      },
    };
  }
  const found = await readableForm(trx, ctx, action.formId);
  if (!found) return { ok: false, reason: "I couldn't find that form among the ones you can see. Search for it first." };
  const { form, perms } = found;
  const path = `${api}/forms/${form.id}`;
  const summary: Array<[string, string]> = [
    ["Form", form.name],
    ["State", STATE_NAMES[form.state]],
  ];
  if (action.kind === "duplicate_form") {
    if (!perms.has("forms.edit") || !ctx.orgPerms.has("forms.create")) return { ok: false, reason: "Your role can't copy this form. Ask an organization owner or admin." };
    const checked = DuplicateFormBodySchema.safeParse({ name: action.name });
    if (!checked.success) return { ok: false, reason: firstProblem(checked.error.issues) };
    return {
      ok: true,
      proposal: {
        kind: action.kind,
        title: `Copy ${form.name}`,
        summary: [...summary, ["New name", checked.data.name]],
        effect: "Creates a separate draft from this form's current draft. Responses, versions, access and integrations aren't copied.",
        confirmLabel: "Copy form",
        danger: false,
        request: { method: "POST", path: `${path}/duplicate`, body: checked.data },
        done: { label: checked.data.name, path: "/forms/:id/build", idFrom: "form" },
      },
    };
  }
  if (!perms.has("forms.publish")) return { ok: false, reason: `Your role can't publish, close or archive ${form.name}. Ask its owner or an organization admin.` };
  if (action.kind === "publish_form") {
    if (form.state === "archived") return { ok: false, reason: `${form.name} is archived. Restore it before publishing.` };
    const draft = await orgRepo.getDraft(trx, form.id);
    if (!draft) return { ok: false, reason: `${form.name} has no draft to publish.` };
    // The same check the builder's Publish runs, so a card is offered only for a draft that will publish.
    const checked = validateDefinition(draft.definition);
    if (!checked.ok) {
      const reasons = checked.issues.slice(0, 3).map((i) => (/[.!?]$/.test(i.message) ? i.message : `${i.message}.`)).join(" ");
      return { ok: false, reason: `${form.name} can't be published yet: ${reasons} Fix this in the builder, then ask again.` };
    }
    const [latest, policy] = await Promise.all([publishRepo.listVersions(trx, form.id, 1), orgRepo.getAccessPolicy(trx, form.id)]);
    const questions = checked.definition.fields.length;
    const next = (latest[0]?.versionNumber ?? 0) + 1;
    return {
      ok: true,
      proposal: {
        kind: action.kind,
        title: `Publish ${form.name}`,
        summary: [
          ...summary,
          ["Publishes", `Version ${next}: ${questions} question${questions === 1 ? "" : "s"} on ${checked.definition.pages.length} page${checked.definition.pages.length === 1 ? "" : "s"}`],
          ["Who can respond", policy.mode === "organization" ? "Only members of this organization" : "Anyone with the link"],
        ],
        effect:
          form.state === "closed"
            ? "Makes this draft the live version. The form stays closed until you reopen it."
            : form.state === "published"
              ? "Replaces the live version: new respondents get this draft. Responses already given keep the version they answered."
              : "Puts the form live: anyone it's shared with can respond. Share gives you the link.",
        confirmLabel: "Publish",
        danger: false,
        // If-Match pins the exact draft checked here: if anyone edits it first, publishing is refused rather than sending something unreviewed.
        request: { method: "POST", path: `${path}/publish`, body: {}, headers: { "If-Match": `"draft-${draft.revision}"`, "Idempotency-Key": `assistant-${randomUUID()}` } },
        done: { label: `Share ${form.name}`, path: `/forms/${form.id}/build` },
      },
    };
  }
  if (action.kind === "archive_form") {
    if (form.state === "archived") return { ok: false, reason: `${form.name} is already archived.` };
    return {
      ok: true,
      proposal: {
        kind: action.kind,
        title: `Archive ${form.name}`,
        summary,
        effect: "Removes it from the Forms list and stops new responses. Its responses are kept, and you can restore it from Forms → Archived.",
        confirmLabel: "Archive form",
        danger: true,
        request: { method: "POST", path: `${path}/archive`, body: {} },
        done: { label: "Forms", path: "/forms" },
      },
    };
  }
  if (action.kind === "restore_form") {
    if (form.state !== "archived") return { ok: false, reason: `${form.name} isn't archived, so there's nothing to restore.` };
    return {
      ok: true,
      proposal: {
        kind: action.kind,
        title: `Restore ${form.name}`,
        summary,
        effect: form.activeVersionId ? "Brings it back to the Forms list as closed. Reopen it when it should take responses again." : "Brings it back to the Forms list as a draft.",
        confirmLabel: "Restore form",
        danger: false,
        request: { method: "POST", path: `${path}/restore`, body: {} },
        done: { label: form.name, path: `/forms/${form.id}/build` },
      },
    };
  }
  if (action.kind === "close_form") {
    if (form.state !== "published") return { ok: false, reason: `${form.name} isn't accepting responses, so there's nothing to close (it's ${form.state}).` };
    const body = action.reason ? { reason: action.reason } : {};
    const checked = CloseFormBodySchema.safeParse(body);
    if (!checked.success) return { ok: false, reason: firstProblem(checked.error.issues) };
    return {
      ok: true,
      proposal: {
        kind: action.kind,
        title: `Close ${form.name}`,
        summary: [...summary, ...(action.reason ? ([["Reason (audit log)", action.reason]] as Array<[string, string]>) : [])],
        effect: "Stops new responses at once, even from people who have the form open. You can reopen it under Settings → Access.",
        confirmLabel: "Close form",
        danger: true,
        request: { method: "POST", path: `${path}/close`, body },
        done: { label: `${form.name} settings`, path: `/forms/${form.id}/settings` },
      },
    };
  }
  if (form.state !== "closed") return { ok: false, reason: `Only a closed form can be reopened, and ${form.name} is ${form.state}.` };
  return {
    ok: true,
    proposal: {
      kind: action.kind,
      title: `Reopen ${form.name}`,
      summary,
      effect: "Accepts responses again with the live version, through the same link.",
      confirmLabel: "Reopen form",
      danger: false,
      request: { method: "POST", path: `${path}/reopen`, body: {} },
      done: { label: `${form.name} settings`, path: `/forms/${form.id}/settings` },
    },
  };
}

const TAB_LABELS: Record<FormTab, string> = { build: "builder", responses: "responses", analytics: "analytics", integrations: "integrations", settings: "settings" };

/** Resolves a navigation request to a console link the member can open, or nothing. */
async function resolveLink(trx: Trx, ctx: ToolContext, nav: Navigation): Promise<{ label: string; href: string } | null> {
  const base = `/o/${ctx.orgId}`;
  if ("page" in nav) {
    const page = assistantCapabilities(ctx.orgPerms).pages.find((p) => p.key === nav.page);
    return page ? { label: page.label, href: `${base}${page.path}` } : null;
  }
  const found = await readableForm(trx, ctx, nav.form);
  if (!found) return null;
  const needs = { build: true, settings: true, responses: found.perms.has("responses.read"), analytics: found.perms.has("analytics.read"), integrations: ctx.orgPerms.has("integrations.manage") }[nav.tab];
  return needs ? { label: `${found.form.name} ${TAB_LABELS[nav.tab]}`, href: `${base}/forms/${found.form.id}/${nav.tab}` } : null;
}

const sessionOf = (res: Response) => res.locals.session as ResolvedSession;

export function assistantRoutes(router: Router, deps: AppDependencies, access: OrganizationAccess): void {
  const limit = deps.settings.assistantDailyLimit ?? 200;
  const provider = deps.assistant;

  /** Runs `fn` as the member, with their current role; undefined when they're no longer an active member. */
  const asMember = async <T>(orgId: string, userId: string, fn: (trx: Trx, membership: Membership) => Promise<T>): Promise<T | undefined> =>
    (await access.inOrganization(orgId, userId, fn))?.value;

  router.get("/organizations/:orgId/assistant", async (req, res) => {
    const found = await access.inOrganization(req.params.orgId, sessionOf(res).userId, (trx) => aiRepo.assistantUsedToday(trx));
    if (!found) return problems.notFound(res);
    // AI is always on for organizations; it's off only when this server has no provider.
    res.json({ enabled: Boolean(provider), ...(provider ? {} : { disabledBy: "server" }), usedToday: found.value, dailyLimit: limit });
  });

  router.post("/organizations/:orgId/assistant", async (req, res) => {
    const body = AssistantAskBodySchema.safeParse(req.body ?? {});
    if (!body.success) return problems.validation(res, body.error.issues.map((i) => ({ field: i.path.join(".") || "body", code: "INVALID", message: i.message })));
    if (!provider) return sendProblem(res, 503, "AI_DISABLED", "The assistant isn't set up on this server");
    const { orgId } = req.params;
    const userId = sessionOf(res).userId;

    // 1. The member, and one question from today's allowance.
    const start = await access.inOrganization(orgId, userId, async (trx, membership) => {
      const settings = await aiRepo.getSettings(trx);
      const taken = await aiRepo.takeAssistantMessage(trx, orgId, limit, settings.dailyTokenLimit);
      return taken.kind === "ok" ? { kind: "ok" as const, membership, used: taken.used } : taken;
    });
    if (!start) return problems.notFound(res);
    const outcome = start.value;
    if (outcome.kind === "limit") return sendProblem(res, 409, "ASSISTANT_DAILY_LIMIT", `This organization has used today's ${outcome.limit} assistant questions. More are available tomorrow (UTC)`);
    if (outcome.kind === "tokens") return sendProblem(res, 409, "AI_BUDGET_EXCEEDED", "This organization has used today's AI token limit. More is available tomorrow (UTC), or an owner can raise the limit in AI settings");
    const profile = await identityRepo.getUserProfile(deps.db, userId);
    const organizationName = profile?.memberships.find((m) => m.tenantId === orgId)?.tenantName ?? "This organization";
    const ctx: ToolContext = {
      orgId,
      userId,
      organizationName,
      membership: outcome.membership,
      orgPerms: orgPermissions(outcome.membership),
      respondentOrigin: deps.settings.respondentOrigin,
      assistantLimit: limit,
    };

    // 2. The model, with tools that run as the member, inside this organization only.
    const history: AssistantMessage[] = body.data.history.slice(-HISTORY_SENT);
    while (history[0]?.role === "assistant") history.shift();
    const system = assistantSystem({ organizationName, role: ctx.membership.role, memberName: profile?.displayName ?? "Team member", today: today(), permissions: ctx.orgPerms });
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const turn = await runAssistantTurn(
      provider,
      { system, history, question: body.data.question },
      async (tool, args) => {
        const spec = ASSISTANT_TOOLS.find((t) => t.name === tool);
        const run = TOOLS[tool];
        if (!spec || !run) return { ok: false, error: `There's no tool called ${tool}` };
        const result = await asMember(orgId, userId, (trx, membership) => {
          // Checked again per call: a role can change while a question runs.
          const current = orgPermissions(membership);
          if (spec.permission && !spec.permission.some((p) => current.has(p as never))) return Promise.resolve<ToolResult>({ ok: false, error: "This member's role doesn't allow that" });
          return run(trx, args, { ...ctx, membership, orgPerms: current });
        });
        return result ?? { ok: false, error: "This member no longer has access to the organization" };
      },
      abort.signal,
    );

    // 3. Links and proposals are resolved against the organization as it is now.
    const finished = await asMember(orgId, userId, async (trx, membership) => {
      await aiRepo.addAssistantTokens(trx, turn.usage.inputTokens + turn.usage.outputTokens);
      if (!turn.ok) return undefined;
      const now: ToolContext = { ...ctx, membership, orgPerms: orgPermissions(membership) };
      const link = turn.answer.navigate ? await resolveLink(trx, now, turn.answer.navigate) : null;
      let proposal: Proposal | null = null;
      let note: string | null = null;
      const action = turn.answer.action;
      if (action) {
        const needs = ASSISTANT_ACTIONS.find((a) => a.kind === action.kind)?.permission;
        if (needs && !needs.some((p) => now.orgPerms.has(p))) note = "Your role can't make this change. Ask an organization owner or admin.";
        else {
          const checked = await verifyAction(trx, now, action);
          if (checked.ok) proposal = checked.proposal;
          else note = checked.reason;
        }
      }
      return { text: turn.answer.text, link, proposal, note };
    });
    deps.logger.info({ tenantId: orgId, tools: turn.tools, ok: turn.ok, code: turn.ok ? undefined : turn.code, inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens }, "assistant turn");
    if (!turn.ok) {
      const busy = turn.code === "provider_rate_limited" || turn.code === "provider_unavailable" || turn.code === "provider_timeout";
      return sendProblem(res, busy ? 503 : 502, "ASSISTANT_FAILED", busy ? "The assistant is busy right now. Try again in a moment" : "The assistant couldn't answer that. Try asking another way");
    }
    if (!finished) return problems.notFound(res);
    res.json({ answer: finished, usedToday: outcome.used, dailyLimit: limit });
  });
}
