import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { FormResponseSchema, ProblemSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/**
 * The console assistant with the local stub model (docs/09): answers from
 * tools that run as the member inside their organization, links and
 * proposals checked against role and form access, changes carried out only
 * through the existing endpoints, the AI opt-in, organization isolation and
 * the daily allowance. Needs `pnpm infra:up`.
 */
const urls = inject("testDatabase");

let db: Db;
let owner: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
let c: TenantFixture;
const tokens: Record<string, string> = {};

const consoleReq = (who: string, method: "get" | "post" | "put", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);
const org = (t: TenantFixture = a) => `/api/v1/organizations/${t.id}`;
const ask = (who: string, question: string, t: TenantFixture = a) => consoleReq(who, "post", `${org(t)}/assistant`).send({ question });

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

async function newForm(name: string) {
  return FormResponseSchema.parse((await consoleReq("ownerA", "post", `${org()}/forms`).send({ name })).body).form.id;
}

/** A live form from a template, published the way the builder does, so close and reopen have something to act on. */
async function publishedForm(name: string) {
  const made = FormResponseSchema.parse((await consoleReq("ownerA", "post", `${org()}/forms`).send({ name, template: "contact" })).body);
  const published = await consoleReq("ownerA", "post", `${org()}/forms/${made.form.id}/publish`).set("If-Match", `"draft-${made.draft.revision}"`).set("Idempotency-Key", `k-${randomUUID()}`);
  if (published.status !== 201 && published.status !== 200) throw new Error(`publish failed: ${JSON.stringify(published.body)}`);
  return made.form.id;
}

/** Carries out a proposal the way the console does: its own request, as the member. */
const confirm = (who: string, proposal: { request: { method: "POST" | "PUT"; path: string; body: Record<string, unknown> } }) =>
  consoleReq(who, proposal.request.method.toLowerCase() as "post", proposal.request.path).send(proposal.request.body);

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings);
  a = createTenantFixture("Assistant tenant A");
  b = createTenantFixture("Assistant tenant B");
  c = createTenantFixture("Assistant tenant C");
  for (const t of [a, b, c]) await seedTenantFixture(db, t);
  for (const [name, t, role] of [
    ["ownerA", a, "owner"],
    ["analystA", a, "analyst"],
    ["ownerB", b, "owner"],
    ["ownerC", c, "owner"],
  ] as const) {
    tokens[name] = (await identityRepo.createSession(db, t.members.find((m) => m.role === role)!.user.id, 60 * 60 * 1000)).token;
  }
});

afterAll(async () => {
  await db?.destroy();
  await owner?.destroy();
});

