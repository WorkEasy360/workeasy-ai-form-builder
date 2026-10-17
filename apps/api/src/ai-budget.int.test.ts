import { randomUUID } from "node:crypto";
import { AI_GENERATE_JOB, aiGenerationJob, type JsonCompletionProvider } from "@workeasy/ai";
import { aiRepo, createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { runJobs } from "@workeasy/jobs";
import { createLogger } from "@workeasy/observability";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { AiJobResponseSchema, AiSettingsResponseSchema, FormResponseSchema, ProblemSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, testObjectStore, testSettings, unusedIdentityProvider } from "./test-support.js";

/** AI-03: opt-in, daily token budgets under concurrency, and metadata-only logs. Needs `pnpm infra:up`. */
const urls = inject("testDatabase");

const PROMPT_MARKER = "ZEBRA-PROMPT-7731";
const REPLY_MARKER = "QUOKKA-LABEL-4410";
const REPLY = JSON.stringify({
  title: `Survey ${REPLY_MARKER}`,
  pages: [{ id: "p", title: "", fieldIds: ["n"] }],
  fields: [{ id: "n", type: "text", label: `Name ${REPLY_MARKER}`, required: true, settings: {} }],
  rules: [],
  success: { message: "Thanks" },
});

let db: Db;
let workerDb: Db;
let owner: Db;
let app: Express;
let t: TenantFixture;
let other: TenantFixture;
const tokens: Record<string, string> = {};
/** Everything the API and the worker logged, as raw lines. */
const logs: string[] = [];

const provider: JsonCompletionProvider = {
  name: "test",
  model: "test-1",
  complete: () => Promise.resolve({ text: REPLY, usage: { inputTokens: 1500, outputTokens: 300 } }),
};
const work = async () => {
  const registry = { [AI_GENERATE_JOB]: aiGenerationJob({ workerDb, provider, log: (level, message, fields) => logs.push(JSON.stringify({ level, message, ...fields })) }) };
  // A busy machine can make an attempt fail transiently and retry a moment later, so run until the generations are done.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await runJobs({ workerDb, tenantId: t.id }, registry)) > 0) continue;
    const unfinished = await withTenant(owner, t.id, (trx) =>
      trx.selectFrom("jobs").select("id").where("type", "=", AI_GENERATE_JOB).where("status", "in", ["queued", "running"]).execute(),
    );
    if (unfinished.length === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Generations were still unfinished after 10 seconds");
};

const consoleReq = (who: string, method: "get" | "post" | "put", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);
const settingsPath = () => `/api/v1/organizations/${t.id}/ai-settings`;
const setBudget = (enabled: boolean, dailyTokenLimit: number) => consoleReq("owner", "put", settingsPath()).send({ enabled, dailyTokenLimit });
async function newForm() {
  const created = FormResponseSchema.parse((await consoleReq("owner", "post", `/api/v1/organizations/${t.id}/forms`).send({ name: "Budget form" })).body);
  return { path: `/api/v1/organizations/${t.id}/forms/${created.form.id}`, revision: created.draft.revision };
}
const ask = (who: string, f: { path: string; revision: number }) =>
  consoleReq(who, "post", `${f.path}/ai-jobs`).send({ prompt: `A short survey ${PROMPT_MARKER}`, operation: "create", baseRevision: f.revision });
const today = () =>
  withTenant(owner, t.id, async (trx) => {
    const row = await trx.selectFrom("ai_usage_days").selectAll().where("day", "=", sql<string>`(now() AT TIME ZONE 'UTC')::date`).executeTakeFirst();
    return { used: Number(row?.used_tokens ?? 0), reserved: Number(row?.reserved_tokens ?? 0) };
  });
const generation = (id: string) => withTenant(owner, t.id, (trx) => trx.selectFrom("ai_generations").selectAll().where("id", "=", id).executeTakeFirstOrThrow());

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

/** The reservation for one request against a fresh form, measured once. */
let perRequest = 0;

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 12 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 4 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  const logger = createLogger({ service: "api-test", level: "debug", destination: { write: (line: string) => void logs.push(line) } });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, db, unusedIdentityProvider, testObjectStore(), logger);
  t = createTenantFixture("AI budget tenant");
  other = createTenantFixture("AI budget other tenant");
  await seedTenantFixture(db, t);
  await seedTenantFixture(db, other);
  tokens.owner = (await identityRepo.createSession(db, t.members.find((m) => m.role === "owner")!.user.id, 3_600_000)).token;
  tokens.analyst = (await identityRepo.createSession(db, t.members.find((m) => m.role === "analyst")!.user.id, 3_600_000)).token;
  for (let i = 0; i < 5; i++) {
    const user = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `budget-${randomUUID()}` });
    await withTenant(db, t.id, (trx) => trx.insertInto("memberships").values({ tenant_id: t.id, user_id: user, role: "admin" }).execute());
    tokens[`admin${i}`] = (await identityRepo.createSession(db, user, 3_600_000)).token;
  }
});

