import { randomUUID } from "node:crypto";
import { createDb, exportsRepo, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import type { ObjectStore } from "@workeasy/files";
import { expireOldExports, processExports, runExportJob, type ExportDeps } from "@workeasy/responses";
import type { FormDefinition } from "@workeasy/form-schema";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ExportDownloadResponseSchema,
  ExportListResponseSchema,
  ExportSchema,
  FormResponseSchema,
  ProblemSchema,
  PublishResponseSchema,
  SessionStartResponseSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testObjectStore, testSettings, unusedIdentityProvider } from "./test-support.js";

/** RES-02: CSV exports built by the worker. Needs `pnpm infra:up` (storage). */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let workerDb: Db;
let owner: Db;
let app: Express;
let store: ObjectStore;
let deps: ExportDeps;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;
const consoleReq = (who: string, method: "get" | "post" | "put", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);

function definition(): FormDefinition {
  const def = blankDefinition("Orders");
  def.fields = [
    { id: "f_item", type: "radio", label: "Item", required: true, settings: { options: [{ id: "opt_tea", label: "Tea" }, { id: "opt_cake", label: "Cake" }] } },
    { id: "f_note", type: "textarea", label: "Note", required: false, settings: {} },
    { id: "f_email", type: "email", label: "Email", required: false, privacy: "personal", settings: {} },
  ];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_item", "f_note", "f_email"] }];
  return def;
}

