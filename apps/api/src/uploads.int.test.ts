import { randomUUID } from "node:crypto";
import { createDb, identityRepo, uploadsRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import { expireStaleUploads, processScanJob, scanPendingUploads, SCAN_LEASE_SECONDS, type ObjectStore, type ScanDeps } from "@workeasy/files";
import type { FormDefinition } from "@workeasy/form-schema";
import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  FileDownloadResponseSchema,
  FormResponseSchema,
  ProblemSchema,
  PublishResponseSchema,
  SessionStartResponseSchema,
  UploadCreateResponseSchema,
  UploadStatusResponseSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testObjectStore, testSettings, unusedIdentityProvider } from "./test-support.js";

/** FIL-01: uploads, quarantine, scanning, claiming and authorized downloads. Needs `pnpm infra:up` (storage and ClamAV). */
const urls = inject("testDatabase");

/** The standard anti-virus test file: harmless, but every scanner reports it. */
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

let db: Db;
let publicDb: Db;
let workerDb: Db;
let owner: Db;
let app: Express;
let store: ObjectStore;
let scan: ScanDeps;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;
const consoleReq = (who: string, method: "get" | "post" | "put", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);

function definitionWithFile(): FormDefinition {
  const def = blankDefinition("Claim form");
  def.fields = [
    { id: "f_name", type: "text", label: "Name", required: true, settings: {} },
    {
      id: "f_receipt",
      type: "file",
      label: "Receipt",
      required: true,
      settings: { allowedMimeTypes: ["text/plain", "application/pdf"], maxFileBytes: 1024 * 1024, maxFiles: 2 },
    },
  ];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_name", "f_receipt"] }];
  return def;
}

async function publishedForm(tenant = a, who = "ownerA") {
  const created = FormResponseSchema.parse((await consoleReq(who, "post", `/api/v1/organizations/${tenant.id}/forms`).send({ name: "Claim form" })).body);
  const path = `/api/v1/organizations/${tenant.id}/forms/${created.form.id}`;
  const saved = await consoleReq(who, "put", `${path}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(definitionWithFile());
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const published = await consoleReq(who, "post", `${path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `key-${randomUUID()}`);
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  return { id: created.form.id, slug: created.form.slug, path, versionId: PublishResponseSchema.parse(published.body).version.id };
}

async function startSession(slug: string) {
  const res = await request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return SessionStartResponseSchema.parse(res.body);
}
type Session = Awaited<ReturnType<typeof startSession>>;

const bearer = (s: Session) => ({ Authorization: `Bearer ${s.capability}` });

function requestUpload(session: Session, body: object) {
  return request(app).post(`/public/v1/sessions/${session.sessionId}/uploads`).set(bearer(session)).send(body);
}

/** Announces, PUTs (straight to storage, as a browser would) and completes an upload. */
async function upload(session: Session, content: string | Buffer, contentType = "text/plain", fileName = "receipt.txt") {
  const bytes = Buffer.from(content);
  const created = await requestUpload(session, { fieldId: "f_receipt", fileName, contentType, bytes: bytes.length });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const target = UploadCreateResponseSchema.parse(created.body);
  const put = await fetch(target.uploadUrl, { method: "PUT", headers: target.headers, body: bytes });
  expect(put.status, await put.text()).toBe(200);
  const done = await request(app).post(`/public/v1/sessions/${session.sessionId}/uploads/${target.uploadId}/complete`).set(bearer(session));
  expect(done.status, JSON.stringify(done.body)).toBe(202);
  return target.uploadId;
}

const uploadState = async (session: Session, uploadId: string) =>
  UploadStatusResponseSchema.parse((await request(app).get(`/public/v1/sessions/${session.sessionId}/uploads/${uploadId}`).set(bearer(session))).body);

const submit = (session: Session, files: string[], name = "Ada") =>
  request(app)
    .post(`/public/v1/sessions/${session.sessionId}/submissions`)
    .set(bearer(session))
    .set("Idempotency-Key", `k-${randomUUID()}`)
    .send({ formVersionId: session.versionId, answers: { f_name: name, f_receipt: files } });

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

async function storageKey(uploadId: string, tenant = a) {
  return withTenant(owner, tenant.id, async (trx) => (await trx.selectFrom("file_uploads").select("storage_key").where("id", "=", uploadId).executeTakeFirstOrThrow()).storage_key);
}

/** Scans everything waiting, as the worker would. */
async function runScans() {
  while ((await scanPendingUploads(scan, 20)) > 0);
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 4 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 2 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  store = testObjectStore();
  scan = { workerDb, store, scanner: { host: process.env.SCANNER_HOST ?? "127.0.0.1", port: Number(process.env.SCANNER_PORT ?? 3310) } };
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb, unusedIdentityProvider, store);
  a = createTenantFixture("Uploads tenant A");
  b = createTenantFixture("Uploads tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  tokens.ownerA = (await identityRepo.createSession(db, roleUser(a, "owner"), 60 * 60 * 1000)).token;
  tokens.analystA = (await identityRepo.createSession(db, roleUser(a, "analyst"), 60 * 60 * 1000)).token;
  tokens.ownerB = (await identityRepo.createSession(db, roleUser(b, "owner"), 60 * 60 * 1000)).token;
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await workerDb?.destroy();
  await owner?.destroy();
});

