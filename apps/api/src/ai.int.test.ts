import { randomUUID } from "node:crypto";
import { AI_GENERATE_JOB, aiGenerationJob, ProviderError, stubProvider, type CompletionRequest, type JsonCompletionProvider } from "@workeasy/ai";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { runJobs, type JobDeps } from "@workeasy/jobs";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { AiApplyResponseSchema, AiJobResponseSchema, FormResponseSchema, ProblemSchema, VersionListResponseSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** AI-01: bounded AI generation jobs. Needs `pnpm infra:up`; no AI provider account. */
const urls = inject("testDatabase");

let db: Db;
let workerDb: Db;
let owner: Db;
let app: Express;
let disabledApp: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

const consoleReq = (who: string, method: "get" | "post" | "put", path: string, on = app) =>
  request(on)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);

/** The provider the worker uses in each test; scripted replies, recorded calls. */
let provider: JsonCompletionProvider = stubProvider();
let calls = 0;
function scripted(...replies: Array<string | ProviderError | ((req: CompletionRequest) => Promise<string>)>): JsonCompletionProvider {
  return {
    name: "test",
    model: "test-1",
    async complete(req) {
      calls++;
      const next = replies.length > 1 ? replies.shift()! : replies[0]!;
      if (next instanceof ProviderError) throw next;
      const text = typeof next === "function" ? await next(req) : next;
      return { text, usage: { inputTokens: 1000, outputTokens: 200 } };
    },
  };
}
const VALID = JSON.stringify({
  title: "Volunteer sign-up",
  pages: [{ id: "p1", title: "", fieldIds: ["name", "shift"] }],
  fields: [
    { id: "name", type: "text", label: "Your name", required: true, privacy: "personal", settings: {} },
    { id: "shift", type: "radio", label: "Shift", required: true, settings: { options: [{ id: "am", label: "Morning" }, { id: "pm", label: "Afternoon" }] } },
  ],
  rules: [],
  success: { message: "Thanks for volunteering." },
});

const deps = (): JobDeps => ({ workerDb, tenantId: a.id, backoff: { baseMs: 1, maxMs: 5 } });
const registry = () => ({ [AI_GENERATE_JOB]: aiGenerationJob({ workerDb, provider }) });
/** Tenant A's generation jobs that will still run: queued (due or waiting to retry) or running. */
const unfinishedJobs = async () =>
  (await withTenant(owner, a.id, (trx) => trx.selectFrom("jobs").select("id").where("type", "=", AI_GENERATE_JOB).where("status", "in", ["queued", "running"]).execute())).length;

/** Runs the worker until none of tenant A's jobs is left to run (retries included). */
async function work() {
  // Retries are due a few milliseconds later; on a busy machine that can take longer, so wait for the jobs rather than a fixed time.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await runJobs(deps(), registry())) === 0) {
      if ((await unfinishedJobs()) === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error("Jobs were still unfinished after 10 seconds");
}

async function newForm(who = "ownerA", tenant = a) {
  const created = FormResponseSchema.parse((await consoleReq(who, "post", `/api/v1/organizations/${tenant.id}/forms`).send({ name: "AI form" })).body);
  return { id: created.form.id, path: `/api/v1/organizations/${tenant.id}/forms/${created.form.id}`, revision: created.draft.revision };
}
const ask = (who: string, f: { path: string; revision: number }, prompt = "A volunteer sign-up form with shifts", operation = "create") =>
  consoleReq(who, "post", `${f.path}/ai-jobs`).send({ prompt, operation, baseRevision: f.revision });
const jobPath = (id: string, tenant = a) => `/api/v1/organizations/${tenant.id}/ai-jobs/${id}`;
const generationRow = (id: string) =>
  withTenant(owner, a.id, (trx) => trx.selectFrom("ai_generations").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
const draftOf = async (path: string) => (await consoleReq("ownerA", "get", `${path}/draft`)).body as { revision: number; definition: { fields: Array<{ id: string }> } };

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 4 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings);
  disabledApp = buildTestApp(db, unusedIdentityProvider, { ...testSettings, aiEnabled: false });
  a = createTenantFixture("AI tenant A");
  b = createTenantFixture("AI tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  for (const [name, id] of [
    ["ownerA", a.members.find((m) => m.role === "owner")!.user.id],
    ["analystA", a.members.find((m) => m.role === "analyst")!.user.id],
    ["ownerB", b.members.find((m) => m.role === "owner")!.user.id],
  ] as const) {
    users[name] = id;
    tokens[name] = (await identityRepo.createSession(db, id, 60 * 60 * 1000)).token;
  }
  // AI is opt-in (AI-03); budgets are tested in ai-budget.int.test.ts.
  for (const [who, tenant] of [["ownerA", a], ["ownerB", b]] as const) {
    const on = await consoleReq(who, "put", `/api/v1/organizations/${tenant.id}/ai-settings`).send({ enabled: true, dailyTokenLimit: 100_000_000 });
    if (on.status !== 200) throw new Error(`Turning AI on failed: ${JSON.stringify(on.body)}`);
  }
});