beforeEach(async () => {
  // A clean day and no active generations, so each test sets its own budget.
  await withTenant(owner, t.id, async (trx) => {
    await trx
      .updateTable("ai_generations")
      .set({ status: "cancelled", prompt: null, finished_at: sql<Date>`now()`, reserved_tokens: 0 })
      .where("status", "in", ["queued", "running"])
      .execute();
    await trx.updateTable("ai_generations").set({ reserved_tokens: 0 }).execute();
    await trx.deleteFrom("ai_usage_days").execute();
  });
});

afterAll(async () => {
  await db?.destroy();
  await workerDb?.destroy();
  await owner?.destroy();
});

describe("opt-in", () => {
  it("is off until an owner turns it on, and the change is audited", async () => {
    const f = await newForm();
    expectProblem(await ask("owner", f), 403, "AI_NOT_ENABLED");
    const initial = AiSettingsResponseSchema.parse((await consoleReq("analyst", "get", settingsPath())).body);
    expect(initial).toEqual({ settings: { enabled: false, dailyTokenLimit: 200_000 }, available: true, today: { usedTokens: 0, reservedTokens: 0 } });

    expectProblem(await consoleReq("analyst", "put", settingsPath()).send({ enabled: true, dailyTokenLimit: 5000 }), 403, "FORBIDDEN");
    expectProblem(await setBudget(true, 10), 422, "VALIDATION_FAILED");
    const on = await setBudget(true, 1_000_000);
    expect(AiSettingsResponseSchema.parse(on.body).settings).toEqual({ enabled: true, dailyTokenLimit: 1_000_000 });
    expect((await ask("owner", f)).status).toBe(202);

    const audit = await withTenant(owner, t.id, (trx) =>
      trx.selectFrom("audit_events").select("metadata").where("action", "=", "organization.ai_settings_changed").execute(),
    );
    expect(audit.at(-1)!.metadata).toEqual({ before: { enabled: false, dailyTokenLimit: 200_000 }, after: { enabled: true, dailyTokenLimit: 1_000_000 } });
    // Other organizations are unaffected.
    expect(await withTenant(db, other.id, (trx) => aiRepo.getSettings(trx))).toMatchObject({ enabled: false });
  });

  it("stops queued generations when AI is turned off before they run, releasing their reservation", async () => {
    await setBudget(true, 1_000_000);
    const id = AiJobResponseSchema.parse((await ask("owner", await newForm())).body).job.id;
    expect((await today()).reserved).toBeGreaterThan(0);
    await setBudget(false, 1_000_000);
    await work();
    expect(await generation(id)).toMatchObject({ status: "failed", failure_code: "ai_not_enabled", reserved_tokens: 0 });
    expect(await today()).toEqual({ used: 0, reserved: 0 });
  });
});