describe("assistant", () => {
  it("stays off until an owner turns AI on for the organization", async () => {
    expect((await consoleReq("ownerA", "get", `${org()}/assistant`)).body).toEqual({ enabled: false, disabledBy: "organization", usedToday: 0, dailyLimit: testSettings.assistantDailyLimit });
    expectProblem(await ask("ownerA", "How many forms do we have?"), 409, "AI_NOT_ENABLED");
    for (const [who, t] of [["ownerA", a], ["ownerB", b], ["ownerC", c]] as const) {
      const on = await consoleReq(who, "put", `${org(t)}/ai-settings`).send({ enabled: true, dailyTokenLimit: 100_000_000 });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
    }
    expect((await consoleReq("ownerA", "get", `${org()}/assistant`)).body).toMatchObject({ enabled: true, usedToday: 0 });
  });

  it("answers from this organization's data with a tool, and charges its tokens to the day's budget", async () => {
    await newForm("Workshop registration");
    const r = await ask("ownerA", "Find our forms");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.answer).toMatchObject({ text: expect.stringMatching(/^I found \d+ results? \(search_forms\)\.$/), proposal: null, note: null });
    expect(r.body).toMatchObject({ usedToday: 1, dailyLimit: testSettings.assistantDailyLimit });
    const usage = await withTenant(owner, a.id, (trx) => trx.selectFrom("ai_usage_days").select(["used_tokens", "assistant_messages"]).executeTakeFirstOrThrow());
    expect(Number(usage.used_tokens)).toBeGreaterThan(0);
    expect(usage.assistant_messages).toBe(1);
  });

  it("opens only pages and form tabs the member's role can see", async () => {
    const formId = await newForm("Feedback survey");
    expect((await ask("ownerA", "Take me to members")).body.answer.link).toEqual({ label: "Members", href: `/o/${a.id}/members` });
    expect((await ask("ownerA", `Open the responses of ${formId}`)).body.answer.link).toEqual({ label: "Feedback survey responses", href: `/o/${a.id}/forms/${formId}/responses` });
    // Analysts can't manage members, and hold no grant on this form.
    expect((await ask("analystA", "Take me to members")).body.answer.link).toBeNull();
    expect((await ask("analystA", `Open the responses of ${formId}`)).body.answer.link).toBeNull();
  });

  it("proposes closing a live form, which only its own endpoint carries out", async () => {
    const formId = await publishedForm("Volunteer sign-up");
    const r = await ask("ownerA", `Close ${formId}`);
    expect(r.body.answer.note).toBeNull();
    const proposal = r.body.answer.proposal;
    expect(proposal).toMatchObject({ kind: "close_form", title: "Close Volunteer sign-up", danger: true, request: { method: "POST", path: `${org()}/forms/${formId}/close`, body: {} } });
    // Asking changed nothing.
    expect((await consoleReq("ownerA", "get", `${org()}/forms/${formId}`)).body.form.state).toBe("published");
    const done = await confirm("ownerA", proposal);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.form.state).toBe("closed");
    // Now it's closed: closing again is refused with a reason, and reopening is offered.
    expect((await ask("ownerA", `Close ${formId}`)).body.answer).toMatchObject({ proposal: null, note: expect.stringMatching(/isn't accepting responses/) });
    expect((await ask("ownerA", `Reopen ${formId}`)).body.answer.proposal).toMatchObject({ kind: "reopen_form", request: { path: `${org()}/forms/${formId}/reopen` } });
  });

  it("refuses proposals the member's role or access can't carry out", async () => {
    const formId = await publishedForm("Private intake");
    // The analyst can't see this form at all, so there's nothing to close.
    expect((await ask("analystA", `Close ${formId}`)).body.answer).toMatchObject({ proposal: null, note: expect.stringMatching(/couldn't find that form/) });
    // Creating forms needs forms.create, which analysts don't hold.
    expect((await ask("analystA", 'Create a new form "Expenses"')).body.answer).toMatchObject({ proposal: null, note: expect.stringMatching(/role can't make this change/) });
  });

  it("proposes creating and copying forms through the same endpoints as the Forms page", async () => {
    const created = (await ask("ownerA", 'Create a new form "Customer feedback" from the feedback template')).body.answer.proposal;
    expect(created).toMatchObject({ kind: "create_form", request: { path: `${org()}/forms`, body: { name: "Customer feedback", template: "feedback" } }, done: { path: "/forms/:id/build", idFrom: "form" } });
    const made = await confirm("ownerA", created);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const copy = (await ask("ownerA", `Duplicate ${made.body.form.id} as "Customer feedback (EU)"`)).body.answer.proposal;
    expect(copy).toMatchObject({ kind: "duplicate_form", request: { path: `${org()}/forms/${made.body.form.id}/duplicate`, body: { name: "Customer feedback (EU)" } } });
    const copied = await confirm("ownerA", copy);
    expect(copied.status, JSON.stringify(copied.body)).toBe(201);
    expect(copied.body.form.name).toBe("Customer feedback (EU)");
  });

  it("is limited to members of the organization", async () => {
    expectProblem(await ask("ownerB", "Find our forms"), 404, "NOT_FOUND");
    const formId = await newForm("Tenant A only");
    // Another organization's owner can't reach tenant A's forms from their own organization either.
    expect((await ask("ownerB", `Open the responses of ${formId}`, b)).body.answer.link).toBeNull();
    expect((await ask("ownerB", `Close ${formId}`, b)).body.answer).toMatchObject({ proposal: null, note: expect.stringMatching(/couldn't find that form/) });
  });

  it("stops at the organization's daily question limit", async () => {
    const limit = testSettings.assistantDailyLimit!;
    for (let i = 0; i < limit; i++) expect((await ask("ownerC", "Give me an overview", c)).status).toBe(200);
    expectProblem(await ask("ownerC", "Give me an overview", c), 409, "ASSISTANT_DAILY_LIMIT");
    // Other organizations keep their own allowance.
    expect((await ask("ownerB", "Give me an overview", b)).status).toBe(200);
  });
});
