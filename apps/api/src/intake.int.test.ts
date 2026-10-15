import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { FormResponseSchema, ProblemSchema, PublishResponseSchema, ReceiptSchema, SessionStartResponseSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** RUN-02: the intake transaction and idempotency. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let owner: Db;
let app: Express;
let a: TenantFixture;
const tokens: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;
const consolePost = (path: string, body: object = {}) =>
  request(app).post(path).set("Cookie", `we_session=${tokens.ownerA}`).set("Origin", TEST_CONSOLE_ORIGIN).send(body);

const VALID = { f_name: "Ada", f_email: "ada@example.test", f_message: "Hello", f_consent: true };

interface Form {
  id: string;
  slug: string;
  path: string;
  versionId: string;
}

async function publishedForm(): Promise<Form> {
  const created = FormResponseSchema.parse((await consolePost(`/api/v1/organizations/${a.id}/forms`, { name: "Contact", template: "contact" })).body);
  const path = `/api/v1/organizations/${a.id}/forms/${created.form.id}`;
  return { id: created.form.id, slug: created.form.slug, path, versionId: await publish(path, created.draft.revision) };
}

async function publish(path: string, revision: number): Promise<string> {
  const res = await request(app)
    .post(`${path}/publish`)
    .set("Cookie", `we_session=${tokens.ownerA}`)
    .set("Origin", TEST_CONSOLE_ORIGIN)
    .set("If-Match", `"draft-${revision}"`)
    .set("Idempotency-Key", `key-${randomUUID()}`);
  expect(res.status).toBe(201);
  return PublishResponseSchema.parse(res.body).version.id;
}

async function startSession(slug: string, cookie?: string) {
  let req = request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN);
  if (cookie) req = req.set("Cookie", cookie);
  const res = await req;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return SessionStartResponseSchema.parse(res.body);
}

type Session = Awaited<ReturnType<typeof startSession>>;

function submit(session: Session, answers: object = VALID, key: string | null = `submit-${randomUUID()}`, versionId = session.versionId) {
  let req = request(app).post(`/public/v1/sessions/${session.sessionId}/submissions`).set("Authorization", `Bearer ${session.capability}`);
  if (key !== null) req = req.set("Idempotency-Key", key);
  return req.send({ formVersionId: versionId, answers });
}

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

const stored = (formId: string) =>
  withTenant(owner, a.id, async (trx) => ({
    submissions: await trx.selectFrom("submissions").selectAll().where("form_id", "=", formId).execute(),
    events: await trx.selectFrom("outbox_events").selectAll().where("event_type", "=", "submission.accepted.v1").where(sql<boolean>`payload @> ${JSON.stringify({ formId })}::jsonb`).execute(),
  }));

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 8 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb);
  a = createTenantFixture("Intake tenant A");
  await seedTenantFixture(db, a);
  tokens.ownerA = (await identityRepo.createSession(db, roleUser(a, "owner"), 60 * 60 * 1000)).token;
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await owner?.destroy();
});

describe("accepting a response", () => {
  it("stores the canonical answers, the receipt, the session marker and one event in one commit", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const res = await submit(session, { ...VALID, f_name: "  Ada  " });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const receipt = ReceiptSchema.parse(res.body);
    expect(receipt).toMatchObject({ intakeState: "accepted", message: "Thanks for getting in touch. We'll reply soon." });
    expect(receipt.consents).toEqual([{ fieldId: "f_consent", consentTextVersion: "contact-v1" }]);
    // No answers come back.
    expect(JSON.stringify(res.body)).not.toContain("ada@example.test");

    const { submissions, events } = await stored(f.id);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      id: receipt.submissionId,
      receipt_id: receipt.receiptId,
      form_version_id: f.versionId,
      session_id: session.sessionId,
      intake_state: "accepted",
      revision: 1,
      consents: [{ fieldId: "f_consent", consentTextVersion: "contact-v1" }],
    });
    // Canonical answers: the engine trims text.
    expect(submissions[0]!.answers).toEqual({ f_name: "Ada", f_email: "ada@example.test", f_message: "Hello", f_consent: true });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ formId: f.id, formVersionId: f.versionId, submissionId: receipt.submissionId, submissionRevision: 1 });
    expect(events[0]!.trace_id).toBe(res.headers["x-request-id"]);
    const marker = await withTenant(owner, a.id, (trx) => trx.selectFrom("respondent_sessions").select("accepted_submission_id").where("id", "=", session.sessionId).executeTakeFirstOrThrow());
    expect(marker.accepted_submission_id).toBe(receipt.submissionId);
  });

  it("returns field errors from the server engine and stores nothing", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const key = "fix-and-retry-0001";
    const res = await submit(session, { ...VALID, f_email: "not-an-email", f_consent: false, f_unknown: "x" }, key);
    expectProblem(res, 422, "VALIDATION_FAILED");
    expect(ProblemSchema.parse(res.body).errors?.map((e) => `${e.field}:${e.code}`).toSorted()).toEqual(
      ["answers.f_consent:REQUIRED", "answers.f_email:INVALID_EMAIL", "answers.f_unknown:UNKNOWN_FIELD"].toSorted(),
    );
    expect((await stored(f.id)).submissions).toEqual([]);
    // Failed requests are not recorded, so the respondent can fix the answers and resend.
    expect((await submit(session, VALID, key)).status).toBe(201);
  });

  it("keeps a session on the version it started with", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const draft = (await request(app).get(`${f.path}/draft`).set("Cookie", `we_session=${tokens.ownerA}`)).body as { revision: number; definition: object };
    const saved = await request(app)
      .put(`${f.path}/draft`)
      .set("Cookie", `we_session=${tokens.ownerA}`)
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .set("If-Match", `"draft-${draft.revision}"`)
      .send({ ...draft.definition, title: "Contact v2" });
    const v2 = await publish(f.path, saved.body.revision);

    // The browser cannot move its session to another version.
    expectProblem(await submit(session, VALID, undefined, v2), 409, "VERSION_MISMATCH");
    const res = await submit(session);
    expect(res.status).toBe(201);
    expect((await stored(f.id)).submissions[0]!.form_version_id).toBe(f.versionId);
  });
});