describe("clean files", () => {
  it("go to quarantine, get scanned, move to the clean bucket, are claimed once and download only for authorized readers", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const uploadId = await upload(session, "Taxi, 12.50 EUR\n", "text/plain", "../../etc/receipt\u0000.txt");
    expect(await uploadState(session, uploadId)).toMatchObject({ state: "pending_scan", fileName: "receipt_.txt", bytes: 16, rejectionReason: null });
    const key = await storageKey(uploadId);
    expect(await store.head(store.quarantineBucket, key)).toMatchObject({ bytes: 16 });

    // Not scanned yet: it cannot be submitted.
    const early = await submit(session, [uploadId]);
    expectProblem(early, 422, "VALIDATION_FAILED");
    expect(ProblemSchema.parse(early.body).errors?.[0]).toMatchObject({ field: "answers.f_receipt", code: "FILE_PENDING" });

    await runScans();
    expect((await uploadState(session, uploadId)).state).toBe("clean");
    expect(await store.head(store.quarantineBucket, key)).toBeUndefined();
    expect(await store.head(store.cleanBucket, key)).toMatchObject({ bytes: 16 });

    const res = await submit(session, [uploadId]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const submissionId = res.body.submissionId as string;
    const row = await withTenant(owner, a.id, (trx) => trx.selectFrom("file_uploads").select(["claimed_submission_id", "detected_type"]).where("id", "=", uploadId).executeTakeFirstOrThrow());
    expect(row).toEqual({ claimed_submission_id: submissionId, detected_type: "text/plain" });

    // Claimable once: a second claim of the same upload is refused by the database.
    await expect(
      withTenant(publicDb, a.id, (trx) => sql`SELECT app.claim_uploads(${session.sessionId}::uuid, ${submissionId}::uuid, ${[uploadId]}::uuid[], ${["f_receipt"]}::text[])`.execute(trx)),
    ).rejects.toThrow(/UPLOAD_NOT_CLAIMABLE/);

    const filePath = `${f.path}/submissions/${submissionId}/files/${uploadId}`;
    const link = await consoleReq("ownerA", "get", filePath);
    expect(link.status).toBe(200);
    const download = FileDownloadResponseSchema.parse(link.body);
    expect(download).toMatchObject({ fileName: "receipt_.txt", contentType: "text/plain", bytes: 16 });
    const fetched = await fetch(download.url);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("Taxi, 12.50 EUR\n");
    expect(fetched.headers.get("content-disposition")).toMatch(/^attachment; filename="receipt_\.txt"/);

    // No response access, another tenant, or a file of another submission: not found.
    expectProblem(await consoleReq("analystA", "get", filePath), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerB", "get", filePath), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerA", "get", `${f.path}/submissions/${randomUUID()}/files/${uploadId}`), 404, "NOT_FOUND");
  });
});

