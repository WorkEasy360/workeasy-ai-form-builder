import { randomUUID } from "node:crypto";
import { createDb, governanceRepo, identityRepo, withTenant, type Db, type LedgerEntry } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import { createLedgerShipper, purgeDeletedResponses } from "@workeasy/responses";
import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { FormResponseSchema, PublishResponseSchema, SessionStartResponseSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testObjectStore, testSettings, unusedIdentityProvider } from "./test-support.js";

/**
 * REC-01: after a backup restore, the deletion ledger deletes again what was
 * deleted after the backup, before the application serves traffic. The
 * restore is simulated by undoing deletions made after a recovery point.
 * Needs `pnpm infra:up`.
 */
const urls = inject("testDatabase");

let db: Db;
let owner: Db;
let workerDb: Db;
let publicDb: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};

const consoleReq = (method: "get" | "post" | "put" | "delete", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens.owner}`).set("Origin", TEST_CONSOLE_ORIGIN);

async function publishedForm(name: string) {
  const def = blankDefinition(name);
  def.fields = [{ id: "f_note", type: "text", label: "Note", required: true, settings: {} }];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_note"] }];
  const created = FormResponseSchema.parse((await consoleReq("post", `/api/v1/organizations/${a.id}/forms`).send({ name })).body);
  const path = `/api/v1/organizations/${a.id}/forms/${created.form.id}`;
  const saved = await consoleReq("put", `${path}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(def);
  const published = await consoleReq("post", `${path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `k-${randomUUID()}`);
  PublishResponseSchema.parse(published.body);
  return { id: created.form.id, slug: created.form.slug, path };
}

async function respond(slug: string, note: string): Promise<string> {
  const session = SessionStartResponseSchema.parse((await request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body);
  const res = await request(app)
    .post(`/public/v1/sessions/${session.sessionId}/submissions`)
    .set("Authorization", `Bearer ${session.capability}`)
    .set("Idempotency-Key", `k-${randomUUID()}`)
    .send({ formVersionId: session.versionId, answers: { f_note: note } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.submissionId as string;
}

const submission = (id: string) =>
  withTenant(db, a.id, (trx) => trx.selectFrom("submissions").select(["deleted_at", "deletion_reason", "answers", "purged_at"]).where("id", "=", id).executeTakeFirstOrThrow());

/** Stands in for restoring a backup taken before these deletions: they are undone. */
async function restoreToBefore(formIds: string[], submissionIds: string[]) {
  await withTenant(db, a.id, async (trx) => {
    await trx.updateTable("forms").set({ deleted_at: null }).where("id", "in", formIds).execute();
    await trx.updateTable("submissions").set({ deleted_at: null, deleted_by: null, deletion_reason: null }).where("id", "in", submissionIds).execute();
  });
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 2 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb);
  a = createTenantFixture("Recovery tenant A");
  b = createTenantFixture("Recovery tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  tokens.owner = (await identityRepo.createSession(db, a.members.find((m) => m.role === "owner")!.user.id, 60 * 60 * 1000)).token;
});

afterAll(async () => {
  await db?.destroy();
  await owner?.destroy();
  await workerDb?.destroy();
  await publicDb?.destroy();
});

describe("deletion ledger replay (REC-01)", () => {
  it("deletes again, at their original times, the responses and forms deleted after the recovery point", async () => {
    const kept = await publishedForm("Kept form");
    const doomedForm = await publishedForm("Doomed form");
    const stays = await respond(kept.slug, "stays");
    const erased = await respond(kept.slug, "Erase me please");
    const onDoomedForm = await respond(doomedForm.slug, "On a form that gets deleted");

    const { rows } = await sql<{ now: string }>`SELECT now()::text AS now`.execute(owner);
    const recoveryPoint = rows[0]!.now;

    expect((await consoleReq("delete", `${kept.path}/submissions/${erased}`).send({ reason: "Respondent asked" })).status).toBe(202);
    expect((await consoleReq("delete", doomedForm.path).send({ reason: "Form no longer needed" })).status).toBe(202);
    const erasedAt = (await submission(erased)).deleted_at!;

    const ledger = (await governanceRepo.exportDeletionLedger(owner, recoveryPoint)).filter((e) => e.tenant_id === a.id);
    expect(ledger.map((e) => [e.kind, e.id]).toSorted()).toEqual(
      [
        ["form", doomedForm.id],
        ["response", erased],
        ["response", onDoomedForm],
      ].toSorted(),
    );

    await restoreToBefore([doomedForm.id], [erased, onDoomedForm]);
    expect((await submission(erased)).deleted_at).toBeNull();

    expect(await governanceRepo.replayDeletions(owner, ledger)).toEqual({ forms: 1, responses: 2 });
    const replayed = await submission(erased);
    expect(replayed.deleted_at?.getTime()).toBe(erasedAt.getTime());
    expect(replayed.deletion_reason).toBe("Deleted again after a backup restore");
    expect((await submission(stays)).deleted_at).toBeNull();
    expect((await request(app).get(`/public/v1/forms/${doomedForm.slug}`)).status).toBe(404);

    // Replaying again changes nothing.
    expect(await governanceRepo.replayDeletions(owner, ledger)).toEqual({ forms: 0, responses: 0 });

    // The worker then purges the content as for any deletion.
    while ((await purgeDeletedResponses({ workerDb, store: testObjectStore() }, 50)) > 0);
    expect(await submission(erased)).toMatchObject({ answers: {}, purged_at: expect.any(Date) });
    expect((await submission(stays)).answers).toEqual({ f_note: "stays" });
  });

  it("ignores entries for rows that do not exist or belong to another tenant", async () => {
    const form = await publishedForm("Unrelated");
    const id = await respond(form.slug, "keep");
    const forged: LedgerEntry[] = [
      { kind: "response", id, tenant_id: b.id, form_id: form.id, deleted_at: new Date().toISOString() },
      { kind: "form", id: form.id, tenant_id: b.id, form_id: form.id, deleted_at: new Date().toISOString() },
      { kind: "response", id: randomUUID(), tenant_id: a.id, form_id: form.id, deleted_at: new Date().toISOString() },
    ];
    expect(await governanceRepo.replayDeletions(owner, forged)).toEqual({ forms: 0, responses: 0 });
    expect((await submission(id)).deleted_at).toBeNull();
  });

  it("ships deletions to object storage as the worker, for installations on Aurora/RDS (OPS-03)", async () => {
    const form = await publishedForm("Shipped");
    const id = await respond(form.slug, "Ship my deletion");
    expect((await consoleReq("delete", `${form.path}/submissions/${id}`).send({ reason: "Respondent asked" })).status).toBe(202);

    const store = testObjectStore();
    const prefix = `test-ledger/${randomUUID()}`;
    const shipper = createLedgerShipper({ workerDb, store, bucket: store.exportsBucket, prefix }, new Date(Date.now() - 60_000));
    const shipped = await shipper.run();
    expect(shipped.entries).toBeGreaterThan(0);
    expect(shipped.key?.startsWith(`${prefix}/`)).toBe(true);
    const chunks: Buffer[] = [];
    for await (const chunk of await store.read(store.exportsBucket, shipped.key!)) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = Buffer.concat(chunks).toString("utf8");
    const entries = body.trim().split("\n").map((line) => JSON.parse(line) as LedgerEntry);
    expect(entries).toContainEqual(expect.objectContaining({ kind: "response", id, tenant_id: a.id }));
  });

  it("is available only to the owner role", async () => {
    await expect(sql`SELECT * FROM app.deletion_ledger(now())`.execute(db)).rejects.toThrow(/permission denied/);
    await expect(sql`SELECT * FROM app.replay_deletions('[]'::jsonb)`.execute(workerDb)).rejects.toThrow(/permission denied/);
  });
});
