import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import { scanPendingUploads, type ObjectStore } from "@workeasy/files";
import { applyRetention, processExports, purgeDeletedResponses } from "@workeasy/responses";
import type { FormDefinition } from "@workeasy/form-schema";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  AuditListResponseSchema,
  ExportSchema,
  FormResponseSchema,
  ProblemSchema,
  PublishResponseSchema,
  ResponseListResponseSchema,
  RetentionResponseSchema,
  SessionStartResponseSchema,
  UploadCreateResponseSchema,
  UploadStatusResponseSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testObjectStore, testSettings, unusedIdentityProvider } from "./test-support.js";

/** GOV-01: deletion, purge, retention, legal holds and the audit log. Needs `pnpm infra:up`. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let workerDb: Db;
let owner: Db;
let app: Express;
let store: ObjectStore;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;
const consoleReq = (who: string, method: "get" | "post" | "put" | "patch" | "delete", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);

const scanner = () => ({ host: process.env.SCANNER_HOST ?? "127.0.0.1", port: Number(process.env.SCANNER_PORT ?? 3310) });
const worker = () => ({ workerDb, store });

function definition(): FormDefinition {
  const def = blankDefinition("Claims");
  def.fields = [
    { id: "f_name", type: "text", label: "Name", required: true, settings: {} },
    { id: "f_email", type: "email", label: "Email", required: false, privacy: "personal", settings: {} },
    { id: "f_receipt", type: "file", label: "Receipt", required: false, settings: { allowedMimeTypes: ["text/plain"], maxFileBytes: 4096, maxFiles: 1 } },
  ];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_name", "f_email", "f_receipt"] }];
  return def;
}

async function form(tenant = a, who = "ownerA") {
  const created = FormResponseSchema.parse((await consoleReq(who, "post", `/api/v1/organizations/${tenant.id}/forms`).send({ name: "Claims" })).body);
  const path = `/api/v1/organizations/${tenant.id}/forms/${created.form.id}`;
  const saved = await consoleReq(who, "put", `${path}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(definition());
  const published = await consoleReq(who, "post", `${path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `key-${randomUUID()}`);
  expect(published.status).toBe(201);
  return { id: created.form.id, slug: created.form.slug, path, versionId: PublishResponseSchema.parse(published.body).version.id };
}

/** Uploads a text file for the session and waits for its scan; returns the upload ID. */
async function uploadText(sessionId: string, auth: Record<string, string>, text: string): Promise<string> {
  const bytes = Buffer.from(text);
  const target = UploadCreateResponseSchema.parse(
    (await request(app).post(`/public/v1/sessions/${sessionId}/uploads`).set(auth).send({ fieldId: "f_receipt", fileName: "receipt.txt", contentType: "text/plain", bytes: bytes.length })).body,
  );
  expect((await fetch(target.uploadUrl, { method: "PUT", headers: target.headers, body: bytes })).status).toBe(200);
  await request(app).post(`/public/v1/sessions/${sessionId}/uploads/${target.uploadId}/complete`).set(auth).expect(202);
  // Other test files scan concurrently and may hold the claim for a moment, so wait for this upload to settle.
  const deadline = Date.now() + 15_000;
  for (;;) {
    while ((await scanPendingUploads({ workerDb, store, scanner: scanner() }, 20)) > 0);
    const { state } = UploadStatusResponseSchema.parse((await request(app).get(`/public/v1/sessions/${sessionId}/uploads/${target.uploadId}`).set(auth)).body);
    if (state !== "pending_scan" && state !== "scanning") return target.uploadId;
    if (Date.now() > deadline) throw new Error(`upload ${target.uploadId} is still ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A response, optionally with an attached, scanned file; returns its ID and the upload's ID. */
async function respond(slug: string, name: string, email: string, fileText?: string) {
  const session = SessionStartResponseSchema.parse((await request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body);
  const auth = { Authorization: `Bearer ${session.capability}` };
  const files = fileText ? [await uploadText(session.sessionId, auth, fileText)] : [];
  const res = await request(app)
    .post(`/public/v1/sessions/${session.sessionId}/submissions`)
    .set(auth)
    .set("Idempotency-Key", `k-${randomUUID()}`)
    .send({ formVersionId: session.versionId, answers: { f_name: name, f_email: email, ...(files.length ? { f_receipt: files } : {}) } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { submissionId: res.body.submissionId as string, uploadId: files[0] };
}

async function purgeAll() {
  while ((await purgeDeletedResponses(worker(), 50)) > 0);
}

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

const submissionRow = (id: string) =>
  withTenant(owner, a.id, (trx) => trx.selectFrom("submissions").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
const uploadRow = (id: string) =>
  withTenant(owner, a.id, (trx) => trx.selectFrom("file_uploads").select(["state", "storage_key", "file_name"]).where("id", "=", id).executeTakeFirstOrThrow());

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 4 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 2 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  store = testObjectStore();
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb, unusedIdentityProvider, store);
  a = createTenantFixture("Governance tenant A");
  b = createTenantFixture("Governance tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  const creator = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `gov-${randomUUID()}` });
  await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: creator, role: "creator" }).execute());
  for (const [name, id] of [
    ["ownerA", roleUser(a, "owner")],
    ["analystA", roleUser(a, "analyst")],
    ["creatorA", creator],
    ["ownerB", roleUser(b, "owner")],
  ] as const) {
    users[name] = id;
    tokens[name] = (await identityRepo.createSession(db, id, 60 * 60 * 1000)).token;
  }
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await workerDb?.destroy();
  await owner?.destroy();
});

describe("deleting a response", () => {
  it("hides it at once, then purges its answers, receipts, files and every export copy, leaving a tombstone", async () => {
    const f = await form();
    const doomed = await respond(f.slug, "Doomed Person", "doomed@example.test", "doomed receipt contents");
    const kept = await respond(f.slug, "Kept Person", "kept@example.test", "kept receipt contents");
    const exported = ExportSchema.parse((await consoleReq("ownerA", "post", `${f.path}/exports`).send({})).body);
    while ((await processExports(worker(), 10)) > 0);
    expect(await store.head(store.exportsBucket, exported.id)).toBeDefined();
    const doomedFile = await uploadRow(doomed.uploadId!);

    const res = await consoleReq("ownerA", "delete", `${f.path}/submissions/${doomed.submissionId}`).send({ reason: "Respondent asked us to erase it" });
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    // Gone for readers before any purge has run.
    const list = ResponseListResponseSchema.parse((await consoleReq("ownerA", "get", `${f.path}/submissions`)).body);
    expect(list.items.map((i) => i.id)).toEqual([kept.submissionId]);
    expect(list.total).toBe(1);
    expectProblem(await consoleReq("ownerA", "get", `${f.path}/submissions/${doomed.submissionId}`), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerA", "get", `${f.path}/submissions/${doomed.submissionId}/files/${doomed.uploadId}`), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerA", "delete", `${f.path}/submissions/${doomed.submissionId}`).send({ reason: "again" }), 404, "NOT_FOUND");

    await purgeAll();

    const tombstone = await submissionRow(doomed.submissionId);
    expect(tombstone).toMatchObject({ answers: {}, consents: [], deletion_reason: "Respondent asked us to erase it", deleted_by: users.ownerA });
    expect(tombstone.purged_at).toBeInstanceOf(Date);
    const receipts = await withTenant(owner, a.id, (trx) => trx.selectFrom("submission_requests").select("submission_id").where("submission_id", "=", doomed.submissionId).execute());
    expect(receipts).toEqual([]);
    expect(await uploadRow(doomed.uploadId!)).toMatchObject({ state: "purged", file_name: "purged" });
    expect(await store.head(store.cleanBucket, doomedFile.storage_key)).toBeUndefined();
    // The export made before the deletion contained the response: it is gone too.
    expect(await store.head(store.exportsBucket, exported.id)).toBeUndefined();
    expect(ExportSchema.parse((await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/exports/${exported.id}`)).body).state).toBe("purged");
    expectProblem(await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/exports/${exported.id}/download`), 409, "EXPORT_NOT_READY");

    // The other response and its file are untouched.
    expect((await submissionRow(kept.submissionId)).answers).toMatchObject({ f_name: "Kept Person" });
    expect(await store.head(store.cleanBucket, (await uploadRow(kept.uploadId!)).storage_key)).toBeDefined();
  });

  it("needs responses.delete and stays inside the organization", async () => {
    const f = await form();
    const r = await respond(f.slug, "Someone", "someone@example.test");
    await consoleReq("ownerA", "put", `${f.path}/grants`).send({ grants: [{ principalType: "user", principalId: users.analystA, permission: "responses.read" }] }).expect(200);
    expectProblem(await consoleReq("analystA", "delete", `${f.path}/submissions/${r.submissionId}`).send({ reason: "no right" }), 403, "FORBIDDEN");
    expectProblem(await consoleReq("ownerB", "delete", `${f.path}/submissions/${r.submissionId}`).send({ reason: "no right" }), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerA", "delete", `${f.path}/submissions/${r.submissionId}`).send({}), 422, "VALIDATION_FAILED");
  });
});

describe("legal hold", () => {
  it("blocks deletion, retention and purge until released, and only owners and admins can set it", async () => {
    const f = await form();
    const early = await respond(f.slug, "Early", "early@example.test");
    // Deleted before the hold: the purge must wait for the hold to be released.
    await consoleReq("ownerA", "delete", `${f.path}/submissions/${early.submissionId}`).send({ reason: "Asked to erase" }).expect(202);
    const held = await respond(f.slug, "Held", "held@example.test");

    // A creator with publish rights can change retention, not the hold.
    await consoleReq("ownerA", "put", `${f.path}/grants`)
      .send({ grants: [{ principalType: "user", principalId: users.creatorA, permission: "forms.publish" }] })
      .expect(200);
    expectProblem(await consoleReq("creatorA", "patch", `${f.path}/retention`).send({ legalHold: true }), 403, "FORBIDDEN");
    expect(RetentionResponseSchema.parse((await consoleReq("creatorA", "patch", `${f.path}/retention`).send({ retentionDays: 30 })).body)).toEqual({ retentionDays: 30, legalHold: false });
    expect(RetentionResponseSchema.parse((await consoleReq("ownerA", "patch", `${f.path}/retention`).send({ legalHold: true })).body).legalHold).toBe(true);

    expectProblem(await consoleReq("ownerA", "delete", `${f.path}/submissions/${held.submissionId}`).send({ reason: "Try anyway" }), 409, "LEGAL_HOLD");
    expectProblem(await consoleReq("ownerA", "delete", f.path).send({ reason: "Try anyway" }), 409, "LEGAL_HOLD");
    await withTenant(owner, a.id, (trx) => sql`UPDATE app.submissions SET received_at = now() - interval '400 days' WHERE id = ${held.submissionId}`.execute(trx));
    await applyRetention(worker());
    await purgeAll();
    expect((await submissionRow(held.submissionId)).deleted_at).toBeNull();
    expect((await submissionRow(early.submissionId)).purged_at).toBeNull();

    await consoleReq("ownerA", "patch", `${f.path}/retention`).send({ legalHold: false }).expect(200);
    await purgeAll();
    expect((await submissionRow(early.submissionId)).purged_at).toBeInstanceOf(Date);
  });
});

describe("retention", () => {
  it("deletes and purges responses older than the form's retention period, as the system", async () => {
    const f = await form();
    const old = await respond(f.slug, "Old", "old@example.test");
    const recent = await respond(f.slug, "Recent", "recent@example.test");
    await consoleReq("ownerA", "patch", `${f.path}/retention`).send({ retentionDays: 30 }).expect(200);
    await withTenant(owner, a.id, (trx) => sql`UPDATE app.submissions SET received_at = now() - interval '31 days' WHERE id = ${old.submissionId}`.execute(trx));

    expect(await applyRetention(worker())).toBeGreaterThanOrEqual(1);
    await purgeAll();
    expect(await submissionRow(old.submissionId)).toMatchObject({ answers: {}, deletion_reason: "Retention period ended", deleted_by: null });
    expect((await submissionRow(recent.submissionId)).deleted_at).toBeNull();

    const audit = AuditListResponseSchema.parse((await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/audit`).query({ resourceId: f.id, action: "responses.retention_deleted" })).body);
    expect(audit.items[0]).toMatchObject({ actor: { type: "system", id: null }, metadata: { count: 1 } });
    expectProblem(await consoleReq("ownerA", "patch", `${f.path}/retention`).send({ retentionDays: 0 }), 422, "VALIDATION_FAILED");
  });
});

