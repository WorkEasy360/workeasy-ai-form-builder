import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { AnalyticsResponseSchema, FormResponseSchema, ProblemSchema, SessionStartResponseSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** ANA-01: views, starts and accepts from respondent sessions, with no answer telemetry. Needs `pnpm infra:up`. */
const urls = inject("testDatabase");
const ANSWER_MARKER = "Answer-Marker-8841";

let db: Db;
let publicDb: Db;
let owner: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

const consoleReq = (who: string, method: "get" | "post" | "put" | "delete", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function publishedForm() {
  const def = blankDefinition("Feedback");
  def.fields = [{ id: "f_text", type: "text", label: "Comments", required: true, settings: {} }];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_text"] }];
  const created = FormResponseSchema.parse((await consoleReq("ownerA", "post", `/api/v1/organizations/${a.id}/forms`).send({ name: "Feedback" })).body);
  const path = `/api/v1/organizations/${a.id}/forms/${created.form.id}`;
  const saved = await consoleReq("ownerA", "put", `${path}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(def);
  const published = await consoleReq("ownerA", "post", `${path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `k-${randomUUID()}`);
  expect(published.status).toBe(201);
  return { id: created.form.id, slug: created.form.slug, path };
}

const open = async (slug: string) => SessionStartResponseSchema.parse((await request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body);
const started = (s: { sessionId: string; capability: string }, capability = s.capability) =>
  request(app).post(`/public/v1/sessions/${s.sessionId}/started`).set("Authorization", `Bearer ${capability}`);
async function submit(s: { sessionId: string; capability: string; versionId: string }) {
  const res = await request(app)
    .post(`/public/v1/sessions/${s.sessionId}/submissions`)
    .set("Authorization", `Bearer ${s.capability}`)
    .set("Idempotency-Key", `k-${randomUUID()}`)
    .send({ formVersionId: s.versionId, answers: { f_text: ANSWER_MARKER } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.submissionId as string;
}
const analytics = async (path: string, query = "", who = "ownerA") => {
  const res = await consoleReq(who, "get", `${path}/analytics${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return AnalyticsResponseSchema.parse(res.body);
};

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 4 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb);
  a = createTenantFixture("Analytics tenant A");
  b = createTenantFixture("Analytics tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  for (const [name, id] of [
    ["ownerA", a.members.find((m) => m.role === "owner")!.user.id],
    ["analystA", a.members.find((m) => m.role === "analyst")!.user.id],
    ["ownerB", b.members.find((m) => m.role === "owner")!.user.id],
  ] as const) {
    users[name] = id;
    tokens[name] = (await identityRepo.createSession(db, id, 3_600_000)).token;
  }
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await owner?.destroy();
});

describe("form analytics", () => {
  it("counts views, starts and accepts once per session, by the day the session opened", async () => {
    const form = await publishedForm();
    const finished = await open(form.slug);
    const abandoned = await open(form.slug);
    await open(form.slug); // looked and left
    const direct = await open(form.slug); // submitted without a start report (e.g. autofill)

    expect((await started(finished)).status).toBe(204);
    expect((await started(abandoned)).status).toBe(204);
    expect((await started(abandoned)).status).toBe(204); // reported again: still one start
    await submit(finished);
    const deletedLater = await submit(direct);
    // A response deleted later still counts as accepted.
    expect((await consoleReq("ownerA", "delete", `${form.path}/submissions/${deletedLater}`).send({ reason: "Test deletion" })).status).toBe(202);

    // One more session opened yesterday counts on yesterday.
    const yesterday = await open(form.slug);
    await withTenant(owner, a.id, (trx) =>
      trx.updateTable("respondent_sessions").set({ created_at: sql`now() - interval '1 day'` as never }).where("id", "=", yesterday.sessionId).execute(),
    );

    const result = await analytics(form.path, `?from=${daysAgo(6)}&to=${today()}`);
    expect(result.from).toBe(daysAgo(6));
    expect(result.days.map((d) => d.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(daysAgo));
    expect(result.days.at(-1)).toEqual({ day: today(), views: 4, starts: 3, accepts: 2 });
    expect(result.days.at(-2)).toEqual({ day: daysAgo(1), views: 1, starts: 0, accepts: 0 });
    expect(result.days.slice(0, 5).every((d) => d.views === 0 && d.starts === 0 && d.accepts === 0)).toBe(true);
    expect(result.totals).toEqual({ views: 5, starts: 3, accepts: 2, startRate: 3 / 5, completionRate: 2 / 3 });
    expect(Object.keys(result.definitions).toSorted()).toEqual(["accept", "day", "start", "view"]);

    // Defaults to the last 30 days.
    const defaults = await analytics(form.path);
    expect(defaults.days).toHaveLength(30);
    expect(defaults).toMatchObject({ to: today(), from: daysAgo(29) });
  });

  it("involves no answers: nothing in the result, and only a start time is stored", async () => {
    const form = await publishedForm();
    const session = await open(form.slug);
    await started(session);
    await submit(session);
    const result = await analytics(form.path);
    expect(JSON.stringify(result)).not.toContain(ANSWER_MARKER);
    const row = await withTenant(owner, a.id, (trx) => trx.selectFrom("respondent_sessions").selectAll().where("id", "=", session.sessionId).executeTakeFirstOrThrow());
    expect(JSON.stringify(row)).not.toContain(ANSWER_MARKER);
    expect(row.started_at).toBeInstanceOf(Date);
    // The start report takes no body; anything sent is ignored.
    const other = await open(form.slug);
    expect((await started(other).send({ answers: { f_text: ANSWER_MARKER } })).status).toBe(204);
    const stored = await withTenant(owner, a.id, (trx) => trx.selectFrom("respondent_sessions").selectAll().where("form_id", "=", form.id).execute());
    expect(JSON.stringify(stored)).not.toContain(ANSWER_MARKER);
  });

  it("only takes a start report from the session's own capability", async () => {
    const form = await publishedForm();
    const [one, two] = [await open(form.slug), await open(form.slug)];
    expectProblem(await started(one, two.capability), 401, "SESSION_INVALID");
    expectProblem(await started(one, "not-a-capability"), 401, "SESSION_INVALID");
    expect((await analytics(form.path)).totals.starts).toBe(0);
  });

  it("needs analytics.read on the form and a sensible range", async () => {
    const form = await publishedForm();
    expectProblem(await consoleReq("analystA", "get", `${form.path}/analytics`), 404, "NOT_FOUND");
    await consoleReq("ownerA", "put", `${form.path}/grants`).send({ grants: [{ principalType: "user", principalId: users.analystA, permission: "forms.read" }] });
    expectProblem(await consoleReq("analystA", "get", `${form.path}/analytics`), 403, "FORBIDDEN");
    await consoleReq("ownerA", "put", `${form.path}/grants`).send({
      grants: [
        { principalType: "user", principalId: users.analystA, permission: "forms.read" },
        { principalType: "user", principalId: users.analystA, permission: "analytics.read" },
      ],
    });
    expect((await analytics(form.path, "", "analystA")).totals.views).toBe(0);
    expectProblem(await consoleReq("ownerB", "get", `${form.path}/analytics`), 404, "NOT_FOUND");

    for (const query of [`?from=${today()}&to=${daysAgo(1)}`, `?from=${daysAgo(400)}&to=${today()}`, "?from=yesterday", "?to=2026-02-30"]) {
      expectProblem(await consoleReq("ownerA", "get", `${form.path}/analytics${query}`), 422, "VALIDATION_FAILED");
    }
  });
});