beforeEach(async () => {
  provider = stubProvider();
  calls = 0;
  // Each test starts with no active generation for tenant A.
  await withTenant(owner, a.id, (trx) =>
    trx
      .updateTable("ai_generations")
      .set({ status: "cancelled", prompt: null, finished_at: sql<Date>`now()` })
      .where("status", "in", ["queued", "running"])
      .execute(),
  );
});

afterAll(async () => {
  await db?.destroy();
  await workerDb?.destroy();
  await owner?.destroy();
});

describe("generating a proposal", () => {
  it("queues a generation, runs it in the worker and returns a validated proposal without touching the draft", async () => {
    provider = scripted(VALID);
    const f = await newForm();
    const before = await draftOf(f.path);
    const res = await ask("ownerA", f);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const queued = AiJobResponseSchema.parse(res.body).job;
    expect(queued).toMatchObject({ status: "queued", operation: "create", baseRevision: f.revision, requestedBy: users.ownerA, proposal: null });
    expect(res.body.job).not.toHaveProperty("prompt");
    expect(res.headers.location).toBe(jobPath(queued.id));

    // The generation and its job committed together.
    const [job] = await withTenant(owner, a.id, (trx) => trx.selectFrom("jobs").selectAll().where("dedupe_key", "=", queued.id).execute());
    expect(job).toMatchObject({ type: AI_GENERATE_JOB, status: "queued", max_attempts: 3, payload: { generationId: queued.id } });

    await work();
    const done = AiJobResponseSchema.parse((await consoleReq("ownerA", "get", jobPath(queued.id))).body).job;
    expect(done).toMatchObject({ status: "succeeded", provider: "test", model: "test-1", failureCode: null, usage: { inputTokens: 1000, outputTokens: 200 } });
    expect(done.proposal).toMatchObject({ title: "Volunteer sign-up", schemaVersion: "1.0" });
    expect((done.proposal!.fields as Array<{ id: string }>).every((x) => /^f_[0-9a-f]{10}$/.test(x.id))).toBe(true);
    expect(done.summary).toMatchObject({ fields: 2, pages: 1, rules: 0, warnings: [] });

    // Nothing applied: the draft is exactly as it was.
    expect(await draftOf(f.path)).toEqual(before);
    const row = await generationRow(queued.id);
    expect(row.prompt).toBeNull();
    expect(row.prompt_digest).toMatch(/^[0-9a-f]{64}$/);
    const audit = await withTenant(owner, a.id, (trx) => trx.selectFrom("audit_events").select(["action", "metadata"]).where("resource_id", "=", f.id).execute());
    expect(audit.map((e) => e.action)).toContain("ai.generation_requested");
    expect(JSON.stringify(audit)).not.toContain("volunteer sign-up form");
  });

  it("edits an existing draft keeping the IDs it keeps", async () => {
    const f = await newForm();
    const first = AiJobResponseSchema.parse((await ask("ownerA", f)).body).job;
    await work();
    const proposal = (await generationRow(first.id)).proposal!;
    // Save the proposal by hand (applying is AI-02), then ask for an edit.
    const saved = await consoleReq("ownerA", "put", `${f.path}/draft`).set("If-Match", `"draft-${f.revision}"`).send(proposal);
    expect(saved.status).toBe(200);
    const edit = AiJobResponseSchema.parse((await ask("ownerA", { path: f.path, revision: saved.body.revision as number }, "Add a comments box", "edit")).body).job;
    await work();
    const edited = (await generationRow(edit.id)).proposal as { fields: Array<{ id: string }> };
    const keptIds = (proposal.fields as Array<{ id: string }>).map((x) => x.id);
    expect(edited.fields.map((x) => x.id).slice(0, keptIds.length)).toEqual(keptIds);
    expect((await generationRow(edit.id)).summary).toMatchObject({ removedFieldIds: [], addedFieldIds: [expect.stringMatching(/^f_/)] });
  });
});