describe("deleting a form", () => {
  it("removes the form for everyone and purges all its responses", async () => {
    const f = await form();
    const r1 = await respond(f.slug, "One", "one@example.test", "one");
    const r2 = await respond(f.slug, "Two", "two@example.test");
    expectProblem(await consoleReq("creatorA", "delete", f.path).send({ reason: "Not mine" }), 404, "NOT_FOUND");
    const res = await consoleReq("ownerA", "delete", f.path).send({ reason: "Campaign finished" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ deleted: true, responses: 2 });
    expectProblem(await consoleReq("ownerA", "get", f.path), 404, "NOT_FOUND");
    expectProblem(await request(app).get(`/public/v1/forms/${f.slug}`), 404, "NOT_FOUND");
    await purgeAll();
    for (const r of [r1, r2]) expect((await submissionRow(r.submissionId)).purged_at).toBeInstanceOf(Date);
    expect((await uploadRow(r1.uploadId!)).state).toBe("purged");
  });
});

describe("audit log", () => {
  it("records governance and access changes with identifiers only, never answers", async () => {
    const f = await form();
    const r = await respond(f.slug, "Very Private Name", "private@example.test", "private file text");
    await consoleReq("ownerA", "put", `${f.path}/grants`).send({ grants: [{ principalType: "user", principalId: users.analystA, permission: "responses.read" }] }).expect(200);
    await consoleReq("ownerA", "delete", `${f.path}/submissions/${r.submissionId}`).send({ reason: "Privacy request from Very Private Name" }).expect(202);
    await purgeAll();

    const entries = AuditListResponseSchema.parse((await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/audit`).query({ limit: 100 })).body).items;
    const actions = entries.filter((e) => e.resourceId === f.id || e.resourceId === r.submissionId).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["form.created", "form.published", "form.grants_changed", "response.deleted", "response.purged"]));
    // Replacing the grants also removed the creator grants the owner got when creating the form.
    const change = entries.find((e) => e.action === "form.grants_changed" && e.resourceId === f.id)?.metadata as { added: unknown[]; removed: unknown[] };
    expect(change.added).toEqual([{ principalId: users.analystA, permission: "responses.read" }]);
    expect(change.removed).toHaveLength(3);
    expect(change.removed).toEqual(
      expect.arrayContaining(["forms.edit", "forms.publish", "forms.manage_access"].map((permission) => ({ principalId: users.ownerA, permission }))),
    );
    expect(entries.find((e) => e.action === "response.purged")?.metadata).toMatchObject({ formId: f.id, files: 1 });

    // Nothing anyone answered, uploaded or wrote as a reason appears anywhere in the tenant's audit log.
    const everything = await withTenant(owner, a.id, (trx) => trx.selectFrom("audit_events").selectAll().execute());
    const text = JSON.stringify(everything);
    for (const secret of ["Very Private Name", "private@example.test", "private file text", "receipt.txt", "Privacy request"]) expect(text).not.toContain(secret);
  });

  it("pages, filters and stays with owners and admins of the organization", async () => {
    const first = AuditListResponseSchema.parse((await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/audit`).query({ limit: 2 })).body);
    expect(first.items).toHaveLength(2);
    const second = AuditListResponseSchema.parse((await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/audit`).query({ limit: 2, cursor: first.nextCursor! })).body);
    expect(second.items.map((i) => i.id)).not.toContain(first.items[0]!.id);
    expect(Date.parse(second.items[0]!.occurredAt)).toBeLessThanOrEqual(Date.parse(first.items[1]!.occurredAt));
    const deletions = AuditListResponseSchema.parse((await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/audit`).query({ action: "response.deleted" })).body);
    expect(deletions.items.every((i) => i.action === "response.deleted")).toBe(true);

    expectProblem(await consoleReq("analystA", "get", `/api/v1/organizations/${a.id}/audit`), 403, "FORBIDDEN");
    expectProblem(await consoleReq("ownerB", "get", `/api/v1/organizations/${a.id}/audit`), 404, "NOT_FOUND");
    expect(AuditListResponseSchema.parse((await consoleReq("ownerB", "get", `/api/v1/organizations/${b.id}/audit`)).body).items.every((i) => i.resourceId !== a.id)).toBe(true);
    expectProblem(await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/audit`).query({ cursor: "nope" }), 422, "VALIDATION_FAILED");
  });
});
