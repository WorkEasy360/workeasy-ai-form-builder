import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { AccessPolicyResponseSchema, FormResponseSchema, ProblemSchema, PublishResponseSchema, SessionStartResponseSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** RUN-03: response limits, schedules and the tenant's monthly quota. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let owner: Db;
let app: Express;
const tokens: Record<string, string> = {};

const VALID = { f_name: "Ada", f_email: "ada@example.test", f_message: "Hello", f_consent: true };
const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;

async function tenant(name: string) {
  const fixture = createTenantFixture(name);
  await seedTenantFixture(db, fixture);
  tokens[fixture.id] = (await identityRepo.createSession(db, roleUser(fixture, "owner"), 60 * 60 * 1000)).token;
  return fixture;
}

const consoleReq = (t: TenantFixture, method: "post" | "patch" | "get", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[t.id]}`).set("Origin", TEST_CONSOLE_ORIGIN);

async function publishedForm(t: TenantFixture) {
  const created = FormResponseSchema.parse((await consoleReq(t, "post", `/api/v1/organizations/${t.id}/forms`).send({ name: "Limited", template: "contact" })).body);
  const path = `/api/v1/organizations/${t.id}/forms/${created.form.id}`;
  const published = await consoleReq(t, "post", `${path}/publish`).set("If-Match", `"draft-${created.draft.revision}"`).set("Idempotency-Key", `key-${randomUUID()}`);
  expect(published.status).toBe(201);
  return { id: created.form.id, slug: created.form.slug, path, versionId: PublishResponseSchema.parse(published.body).version.id };
}

const setPolicy = (t: TenantFixture, path: string, body: object) => consoleReq(t, "patch", `${path}/access-policy`).send(body);

async function startSession(slug: string) {
  const res = await request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return SessionStartResponseSchema.parse(res.body);
}

const submit = (session: { sessionId: string; capability: string; versionId: string }, answers: object = VALID, key = `k-${randomUUID()}`) =>
  request(app)
    .post(`/public/v1/sessions/${session.sessionId}/submissions`)
    .set("Authorization", `Bearer ${session.capability}`)
    .set("Idempotency-Key", key)
    .send({ formVersionId: session.versionId, answers });

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

const counts = (t: TenantFixture, formId: string) =>
  withTenant(owner, t.id, async (trx) => ({
    submissions: Number((await trx.selectFrom("submissions").select((eb) => eb.fn.countAll<string>().as("n")).where("form_id", "=", formId).executeTakeFirstOrThrow()).n),
    counter: (await trx.selectFrom("form_response_counters").select("accepted").where("form_id", "=", formId).executeTakeFirst())?.accepted ?? 0,
    events: Number(
      (
        await trx
          .selectFrom("outbox_events")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("event_type", "=", "submission.accepted.v1")
          .where(sql<boolean>`payload @> ${JSON.stringify({ formId })}::jsonb`)
          .executeTakeFirstOrThrow()
      ).n,
    ),
  }));

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 12 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb);
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await owner?.destroy();
});

describe("form response limit", () => {
  it("never accepts more than the limit when many respondents submit for the last slots at once", async () => {
    const t = await tenant("Quota last slot");
    const f = await publishedForm(t);
    expect((await setPolicy(t, f.path, { maxResponses: 3 })).status).toBe(200);
    const sessions = await Promise.all(Array.from({ length: 10 }, () => startSession(f.slug)));
    const results = await Promise.all(sessions.map((s) => submit(s)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    for (const res of results.filter((r) => r.status !== 201)) expectProblem(res, 410, "FORM_FULL");
    expect(await counts(t, f.id)).toEqual({ submissions: 3, counter: 3, events: 3 });

    // Once full, the form says so up front.
    expectProblem(await request(app).get(`/public/v1/forms/${f.slug}`), 410, "FORM_FULL");
    expectProblem(await request(app).post(`/public/v1/forms/${f.slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN), 410, "FORM_FULL");
    const policy = AccessPolicyResponseSchema.parse((await consoleReq(t, "get", `${f.path}/access-policy`)).body);
    expect(policy).toMatchObject({ maxResponses: 3, acceptedResponses: 3 });

    // Raising the limit reopens it.
    await setPolicy(t, f.path, { maxResponses: 4 });
    expect((await submit(await startSession(f.slug))).status).toBe(201);
  });

  it("counts responses stored before the limit was set", async () => {
    const t = await tenant("Quota seeded");
    const f = await publishedForm(t);
    for (let i = 0; i < 2; i++) expect((await submit(await startSession(f.slug))).status).toBe(201);
    const pending = await startSession(f.slug);
    await setPolicy(t, f.path, { maxResponses: 2 });
    expectProblem(await submit(pending), 410, "FORM_FULL");
    expect((await counts(t, f.id)).submissions).toBe(2);
  });

  it("does not spend the limit on invalid answers or replays", async () => {
    const t = await tenant("Quota no waste");
    const f = await publishedForm(t);
    await setPolicy(t, f.path, { maxResponses: 1 });
    const session = await startSession(f.slug);
    expectProblem(await submit(session, { ...VALID, f_email: "nope" }), 422, "VALIDATION_FAILED");
    const first = await submit(session, VALID, "only-key-0001");
    expect(first.status).toBe(201);
    const replay = await submit(session, VALID, "only-key-0001");
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(await counts(t, f.id)).toEqual({ submissions: 1, counter: 1, events: 1 });
  });
});

