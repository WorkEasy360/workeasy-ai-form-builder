import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  FormResponseSchema,
  ProblemSchema,
  PublishResponseSchema,
  ResponseDetailResponseSchema,
  ResponseListResponseSchema,
  SessionStartResponseSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** RES-01: response list and detail, keyset pagination and field masks. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let owner: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;
const consoleReq = (who: string, method: "get" | "post" | "put", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);

function surveyDefinition(topicLabel = "Topic"): FormDefinition {
  const def = blankDefinition("Feedback");
  def.fields = [
    { id: "f_topic", type: "radio", label: topicLabel, required: true, settings: { options: [{ id: "opt_billing", label: "Billing" }, { id: "opt_bugs", label: "Bugs" }] } },
    { id: "f_name", type: "text", label: "Name", required: false, privacy: "ordinary", settings: {} },
    { id: "f_email", type: "email", label: "Email", required: false, privacy: "personal", settings: {} },
    { id: "f_health", type: "textarea", label: "Health notes", required: false, privacy: "sensitive", settings: {} },
  ];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_topic", "f_name", "f_email", "f_health"] }];
  return def;
}

async function saveAndPublish(path: string, definition: FormDefinition) {
  const draft = (await consoleReq("ownerA", "get", `${path}/draft`)).body as { revision: number };
  const saved = await consoleReq("ownerA", "put", `${path}/draft`).set("If-Match", `"draft-${draft.revision}"`).send(definition);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const published = await consoleReq("ownerA", "post", `${path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `key-${randomUUID()}`);
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  return PublishResponseSchema.parse(published.body).version.id;
}

async function surveyForm() {
  const created = FormResponseSchema.parse((await consoleReq("ownerA", "post", `/api/v1/organizations/${a.id}/forms`).send({ name: "Feedback" })).body);
  const path = `/api/v1/organizations/${a.id}/forms/${created.form.id}`;
  const versionId = await saveAndPublish(path, surveyDefinition());
  return { id: created.form.id, slug: created.form.slug, path, versionId };
}

async function respond(slug: string, answers: Record<string, unknown>) {
  const session = SessionStartResponseSchema.parse((await request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body);
  const res = await request(app)
    .post(`/public/v1/sessions/${session.sessionId}/submissions`)
    .set("Authorization", `Bearer ${session.capability}`)
    .set("Idempotency-Key", `k-${randomUUID()}`)
    .send({ formVersionId: session.versionId, answers });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.submissionId as string;
}

const answersFor = (i: number) => ({
  f_topic: i % 2 === 0 ? "opt_billing" : "opt_bugs",
  f_name: `Person ${i}`,
  f_email: `person${i}@example.test`,
  f_health: `Private note ${i}`,
});

const list = (who: string, path: string, query: Record<string, string | number> = {}) => consoleReq(who, "get", `${path}/submissions`).query(query);

async function grant(path: string, userId: string, permissions: string[]) {
  const res = await consoleReq("ownerA", "put", `${path}/grants`).send({ grants: permissions.map((permission) => ({ principalType: "user", principalId: userId, permission })) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

async function addMember(role: "analyst" | "creator") {
  const userId = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `responses-${randomUUID()}` });
  await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: userId, role }).execute());
  return userId;
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 4 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb);
  a = createTenantFixture("Responses tenant A");
  b = createTenantFixture("Responses tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  const people: Array<[string, string]> = [
    ["ownerA", roleUser(a, "owner")],
    ["ownerB", roleUser(b, "owner")],
    ["reader", await addMember("analyst")],
    ["personalReader", await addMember("analyst")],
    ["creator", await addMember("creator")],
  ];
  for (const [name, id] of people) {
    users[name] = id;
    tokens[name] = (await identityRepo.createSession(db, id, 60 * 60 * 1000)).token;
  }
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await owner?.destroy();
});

describe("keyset pagination", () => {
  it("returns every response exactly once, newest first, even with equal timestamps and new arrivals between pages", async () => {
    const f = await surveyForm();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await respond(f.slug, answersFor(i)));
    // Three responses share one timestamp: the ID breaks the tie.
    await withTenant(owner, a.id, (trx) =>
      sql`UPDATE app.submissions SET received_at = now() - interval '1 hour' WHERE id IN (${sql.join(ids.slice(2, 5))})`.execute(trx),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    let first: ReturnType<typeof ResponseListResponseSchema.parse> | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await list("ownerA", f.path, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = ResponseListResponseSchema.parse(res.body);
      first ??= body;
      expect(body.total).toBe(7);
      expect(body.cutoff).toBe(first.cutoff);
      seen.push(...body.items.map((i) => i.id));
      // Responses arriving after the first page belong to the next listing, not this one.
      if (page === 0) for (let i = 0; i < 2; i++) await respond(f.slug, answersFor(100 + i));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.toSorted()).toEqual(ids.toSorted());
    expect(new Set(seen).size).toBe(7);

    // Newest first; within the tied timestamp, by ID descending.
    const rows = await withTenant(owner, a.id, (trx) =>
      trx.selectFrom("submissions").select(["id", "received_at"]).where("id", "in", ids).orderBy("received_at", "desc").orderBy("id", "desc").execute(),
    );
    expect(seen).toEqual(rows.map((r) => r.id));

    const fresh = ResponseListResponseSchema.parse((await list("ownerA", f.path, { limit: 100 })).body);
    expect(fresh.total).toBe(9);
    expect(fresh.items).toHaveLength(9);
  });

  it("refuses a tampered cursor", async () => {
    const f = await surveyForm();
    expectProblem(await list("ownerA", f.path, { cursor: "not-a-cursor" }), 422, "VALIDATION_FAILED");
  });
});

describe("field masks", () => {
  it("shows each reviewer only the classes of fields they are cleared for", async () => {
    const f = await surveyForm();
    await respond(f.slug, answersFor(1));
    await grant(f.path, users.reader!, ["responses.read"]);
    const res = await consoleReq("ownerA", "put", `${f.path}/grants`).send({
      grants: [
        { principalType: "user", principalId: users.reader, permission: "responses.read" },
        { principalType: "user", principalId: users.personalReader, permission: "responses.read" },
        { principalType: "user", principalId: users.personalReader, permission: "responses.read_personal" },
      ],
    });
    expect(res.status).toBe(200);

    const masked = (who: string) => list(who, f.path).then((r) => ResponseListResponseSchema.parse(r.body));
    const reader = await masked("reader");
    expect(reader.columns.map((c) => [c.fieldId, c.masked])).toEqual([
      ["f_topic", false],
      ["f_name", false],
      ["f_email", true],
      ["f_health", true],
    ]);
    expect(reader.items[0]!.answers).toEqual({
      f_topic: { masked: false, value: "opt_bugs", display: "Bugs" },
      f_name: { masked: false, value: "Person 1", display: "Person 1" },
      f_email: { masked: true },
      f_health: { masked: true },
    });
    // Hidden values are not in the response at all.
    const raw = JSON.stringify((await list("reader", f.path)).body);
    expect(raw).not.toContain("person1@example.test");
    expect(raw).not.toContain("Private note");

    const personal = await masked("personalReader");
    expect(personal.items[0]!.answers.f_email).toEqual({ masked: false, value: "person1@example.test", display: "person1@example.test" });
    expect(personal.items[0]!.answers.f_health).toEqual({ masked: true });

    const all = await masked("ownerA");
    expect(all.items[0]!.answers.f_health).toMatchObject({ masked: false, display: "Private note 1" });

    // The same masks apply to one response.
    const detail = ResponseDetailResponseSchema.parse((await consoleReq("reader", "get", `${f.path}/submissions/${reader.items[0]!.id}`)).body);
    expect(detail.fields.map((x) => [x.fieldId, x.answer.masked])).toEqual([
      ["f_topic", false],
      ["f_name", false],
      ["f_email", true],
      ["f_health", true],
    ]);
    expect(JSON.stringify(detail)).not.toContain("person1@example.test");
  });

  it("refuses filters on fields the reviewer cannot see, so hidden answers cannot be guessed", async () => {
    const f = await surveyForm();
    await respond(f.slug, answersFor(1));
    await grant(f.path, users.reader!, ["responses.read"]);
    expectProblem(await list("reader", f.path, { field: "f_email", op: "contains", value: "person1" }), 422, "VALIDATION_FAILED");
    expect(ProblemSchema.parse((await list("reader", f.path, { field: "f_health", op: "isEmpty" })).body).errors?.[0]?.code).toBe("FIELD_MASKED");
  });
});

describe("filters", () => {
  it("filters by answer, date and version with parameterized values", async () => {
    const f = await surveyForm();
    for (let i = 0; i < 4; i++) await respond(f.slug, answersFor(i));
    await respond(f.slug, { f_topic: "opt_bugs", f_name: "100% O'Brien; DROP TABLE x" });
    const ids = (q: Record<string, string>) => list("ownerA", f.path, q).then((r) => ResponseListResponseSchema.parse(r.body).items.length);

    expect(await ids({ field: "f_topic", op: "eq", value: "opt_billing" })).toBe(2);
    expect(await ids({ field: "f_name", op: "contains", value: "person" })).toBe(4);
    expect(await ids({ field: "f_name", op: "contains", value: "100%" })).toBe(1);
    expect(await ids({ field: "f_name", op: "contains", value: "_" })).toBe(0);
    expect(await ids({ field: "f_email", op: "isEmpty" })).toBe(1);
    expect(await ids({ field: "f_email", op: "isNotEmpty" })).toBe(4);
    expect(await ids({ to: new Date(Date.now() - 60 * 60 * 1000).toISOString() })).toBe(0);
    expect(await ids({ version: f.versionId })).toBe(5);

    expectProblem(await list("ownerA", f.path, { field: "f_nope", op: "isEmpty" }), 422, "VALIDATION_FAILED");
    expectProblem(await list("ownerA", f.path, { field: "f_name", op: "eq" }), 422, "VALIDATION_FAILED");
    expectProblem(await list("ownerA", f.path, { version: randomUUID() }), 422, "VALIDATION_FAILED");
  });
});

describe("versions and access", () => {
  it("shows each response with its own version's labels, and only to readers in the organization", async () => {
    const f = await surveyForm();
    const old = await respond(f.slug, answersFor(0));
    await saveAndPublish(f.path, surveyDefinition("What is it about?"));
    const fresh = await respond(f.slug, answersFor(1));

    const oldDetail = ResponseDetailResponseSchema.parse((await consoleReq("ownerA", "get", `${f.path}/submissions/${old}`)).body);
    expect(oldDetail).toMatchObject({ version: { versionNumber: 1, active: false }, respondent: { kind: "anonymous" } });
    expect(oldDetail.fields[0]).toMatchObject({ label: "Topic", answer: { display: "Billing" } });
    const newDetail = ResponseDetailResponseSchema.parse((await consoleReq("ownerA", "get", `${f.path}/submissions/${fresh}`)).body);
    expect(newDetail.fields[0]).toMatchObject({ label: "What is it about?", answer: { display: "Bugs" } });
    // The list's columns use the live version's labels.
    expect(ResponseListResponseSchema.parse((await list("ownerA", f.path)).body).columns[0]!.label).toBe("What is it about?");

    // Building a form does not grant response access.
    await consoleReq("ownerA", "put", `${f.path}/grants`).send({ grants: [{ principalType: "user", principalId: users.creator, permission: "forms.edit" }] }).expect(200);
    expectProblem(await list("creator", f.path), 403, "FORBIDDEN");
    expectProblem(await consoleReq("creator", "get", `${f.path}/submissions/${old}`), 403, "FORBIDDEN");
    expectProblem(await list("ownerB", f.path), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerB", "get", `/api/v1/organizations/${b.id}/forms/${f.id}/submissions/${old}`), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerA", "get", `${f.path}/submissions/${randomUUID()}`), 404, "NOT_FOUND");
  });
});