describe("refused files", () => {
  it("blocks malware, deletes it, and refuses a submission that attaches it", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const uploadId = await upload(session, EICAR);
    const key = await storageKey(uploadId);
    await runScans();
    expect(await uploadState(session, uploadId)).toMatchObject({ state: "infected", rejectionReason: "malware" });
    expect(await store.head(store.quarantineBucket, key)).toBeUndefined();
    expect(await store.head(store.cleanBucket, key)).toBeUndefined();
    const res = await submit(session, [uploadId]);
    expectProblem(res, 422, "VALIDATION_FAILED");
    expect(ProblemSchema.parse(res.body).errors?.[0]?.code).toBe("FILE_INFECTED");
  });

  it("rejects bytes that are not the declared type, whatever the name says", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const uploadId = await upload(session, "just some text, not a PDF", "application/pdf", "statement.pdf");
    await runScans();
    expect(await uploadState(session, uploadId)).toMatchObject({ state: "rejected", rejectionReason: "type_mismatch" });
    expect(ProblemSchema.parse((await submit(session, [uploadId])).body).errors?.[0]?.code).toBe("FILE_REJECTED");
  });

  it("refuses another session's upload, even in the same form", async () => {
    const f = await publishedForm();
    const owner1 = await startSession(f.slug);
    const other = await startSession(f.slug);
    const uploadId = await upload(owner1, "mine");
    await runScans();
    expectProblem(await request(app).get(`/public/v1/sessions/${other.sessionId}/uploads/${uploadId}`).set(bearer(other)), 404, "NOT_FOUND");
    const res = await submit(other, [uploadId]);
    expectProblem(res, 422, "VALIDATION_FAILED");
    expect(ProblemSchema.parse(res.body).errors?.[0]?.code).toBe("FILE_NOT_FOUND");
    // The rightful session can still use it.
    expect((await submit(owner1, [uploadId])).status).toBe(201);
  });

  it("checks the announced upload against the field and the form's state", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const codes = async (body: object) => ProblemSchema.parse((await requestUpload(session, body)).body).errors?.[0]?.code;
    expect(await codes({ fieldId: "f_name", fileName: "a.txt", contentType: "text/plain", bytes: 10 })).toBe("NOT_A_FILE_FIELD");
    expect(await codes({ fieldId: "f_receipt", fileName: "a.exe", contentType: "application/x-msdownload", bytes: 10 })).toBe("TYPE_NOT_ALLOWED");
    expect(await codes({ fieldId: "f_receipt", fileName: "a.txt", contentType: "text/plain", bytes: 2 * 1024 * 1024 })).toBe("FILE_TOO_LARGE");
    expectProblem(await requestUpload(session, { fieldId: "f_receipt", fileName: "a.txt", contentType: "text/plain", bytes: 20 * 1024 * 1024 }), 422, "VALIDATION_FAILED");

    // The presigned PUT accepts only the announced type and size.
    const target = UploadCreateResponseSchema.parse((await requestUpload(session, { fieldId: "f_receipt", fileName: "a.txt", contentType: "text/plain", bytes: 5 })).body);
    expect((await fetch(target.uploadUrl, { method: "PUT", headers: { "Content-Type": "text/html" }, body: "hello" })).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(target.uploadUrl, { method: "PUT", headers: target.headers, body: "hello, longer" })).status).toBeGreaterThanOrEqual(400);
    expectProblem(await request(app).post(`/public/v1/sessions/${session.sessionId}/uploads/${target.uploadId}/complete`).set(bearer(session)), 409, "UPLOAD_NOT_RECEIVED");

    await consoleReq("ownerA", "post", `${f.path}/close`).expect(200);
    expectProblem(await requestUpload(session, { fieldId: "f_receipt", fileName: "a.txt", contentType: "text/plain", bytes: 5 }), 410, "FORM_CLOSED");
  });
});

describe("worker behaviour", () => {
  it("keeps a file pending when the scanner is unreachable, and never passes it unscanned", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const uploadId = await upload(session, "waiting for the scanner");
    const jobs = (await uploadsRepo.claimScanJobs(workerDb, 50, SCAN_LEASE_SECONDS)).filter((j) => j.uploadId === uploadId);
    expect(jobs).toHaveLength(1);
    const outcome = await processScanJob({ ...scan, scanner: { host: "127.0.0.1", port: 1, timeoutMs: 2000 } }, jobs[0]!);
    expect(outcome).toEqual({ outcome: "retry" });
    expect((await uploadState(session, uploadId)).state).toBe("pending_scan");
    await runScans();
    expect((await uploadState(session, uploadId)).state).toBe("clean");
  });

  it("expires unclaimed uploads after their deadline and deletes the bytes", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const uploadId = await upload(session, "forgotten");
    await runScans();
    const key = await storageKey(uploadId);
    await withTenant(owner, a.id, (trx) => sql`UPDATE app.file_uploads SET expires_at = now() - interval '1 minute' WHERE id = ${uploadId}`.execute(trx));
    expect(await expireStaleUploads(scan)).toBeGreaterThanOrEqual(1);
    expect((await uploadState(session, uploadId)).state).toBe("expired");
    expect(await store.head(store.cleanBucket, key)).toBeUndefined();
    expect(ProblemSchema.parse((await submit(session, [uploadId])).body).errors?.[0]?.code).toBe("FILE_EXPIRED");
  });

  it("gives no runtime role a way to mark a file clean directly", async () => {
    const f = await publishedForm();
    const session = await startSession(f.slug);
    const uploadId = await upload(session, "honest");
    for (const conn of [publicDb, db, workerDb]) {
      await expect(withTenant(conn, a.id, (trx) => sql`UPDATE app.file_uploads SET state = 'clean' WHERE id = ${uploadId}`.execute(trx))).rejects.toMatchObject({ code: "42501" });
    }
    // The public role cannot call the worker's functions either.
    await expect(sql`SELECT * FROM app.claim_scan_jobs(1, 60)`.execute(publicDb)).rejects.toMatchObject({ code: "42501" });
  });
});