describe("invalid output", () => {
  it("fails after one repair attempt with issue codes only, and never reaches the draft", async () => {
    provider = scripted('{"title": "<script>x</script>"}', '{"title": "Still no fields"}');
    const f = await newForm();
    const before = await draftOf(f.path);
    const id = AiJobResponseSchema.parse((await ask("ownerA", f)).body).job.id;
    await work();
    const failed = AiJobResponseSchema.parse((await consoleReq("ownerA", "get", jobPath(id))).body).job;
    expect(calls).toBe(2);
    expect(failed).toMatchObject({ status: "failed", failureCode: "invalid_output", proposal: null, usage: { inputTokens: 2000, outputTokens: 400 } });
    const issues = (failed.summary as { issues: Array<Record<string, unknown>> }).issues;
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(Object.keys(issue).toSorted()).toEqual(["code", "path"]);
    expect(JSON.stringify(failed)).not.toContain("Still no fields");
    expect(await draftOf(f.path)).toEqual(before);
  });
});

describe("provider outage", () => {
  it("retries transient failures, then fails the generation, while manual editing keeps working", async () => {
    provider = scripted(new ProviderError("provider_unavailable", true));
    const f = await newForm();
    const id = AiJobResponseSchema.parse((await ask("ownerA", f)).body).job.id;
    await runJobs(deps(), registry());
    expect(await generationRow(id)).toMatchObject({ status: "running" });

    // The author keeps working by hand during the outage.
    const manual = await consoleReq("ownerA", "put", `${f.path}/draft`)
      .set("If-Match", `"draft-${f.revision}"`)
      .send({ ...(await draftOf(f.path)).definition, title: "Edited by hand", fields: [{ id: "f_manual", type: "text", label: "Name", required: true, settings: {} }], pages: [{ id: "p_1", title: "", fieldIds: ["f_manual"] }] });
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);

    await work();
    expect(calls).toBe(3);
    expect(await generationRow(id)).toMatchObject({ status: "failed", failure_code: "provider_unavailable", proposal: null });
    expect((await draftOf(f.path)).definition.fields.map((x) => x.id)).toEqual(["f_manual"]);
  });

  it("does not retry a failure retrying cannot fix", async () => {
    provider = scripted(new ProviderError("provider_auth", false));
    const id = AiJobResponseSchema.parse((await ask("ownerA", await newForm())).body).job.id;
    await work();
    expect(calls).toBe(1);
    expect(await generationRow(id)).toMatchObject({ status: "failed", failure_code: "provider_auth" });
  });

  it("answers 503 when AI is not configured, and editing is unaffected", async () => {
    const f = await newForm();
    expectProblem(await ask("ownerA", f).then(() => consoleReq("ownerA", "post", `${f.path}/ai-jobs`, disabledApp).send({ prompt: "A form", operation: "create", baseRevision: f.revision })), 503, "AI_UNAVAILABLE");
    const saved = await consoleReq("ownerA", "put", `${f.path}/draft`, disabledApp)
      .set("If-Match", `"draft-${f.revision}"`)
      .send({ ...(await draftOf(f.path)).definition, title: "Still editable" });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });

  it("fails a generation the worker cannot run because no provider is configured there", async () => {
    const id = AiJobResponseSchema.parse((await ask("ownerA", await newForm())).body).job.id;
    await runJobs(deps(), { [AI_GENERATE_JOB]: aiGenerationJob({ workerDb, provider: undefined }) });
    expect(await generationRow(id)).toMatchObject({ status: "failed", failure_code: "ai_unavailable" });
  });
});