describe("daily budget", () => {
  it("reserves the worst case up front, charges actual use and releases the rest", async () => {
    await setBudget(true, 1_000_000);
    const id = AiJobResponseSchema.parse((await ask("owner", await newForm())).body).job.id;
    perRequest = (await generation(id)).reserved_tokens;
    expect(perRequest).toBeGreaterThan(1800);
    expect(await today()).toEqual({ used: 0, reserved: perRequest });

    await work();
    expect(await generation(id)).toMatchObject({ status: "succeeded", input_tokens: 1500, output_tokens: 300, reserved_tokens: 0 });
    expect(await today()).toEqual({ used: 1800, reserved: 0 });
    const shown = AiSettingsResponseSchema.parse((await consoleReq("owner", "get", settingsPath())).body);
    expect(shown.today).toEqual({ usedTokens: 1800, reservedTokens: 0 });
  });

  it("refuses a request whose worst case does not fit, and lets one through once use is settled", async () => {
    await setBudget(true, perRequest + 2000);
    const f = await newForm();
    const first = AiJobResponseSchema.parse((await ask("admin0", f)).body).job.id;
    const refused = await ask("admin1", f);
    expectProblem(refused, 429, "AI_BUDGET_EXCEEDED");
    expect(refused.body).toMatchObject({ dailyTokenLimit: perRequest + 2000, reservedTokens: perRequest, requestTokens: perRequest });
    // Once the first finishes, only its actual use counts and the next fits.
    await work();
    expect((await generation(first)).reserved_tokens).toBe(0);
    expect((await ask("admin1", f)).status).toBe(202);
  });

  it("holds the cap when many requests arrive at once", async () => {
    // Room for exactly two worst-case requests.
    await setBudget(true, perRequest * 2 + perRequest / 2);
    const f = await newForm();
    const results = await Promise.all([0, 1, 2, 3, 4].map((i) => ask(`admin${i}`, f)));
    const statuses = results.map((r) => r.status).toSorted();
    expect(statuses).toEqual([202, 202, 429, 429, 429]);
    expect(results.filter((r) => r.status === 429).every((r) => r.body.code === "AI_BUDGET_EXCEEDED")).toBe(true);
    expect((await today()).reserved).toBe(perRequest * 2);
  });

  it("never over-reserves when reservations race in separate transactions", async () => {
    const limit = 10_000;
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => withTenant(db, t.id, (trx) => aiRepo.reserveTokens(trx, t.id, 1000, limit))));
    expect(outcomes.filter(Boolean)).toHaveLength(10);
    expect((await today()).reserved).toBe(10_000);
  });

  it("releases the reservation of a cancelled queued generation and of an expired one", async () => {
    await setBudget(true, 1_000_000);
    const cancelledId = AiJobResponseSchema.parse((await ask("admin0", await newForm())).body).job.id;
    await consoleReq("admin0", "post", `/api/v1/organizations/${t.id}/ai-jobs/${cancelledId}/cancel`);
    expect((await generation(cancelledId)).reserved_tokens).toBe(0);
    const expiredId = AiJobResponseSchema.parse((await ask("admin1", await newForm())).body).job.id;
    await withTenant(owner, t.id, (trx) => trx.updateTable("ai_generations").set({ deadline_at: sql<Date>`now() - interval '1 second'` }).where("id", "=", expiredId).execute());
    await consoleReq("admin1", "get", `/api/v1/organizations/${t.id}/ai-jobs/${expiredId}`);
    expect(await generation(expiredId)).toMatchObject({ status: "failed", reserved_tokens: 0 });
    expect(await today()).toEqual({ used: 0, reserved: 0 });
  });
});

describe("logs", () => {
  it("raise a spend alarm near the limit, and never contain prompts or model output", async () => {
    // Room for one request; its actual use passes 80% of the limit.
    await setBudget(true, Math.max(perRequest + 10, 1000));
    await withTenant(owner, t.id, (trx) =>
      trx
        .insertInto("ai_usage_days")
        .values({ tenant_id: t.id, day: sql<string>`(now() AT TIME ZONE 'UTC')::date` as unknown as string, used_tokens: 0 })
        .onConflict((oc) => oc.columns(["tenant_id", "day"]).doNothing())
        .execute(),
    );
    logs.length = 0;
    const id = AiJobResponseSchema.parse((await ask("owner", await newForm())).body).job.id;
    await withTenant(owner, t.id, (trx) =>
      trx.updateTable("ai_usage_days").set({ used_tokens: sql<number>`(SELECT daily_token_limit FROM app.ai_settings) * 0.8` as unknown as number }).execute(),
    );
    await work();
    await consoleReq("owner", "get", `/api/v1/organizations/${t.id}/ai-jobs/${id}`);

    expect((await generation(id)).status).toBe("succeeded");
    const all = logs.join("\n");
    expect(all).toContain("AI daily token budget nearly used");
    expect(all).toContain("AI generation succeeded");
    expect(all).toContain("request completed");
    expect(all).not.toContain(PROMPT_MARKER);
    expect(all).not.toContain(REPLY_MARKER);
    // Nor is the prompt kept anywhere once the generation ends, or in the audit log.
    expect(JSON.stringify(await generation(id))).not.toContain(PROMPT_MARKER);
    const audit = await withTenant(owner, t.id, (trx) => trx.selectFrom("audit_events").select("metadata").execute());
    expect(JSON.stringify(audit)).not.toContain(PROMPT_MARKER);
    const jobs = await withTenant(owner, t.id, (trx) => trx.selectFrom("jobs").select(["payload", "last_error"]).execute());
    expect(JSON.stringify(jobs)).not.toContain(PROMPT_MARKER);
  });
});