async function form() {
  const created = FormResponseSchema.parse((await consoleReq("ownerA", "post", `/api/v1/organizations/${a.id}/forms`).send({ name: "Café orders!" })).body);
  const path = `/api/v1/organizations/${a.id}/forms/${created.form.id}`;
  const saved = await consoleReq("ownerA", "put", `${path}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(definition());
  const published = await consoleReq("ownerA", "post", `${path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `key-${randomUUID()}`);
  expect(published.status).toBe(201);
  return { id: created.form.id, slug: created.form.slug, path, versionId: PublishResponseSchema.parse(published.body).version.id };
}

async function respond(slug: string, answers: Record<string, unknown>) {
  const session = SessionStartResponseSchema.parse((await request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body);
  const res = await request(app)
    .post(`/public/v1/sessions/${session.sessionId}/submissions`)
    .set("Authorization", `Bearer ${session.capability}`)
    .set("Idempotency-Key", `k-${randomUUID()}`)
    .send({ formVersionId: session.versionId, answers });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function requestExport(who: string, path: string, body: object = {}) {
  const res = await consoleReq(who, "post", `${path}/exports`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return ExportSchema.parse(res.body);
}

/** Builds everything waiting, as the worker would. */
async function runWorker() {
  while ((await processExports(deps, 10)) > 0);
}

const exportState = async (who: string, id: string) => ExportSchema.parse((await consoleReq(who, "get", `/api/v1/organizations/${a.id}/exports/${id}`)).body);

async function download(who: string, id: string) {
  const res = await consoleReq(who, "get", `/api/v1/organizations/${a.id}/exports/${id}/download`);
  return res;
}

async function csvOf(who: string, id: string): Promise<{ text: string; disposition: string | null; fileName: string }> {
  const res = await download(who, id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const link = ExportDownloadResponseSchema.parse(res.body);
  const fetched = await fetch(link.url);
  expect(fetched.status).toBe(200);
  // Decode the bytes ourselves: fetch's text() would drop the byte-order mark.
  const text = Buffer.from(await fetched.arrayBuffer()).toString("utf8");
  return { text, disposition: fetched.headers.get("content-disposition"), fileName: link.fileName };
}

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

async function grant(path: string, userId: string, permissions: string[]) {
  const res = await consoleReq("ownerA", "put", `${path}/grants`).send({ grants: permissions.map((permission) => ({ principalType: "user", principalId: userId, permission })) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 4 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 2 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  store = testObjectStore();
  deps = { workerDb, store };
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb, unusedIdentityProvider, store);
  a = createTenantFixture("Exports tenant A");
  b = createTenantFixture("Exports tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  const analyst = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `exports-${randomUUID()}` });
  await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: analyst, role: "analyst" }).execute());
  for (const [name, id] of [
    ["ownerA", roleUser(a, "owner")],
    ["ownerB", roleUser(b, "owner")],
    ["analyst", analyst],
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

describe("building an export", () => {
  it("writes the responses up to the cutoff as CSV with formula injection neutralized", async () => {
    const f = await form();
    await respond(f.slug, { f_item: "opt_tea", f_note: '=HYPERLINK("http://evil.example","click")', f_email: "a@example.test" });
    await respond(f.slug, { f_item: "opt_cake", f_note: "Two, please\nwith \"cream\"" });
    await respond(f.slug, { f_item: "opt_tea", f_note: "@SUM(1+1)" });
    const requested = await requestExport("ownerA", f.path);
    expect(requested).toMatchObject({ state: "queued", raw: false, rowCount: null });
    // Arrives after the request: not in this export.
    await respond(f.slug, { f_item: "opt_cake", f_note: "late" });

    await runWorker();
    expect(await exportState("ownerA", requested.id)).toMatchObject({ state: "succeeded", rowCount: 3 });
    const { text, disposition, fileName } = await csvOf("ownerA", requested.id);
    expect(fileName).toMatch(/^cafe-orders-responses-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(disposition).toMatch(/^attachment; filename="cafe-orders-responses-/);
    expect(text.startsWith("﻿Receipt no.,Received (UTC),Version,Item,Note,Email\r\n")).toBe(true);
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(4);
    // Newest first; option labels, not IDs; formulas neutralized; quoting intact.
    expect(text).toContain(`,Tea,'@SUM(1+1),`);
    expect(text).toContain(`,Cake,"Two, please\nwith ""cream""",`);
    expect(text).toContain(`,Tea,"'=HYPERLINK(""http://evil.example"",""click"")",a@example.test`);
    expect(text).not.toContain("late");
  });

  it("offers a raw export for machines, with canonical values and no spreadsheet changes", async () => {
    const f = await form();
    await respond(f.slug, { f_item: "opt_tea", f_note: "=1+1" });
    const requested = await requestExport("ownerA", f.path, { raw: true });
    await runWorker();
    const { text, fileName } = await csvOf("ownerA", requested.id);
    expect(fileName).toMatch(/-raw\.csv$/);
    expect(text.split("\r\n")[0]).toBe("submission_id,received_at,version,f_item,f_note,f_email");
    expect(text).toContain(",opt_tea,=1+1,");
    expect(text.startsWith("﻿")).toBe(false);
  });

  it("applies the list's filters and the requester's field classes", async () => {
    const f = await form();
    await respond(f.slug, { f_item: "opt_tea", f_email: "tea@example.test" });
    await respond(f.slug, { f_item: "opt_cake", f_email: "cake@example.test" });
    // An analyst who may export but not see personal data gets no Email column at all.
    await grant(f.path, users.analyst!, ["responses.read", "responses.export"]);
    const requested = await requestExport("analyst", f.path, { field: "f_item", op: "eq", value: "opt_tea" });
    await runWorker();
    const { text } = await csvOf("analyst", requested.id);
    expect(text.split("\r\n")[0]).toBe("﻿Receipt no.,Received (UTC),Version,Item,Note");
    expect(text.trim().split("\r\n")).toHaveLength(2);
    expect(text).not.toContain("example.test");
    // Filtering on a hidden field is refused here too.
    expectProblem(await consoleReq("analyst", "post", `${f.path}/exports`).send({ field: "f_email", op: "isEmpty" }), 422, "VALIDATION_FAILED");
  });
});

describe("access", () => {
  it("blocks the download as soon as the requester's access is revoked", async () => {
    const f = await form();
    await respond(f.slug, { f_item: "opt_tea" });
    await grant(f.path, users.analyst!, ["responses.read", "responses.export"]);
    const requested = await requestExport("analyst", f.path);
    await runWorker();
    expect((await download("analyst", requested.id)).status).toBe(200);

    await grant(f.path, users.analyst!, ["responses.read"]);
    expectProblem(await download("analyst", requested.id), 403, "EXPORT_ACCESS_REVOKED");
    expectProblem(await consoleReq("analyst", "get", `/api/v1/organizations/${a.id}/exports/${requested.id}`), 403, "FORBIDDEN");

    // Removing the member entirely hides it too.
    await grant(f.path, users.analyst!, ["responses.read", "responses.export"]);
    await withTenant(db, a.id, (trx) => trx.updateTable("memberships").set({ status: "revoked" }).where("user_id", "=", users.analyst!).execute());
    expectProblem(await download("analyst", requested.id), 404, "NOT_FOUND");
    await withTenant(db, a.id, (trx) => trx.updateTable("memberships").set({ status: "active" }).where("user_id", "=", users.analyst!).execute());
  });

  it("refuses to build an export whose requester lost access in the meantime", async () => {
    const f = await form();
    await respond(f.slug, { f_item: "opt_tea", f_email: "x@example.test" });
    await grant(f.path, users.analyst!, ["responses.read", "responses.read_personal", "responses.export"]);
    const requested = await requestExport("analyst", f.path);
    // Personal access withdrawn before the worker runs: the file must not be made.
    await grant(f.path, users.analyst!, ["responses.read", "responses.export"]);
    await runWorker();
    expect(await exportState("ownerA", requested.id).catch(() => undefined)).toBeUndefined();
    const record = await withTenant(owner, a.id, (trx) => trx.selectFrom("exports").select(["state", "failure_code"]).where("id", "=", requested.id).executeTakeFirstOrThrow());
    expect(record).toEqual({ state: "failed", failure_code: "access_revoked" });
    expect(await store.head(store.exportsBucket, requested.id)).toBeUndefined();
  });

  it("keeps exports to their requester, their organization and export permission", async () => {
    const f = await form();
    const requested = await requestExport("ownerA", f.path);
    await grant(f.path, users.analyst!, ["responses.read", "responses.export"]);
    expectProblem(await consoleReq("analyst", "get", `/api/v1/organizations/${a.id}/exports/${requested.id}`), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerB", "get", `/api/v1/organizations/${a.id}/exports/${requested.id}`), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerB", "get", `/api/v1/organizations/${b.id}/exports/${requested.id}`), 404, "NOT_FOUND");
    expect(ExportListResponseSchema.parse((await consoleReq("analyst", "get", `${f.path}/exports`)).body).items).toEqual([]);
    await grant(f.path, users.analyst!, ["responses.read"]);
    expectProblem(await consoleReq("analyst", "post", `${f.path}/exports`).send({}), 403, "FORBIDDEN");
    expectProblem(await download("ownerA", requested.id), 409, "EXPORT_NOT_READY");

    const audit = await withTenant(owner, a.id, (trx) => trx.selectFrom("audit_events").select("action").where("resource_id", "=", f.id).where("action", "like", "responses.%").execute());
    expect(audit.map((e) => e.action)).toContain("responses.export_requested");
  });
});

describe("lifecycle", () => {
  it("expires files after their deadline and deletes them", async () => {
    const f = await form();
    const requested = await requestExport("ownerA", f.path);
    await runWorker();
    expect(await store.head(store.exportsBucket, requested.id)).toBeDefined();
    await withTenant(owner, a.id, (trx) => sql`UPDATE app.exports SET expires_at = now() - interval '1 minute' WHERE id = ${requested.id}`.execute(trx));
    expect(await expireOldExports(deps)).toBeGreaterThanOrEqual(1);
    expect((await exportState("ownerA", requested.id)).state).toBe("expired");
    expect(await store.head(store.exportsBucket, requested.id)).toBeUndefined();
    expectProblem(await download("ownerA", requested.id), 409, "EXPORT_NOT_READY");
  });

  it("records results only for the lease holder", async () => {
    const f = await form();
    const requested = await requestExport("ownerA", f.path);
    const [job] = (await exportsRepo.claimExportJobs(workerDb, 10, 300)).filter((j) => j.exportId === requested.id);
    expect(job).toBeDefined();
    // A stale worker with an old attempt number changes nothing.
    expect(await exportsRepo.finishExport(workerDb, { ...job!, attempt: job!.attempt - 1 }, { outcome: "succeeded", rows: 0, bytes: 0 })).toBe(false);
    await runExportJob(deps, job!);
    expect((await exportState("ownerA", requested.id)).state).toBe("succeeded");
    // The worker cannot change exports directly.
    await expect(withTenant(workerDb, a.id, (trx) => sql`UPDATE app.exports SET state = 'queued'`.execute(trx))).rejects.toMatchObject({ code: "42501" });
  });
});