describe("limits and deadlines", () => {
  it("allows one active generation per user, and cancelling frees the slot", async () => {
    const f = await newForm();
    const first = AiJobResponseSchema.parse((await ask("ownerA", f)).body).job;
    expectProblem(await ask("ownerA", f), 409, "AI_GENERATION_IN_PROGRESS");
    const cancelled = await consoleReq("ownerA", "post", `${jobPath(first.id)}/cancel`);
    expect(AiJobResponseSchema.parse(cancelled.body).job).toMatchObject({ status: "cancelled" });
    // The worker then skips it.
    await work();
    expect(calls).toBe(0);
    expect((await ask("ownerA", f)).status).toBe(202);
  });

  it("allows five active generations per organization", async () => {
    const f = await newForm();
    for (let i = 0; i < 5; i++) {
      const user = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `ai-busy-${randomUUID()}` });
      await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: user, role: "admin" }).execute());
      tokens[`busy${i}`] = (await identityRepo.createSession(db, user, 60 * 60 * 1000)).token;
      expect((await ask(`busy${i}`, f)).status).toBe(202);
    }
    expectProblem(await ask("ownerA", f), 429, "AI_BUSY");
  });

  it("fails a generation that ran past its deadline, and the worker does not run it", async () => {
    const id = AiJobResponseSchema.parse((await ask("ownerA", await newForm())).body).job.id;
    await withTenant(owner, a.id, (trx) => trx.updateTable("ai_generations").set({ deadline_at: sql<Date>`now() - interval '1 second'` }).where("id", "=", id).execute());
    expect(AiJobResponseSchema.parse((await consoleReq("ownerA", "get", jobPath(id))).body).job).toMatchObject({ status: "failed", failureCode: "deadline_exceeded" });
    await work();
    expect(calls).toBe(0);
  });

  it("discards the result of a generation cancelled while the provider was working, but records the spend", async () => {
    let id = "";
    provider = scripted(async () => {
      await consoleReq("ownerA", "post", `${jobPath(id)}/cancel`);
      return VALID;
    });
    id = AiJobResponseSchema.parse((await ask("ownerA", await newForm())).body).job.id;
    await work();
    expect(await generationRow(id)).toMatchObject({ status: "cancelled", proposal: null, input_tokens: 1000, output_tokens: 200 });
  });
});