describe("idempotency", () => {
  it("replays the recorded receipt for the same key and refuses the key with other answers", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const first = await submit(session, VALID, "same-key-0001");
    const again = await submit(session, { f_consent: true, f_message: "Hello", f_email: "ada@example.test", f_name: "Ada" }, "same-key-0001");
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expectProblem(await submit(session, { ...VALID, f_message: "Changed" }, "same-key-0001"), 409, "IDEMPOTENCY_CONFLICT");
    const { submissions, events } = await stored(f.id);
    expect(submissions).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("gives a second request under another key the first receipt, not a second response", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const first = await submit(session);
    const second = await submit(session, { ...VALID, f_message: "Second thoughts" });
    expect(second.status).toBe(200);
    expect(second.headers["submission-already-accepted"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect((await stored(f.id)).submissions).toHaveLength(1);
  });

  it("produces one submission and one event for concurrent identical requests", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(session, VALID, "concurrent-key-0001")));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(results.filter((r) => r.headers["idempotent-replayed"] !== "true")).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.submissionId)).size).toBe(1);
    const { submissions, events } = await stored(f.id);
    expect(submissions).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("produces one submission for concurrent requests with different keys", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(session)));
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.submissionId)).size).toBe(1);
    const { submissions, events } = await stored(f.id);
    expect(submissions).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("lets separate sessions each submit once", async () => {
    const f = await publishedForm();
    const results = await Promise.all(Array.from({ length: 4 }, async () => submit(await startSession(f.slug))));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect((await stored(f.id)).submissions).toHaveLength(4);
  });
});

describe("refusals", () => {
  it("refuses a closed form, even from a session started while it was open, and accepts again after reopening", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    await consolePost(`${f.path}/close`).expect(200);
    expectProblem(await submit(session), 410, "FORM_CLOSED");
    expect((await stored(f.id)).submissions).toEqual([]);
    await consolePost(`${f.path}/reopen`).expect(200);
    expect((await submit(session)).status).toBe(201);
  });

  it("refuses a member who lost access", async () => {
    const f = await publishedForm();
    await request(app)
      .patch(`${f.path}/access-policy`)
      .set("Cookie", `we_session=${tokens.ownerA}`)
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .send({ mode: "organization" })
      .expect(200);
    const member = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `intake-${randomUUID()}` });
    await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: member, role: "analyst" }).execute());
    const token = (await identityRepo.createSession(db, member, 60 * 60 * 1000)).token;
    const session = await startSession(f.slug, `we_respondent=${token}`);
    await withTenant(db, a.id, (trx) => trx.updateTable("memberships").set({ status: "revoked" }).where("user_id", "=", member).execute());
    expectProblem(await submit(session), 403, "NOT_A_MEMBER");
    expect((await stored(f.id)).submissions).toEqual([]);
  });

  it("validates the request before touching the database", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    expectProblem(await submit(session, VALID, null), 400, "IDEMPOTENCY_KEY_REQUIRED");
    expectProblem(await submit(session, VALID, undefined, "not-a-uuid"), 422, "VALIDATION_FAILED");
    expectProblem(await submit(session, { f_message: "x".repeat(300 * 1024) }), 413, "ANSWERS_TOO_LARGE");
    const forged = { ...session, capability: "B".repeat(43) };
    expectProblem(await submit(forged), 401, "SESSION_INVALID");
    const other = await startSession(f.slug);
    expectProblem(await submit({ ...session, capability: other.capability }), 401, "SESSION_INVALID");
    expect((await stored(f.id)).submissions).toEqual([]);
  });
});

describe("storage rules", () => {
  it("never lets the public role read or change stored answers", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const receipt = ReceiptSchema.parse((await submit(session)).body);
    for (const query of [sql`SELECT answers FROM app.submissions`, sql`UPDATE app.submissions SET answers = '{}'::jsonb`, sql`DELETE FROM app.submission_requests`]) {
      await expect(withTenant(publicDb, a.id, (trx) => query.execute(trx))).rejects.toMatchObject({ code: "42501" });
    }
    // The API role (console) can read them; the binding to the session's form and version holds in the database.
    const row = await withTenant(db, a.id, (trx) => trx.selectFrom("submissions").select(["answers", "form_id"]).where("id", "=", receipt.submissionId).executeTakeFirstOrThrow());
    expect(row.form_id).toBe(f.id);
  });

  it("cannot attach a submission to another session's form or version", async () => {
    const f = await publishedForm();
    const g = await publishedForm();
    const session = await startSession(f.slug);
    await expect(
      withTenant(publicDb, a.id, (trx) =>
        trx
          .insertInto("submissions")
          .values({ id: randomUUID(), tenant_id: a.id, form_id: g.id, form_version_id: g.versionId, session_id: session.sessionId, answers: {}, receipt_id: randomUUID() })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