describe("tenant monthly quota", () => {
  it("caps responses across all of a tenant's forms, atomically, and says when to retry", async () => {
    const t = await tenant("Quota monthly");
    await withTenant(owner, t.id, (trx) =>
      trx.updateTable("tenants").set({ settings: { limits: { responsesPerMonth: 2 } } }).where("id", "=", t.id).execute(),
    );
    const [f, g] = [await publishedForm(t), await publishedForm(t)];
    const sessions = [...(await Promise.all([1, 2, 3].map(() => startSession(f.slug)))), ...(await Promise.all([1, 2, 3].map(() => startSession(g.slug))))];
    const results = await Promise.all(sessions.map((s) => submit(s)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    for (const res of results.filter((r) => r.status !== 201)) {
      expectProblem(res, 429, "RESPONSE_QUOTA_REACHED");
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    }
    const [cf, cg] = [await counts(t, f.id), await counts(t, g.id)];
    expect(cf.submissions + cg.submissions).toBe(2);
    expect(cf.counter + cg.counter).toBe(2);
    const bucket = await withTenant(owner, t.id, (trx) => trx.selectFrom("usage_buckets").selectAll().where("tenant_id", "=", t.id).executeTakeFirstOrThrow());
    expect(bucket).toMatchObject({ metric: "responses", consumed: 2, limit_value: 2 });
    expectProblem(await request(app).get(`/public/v1/forms/${f.slug}`), 429, "RESPONSE_QUOTA_REACHED");
  });

  it("leaves other tenants unaffected", async () => {
    const t = await tenant("Quota neighbour");
    const f = await publishedForm(t);
    expect((await submit(await startSession(f.slug))).status).toBe(201);
  });
});

describe("schedule", () => {
  it("is not open before its opening time and closes at its closing time, even for open pages", async () => {
    const t = await tenant("Quota schedule");
    const f = await publishedForm(t);
    const opensAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await setPolicy(t, f.path, { openAt: opensAt });
    const early = await request(app).get(`/public/v1/forms/${f.slug}`);
    expectProblem(early, 409, "FORM_NOT_OPEN");
    expect(ProblemSchema.parse(early.body).opensAt).toBe(opensAt);
    expectProblem(await request(app).post(`/public/v1/forms/${f.slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN), 409, "FORM_NOT_OPEN");

    await setPolicy(t, f.path, { openAt: null, closeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    const page = await request(app).get(`/public/v1/forms/${f.slug}`);
    expect(page.status).toBe(200);
    // Scheduled forms change state without a publish, so they are not cached.
    expect(page.headers["cache-control"]).toBe("private, no-store");
    const session = await startSession(f.slug);

    await setPolicy(t, f.path, { closeAt: new Date(Date.now() - 1000).toISOString() });
    expectProblem(await submit(session), 410, "FORM_CLOSED");
    expectProblem(await request(app).get(`/public/v1/forms/${f.slug}`), 410, "FORM_CLOSED");
    expect((await counts(t, f.id)).submissions).toBe(0);
  });
});

describe("policy changes", () => {
  it("merges partial changes, validates them and audits what changed", async () => {
    const t = await tenant("Quota policy");
    const f = await publishedForm(t);
    await setPolicy(t, f.path, { mode: "organization" });
    const res = await setPolicy(t, f.path, { maxResponses: 50 });
    expect(AccessPolicyResponseSchema.parse(res.body)).toEqual({ mode: "organization", maxResponses: 50, openAt: null, closeAt: null, acceptedResponses: 0 });

    const open = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    expectProblem(await setPolicy(t, f.path, { openAt: open, closeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }), 422, "VALIDATION_FAILED");
    expectProblem(await setPolicy(t, f.path, { maxResponses: 0 }), 422, "VALIDATION_FAILED");
    expectProblem(await setPolicy(t, f.path, {}), 422, "VALIDATION_FAILED");
    expect(AccessPolicyResponseSchema.parse((await setPolicy(t, f.path, { maxResponses: null })).body).maxResponses).toBeNull();

    const audit = await withTenant(owner, t.id, (trx) =>
      trx.selectFrom("audit_events").select("metadata").where("resource_id", "=", f.id).where("action", "=", "form.access_policy_changed").orderBy("occurred_at").orderBy("id").execute(),
    );
    expect(audit.map((a) => a.metadata)).toEqual([
      { changed: { mode: "organization" }, previous: { mode: "public" } },
      { changed: { maxResponses: 50 }, previous: { maxResponses: null } },
      { changed: { maxResponses: null }, previous: { maxResponses: 50 } },
    ]);
  });

  it("keeps counters out of the public role's reach", async () => {
    const t = await tenant("Quota counters");
    const f = await publishedForm(t);
    expect((await submit(await startSession(f.slug))).status).toBe(201);
    for (const query of [sql`UPDATE app.form_response_counters SET accepted = 0`, sql`UPDATE app.usage_buckets SET consumed = 0`, sql`SELECT * FROM app.usage_buckets`]) {
      await expect(withTenant(publicDb, t.id, (trx) => query.execute(trx))).rejects.toMatchObject({ code: "42501" });
    }
    // The reservation function refuses to run without a tenant context.
    await expect(sql`SELECT app.reserve_response(${f.id}::uuid)`.execute(publicDb)).rejects.toMatchObject({ code: "42501" });
  });
});