describe("access", () => {
  it("needs forms.edit, a current draft revision and a bounded prompt; other tenants see nothing", async () => {
    const f = await newForm();
    expectProblem(await ask("analystA", f), 404, "NOT_FOUND");
    // With read access only, the form is visible but AI requests are not allowed.
    const granted = await consoleReq("ownerA", "put", `${f.path}/grants`).send({ grants: [{ principalType: "user", principalId: users.analystA, permission: "forms.read" }] });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expectProblem(await ask("analystA", f), 403, "FORBIDDEN");
    expectProblem(await consoleReq("ownerA", "post", `${f.path}/ai-jobs`).send({ prompt: "x".repeat(8001), operation: "create", baseRevision: f.revision }), 422, "VALIDATION_FAILED");
    expectProblem(await ask("ownerA", { ...f, revision: f.revision + 1 }), 412, "DRAFT_CONFLICT");
    const id = AiJobResponseSchema.parse((await ask("ownerA", f)).body).job.id;
    expectProblem(await consoleReq("analystA", "get", jobPath(id)), 403, "FORBIDDEN");
    expectProblem(await consoleReq("analystA", "post", `${jobPath(id)}/cancel`), 403, "FORBIDDEN");
    expectProblem(await consoleReq("ownerB", "get", jobPath(id, b)), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerB", "get", jobPath(id)), 404, "NOT_FOUND");
  });
});

describe("deciding proposals (AI-02)", () => {
  /** A form with a finished proposal against its current draft. */
  async function proposed(operation = "create", f?: { id: string; path: string; revision: number }) {
    const form = f ?? (await newForm());
    const id = AiJobResponseSchema.parse((await ask("ownerA", form, "A volunteer sign-up form", operation)).body).job.id;
    await work();
    return { form, id, job: AiJobResponseSchema.parse((await consoleReq("ownerA", "get", jobPath(id))).body).job };
  }
  const apply = (id: string, expectedRevision: number, who = "ownerA") => consoleReq(who, "post", `${jobPath(id)}/apply`).send({ expectedRevision });
  const formOf = async (path: string) => FormResponseSchema.parse((await consoleReq("ownerA", "get", path)).body).form;

  it("applies a proposal as the next draft revision, once, without publishing", async () => {
    provider = scripted(VALID);
    const { form, id, job } = await proposed();
    expect(job).toMatchObject({ status: "succeeded", decision: null });
    const res = await apply(id, form.revision);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const applied = AiApplyResponseSchema.parse(res.body);
    expect(applied.draft.revision).toBe(form.revision + 1);
    expect(applied.job.decision).toMatchObject({ kind: "applied", by: users.ownerA, appliedRevision: form.revision + 1 });
    expect(res.headers.etag).toBe(`"draft-${form.revision + 1}"`);
    const draft = await draftOf(form.path);
    expect(draft.revision).toBe(form.revision + 1);
    expect(draft.definition).toEqual(job.proposal);

    // Applying is not publishing.
    expect(await formOf(form.path)).toMatchObject({ state: "draft", activeVersionId: null });
    expect(VersionListResponseSchema.parse((await consoleReq("ownerA", "get", `${form.path}/versions`)).body).items).toEqual([]);
    const audit = await withTenant(owner, a.id, (trx) => trx.selectFrom("audit_events").select(["action", "metadata"]).where("resource_id", "=", form.id).execute());
    expect(audit.map((e) => e.action)).toContain("ai.proposal_applied");
    expect(audit.map((e) => e.action)).not.toContain("form.published");

    // Decided once.
    expectProblem(await apply(id, form.revision + 1), 409, "AI_PROPOSAL_DECIDED");
    expectProblem(await consoleReq("ownerA", "post", `${jobPath(id)}/reject`), 409, "AI_PROPOSAL_DECIDED");
  });

  it("never overwrites a draft saved after the proposal was made", async () => {
    const f = await newForm();
    const id = AiJobResponseSchema.parse((await ask("ownerA", f)).body).job.id;
    // Someone edits by hand while the AI works.
    const manual = { ...(await draftOf(f.path)).definition, title: "Hand made", fields: [{ id: "f_hand", type: "text", label: "Name", required: true, settings: {} }], pages: [{ id: "p_1", title: "", fieldIds: ["f_hand"] }] };
    const saved = await consoleReq("ownerA", "put", `${f.path}/draft`).set("If-Match", `"draft-${f.revision}"`).send(manual);
    expect(saved.status).toBe(200);
    await work();
    const current = saved.body.revision as number;

    // Neither the old revision nor the current one lets the stale proposal through.
    for (const expected of [f.revision, current]) {
      const res = await apply(id, expected);
      expectProblem(res, 412, "DRAFT_CONFLICT");
      expect(res.body).toMatchObject({ currentRevision: current, baseRevision: f.revision });
    }
    const draft = await draftOf(f.path);
    expect(draft).toMatchObject({ revision: current, definition: { title: "Hand made" } });
    expect((await generationRow(id)).decision).toBeNull();

    // Asking again against the current draft works and can be applied.
    const again = await proposed("edit", { ...f, revision: current });
    expect((await apply(again.id, current)).status).toBe(200);
    expect((await draftOf(f.path)).definition.fields.map((x) => x.id)[0]).toBe("f_hand");
  });

  it("lets only one of two concurrent applies through", async () => {
    const { form, id } = await proposed();
    const results = await Promise.all([apply(id, form.revision), apply(id, form.revision)]);
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
    expect((await draftOf(form.path)).revision).toBe(form.revision + 1);
  });

  it("rejects a proposal without touching the draft", async () => {
    const { form, id } = await proposed();
    const before = await draftOf(form.path);
    const rejected = await consoleReq("ownerA", "post", `${jobPath(id)}/reject`);
    expect(AiJobResponseSchema.parse(rejected.body).job.decision).toMatchObject({ kind: "rejected", appliedRevision: null });
    expect(await draftOf(form.path)).toEqual(before);
    expectProblem(await apply(id, form.revision), 409, "AI_PROPOSAL_DECIDED");
  });

  it("validates a stored proposal again before applying it", async () => {
    const { form, id } = await proposed();
    await withTenant(owner, a.id, (trx) =>
      trx.updateTable("ai_generations").set({ proposal: { title: "Tampered", fields: [] } }).where("id", "=", id).execute(),
    );
    const before = await draftOf(form.path);
    expectProblem(await apply(id, form.revision), 422, "AI_PROPOSAL_INVALID");
    expect(await draftOf(form.path)).toEqual(before);
  });

  it("does not decide unfinished generations, and needs forms.edit", async () => {
    const f = await newForm();
    const queued = AiJobResponseSchema.parse((await ask("ownerA", f)).body).job.id;
    expectProblem(await apply(queued, f.revision), 409, "AI_PROPOSAL_NOT_READY");
    expectProblem(await consoleReq("ownerA", "post", `${jobPath(queued)}/reject`), 409, "AI_PROPOSAL_NOT_READY");
    await work();
    await consoleReq("ownerA", "put", `${f.path}/grants`).send({ grants: [{ principalType: "user", principalId: users.analystA, permission: "forms.read" }] });
    expectProblem(await apply(queued, f.revision, "analystA"), 403, "FORBIDDEN");
    expectProblem(await consoleReq("analystA", "post", `${jobPath(queued)}/reject`), 403, "FORBIDDEN");
    expectProblem(await consoleReq("ownerB", "post", `${jobPath(queued)}/apply`).send({ expectedRevision: f.revision }), 404, "NOT_FOUND");
  });

  it("changes only the draft of a published form; the live version stays until someone publishes", async () => {
    provider = scripted(VALID);
    const { form, id } = await proposed();
    await apply(id, form.revision);
    const published = await consoleReq("ownerA", "post", `${form.path}/publish`).set("If-Match", `"draft-${form.revision + 1}"`).set("Idempotency-Key", `k-${randomUUID()}`);
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const live = await formOf(form.path);

    provider = stubProvider();
    const edit = await proposed("edit", { ...form, revision: form.revision + 1 });
    expect((await apply(edit.id, form.revision + 1)).status).toBe(200);
    expect(await formOf(form.path)).toMatchObject({ state: "published", activeVersionId: live.activeVersionId });
    expect(VersionListResponseSchema.parse((await consoleReq("ownerA", "get", `${form.path}/versions`)).body).items).toHaveLength(1);
  });
});
