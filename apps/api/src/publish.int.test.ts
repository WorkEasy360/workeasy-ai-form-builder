import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { evaluate, validateDefinition } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  DraftResponseSchema,
  FormResponseSchema,
  ProblemSchema,
  PublishResponseSchema,
  ValidateResponseSchema,
  VersionListResponseSchema,
  VersionResponseSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN } from "./test-support.js";

/** PUB-01: validate, publish, version history and rollback. */
const urls = inject("testDatabase");

let db: Db;
let owner: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;

async function signIn(name: string, userId: string) {
  users[name] = userId;
  tokens[name] = (await identityRepo.createSession(db, userId, 60 * 60 * 1000)).token;
}

const cookie = (who: string) => `we_session=${tokens[who]}`;
const get = (path: string, who: string) => request(app).get(path).set("Cookie", cookie(who));
const post = (path: string, who: string, body: object = {}) =>
  request(app).post(path).set("Cookie", cookie(who)).set("Origin", TEST_CONSOLE_ORIGIN).send(body);
const putDraft = (path: string, who: string, revision: number, definition: object) =>
  request(app).put(`${path}/draft`).set("Cookie", cookie(who)).set("Origin", TEST_CONSOLE_ORIGIN).set("If-Match", `"draft-${revision}"`).send(definition);

function publish(path: string, who: string, revision: number | null, key: string | null = `key-${randomUUID()}`) {
  let req = request(app).post(`${path}/publish`).set("Cookie", cookie(who)).set("Origin", TEST_CONSOLE_ORIGIN);
  if (revision !== null) req = req.set("If-Match", `"draft-${revision}"`);
  if (key !== null) req = req.set("Idempotency-Key", key);
  return req.send();
}

const formPath = (org: string, id: string) => `/api/v1/organizations/${org}/forms/${id}`;

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

async function createForm(who: string, name: string, template?: string) {
  const res = await post(`/api/v1/organizations/${a.id}/forms`, who, template ? { name, template } : { name });
  expect(res.status).toBe(201);
  const body = FormResponseSchema.parse(res.body);
  return { id: body.form.id, path: formPath(a.id, body.form.id), revision: body.draft.revision };
}

async function draftOf(path: string, who = "creatorA") {
  return DraftResponseSchema.parse((await get(`${path}/draft`, who)).body);
}

async function rename(path: string, title: string, who = "creatorA") {
  const draft = await draftOf(path, who);
  const res = await putDraft(path, who, draft.revision, { ...draft.definition, title });
  expect(res.status).toBe(200);
  return res.body.revision as number;
}

/** Audit and outbox rows, read through the owner role (the API role may only append). */
async function auditFor(formId: string) {
  return withTenant(owner, a.id, (trx) =>
    trx.selectFrom("audit_events").selectAll().where("resource_id", "=", formId).orderBy("occurred_at").orderBy("id").execute(),
  );
}
async function outboxFor(formId: string) {
  return withTenant(owner, a.id, (trx) => trx.selectFrom("outbox_events").selectAll().where("aggregate_id", "=", formId).execute());
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 6 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  app = buildTestApp(db);
  a = createTenantFixture("Publish tenant A");
  b = createTenantFixture("Publish tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  await signIn("ownerA", roleUser(a, "owner"));
  await signIn("analystA", roleUser(a, "analyst"));
  await signIn("ownerB", roleUser(b, "owner"));
  const creator = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `publish-test-${randomUUID()}` });
  await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: creator, role: "creator" }).execute());
  await signIn("creatorA", creator);
});

afterAll(async () => {
  await db?.destroy();
  await owner?.destroy();
});

describe("validate", () => {
  it("runs the publish checks without changing anything", async () => {
    const blank = await createForm("creatorA", "Blank");
    const res = await post(`${blank.path}/validate`, "creatorA");
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"draft-1"');
    const body = ValidateResponseSchema.parse(res.body);
    expect(body).toMatchObject({ revision: 1, publishable: false, warnings: [] });
    expect(body.issues.map((i) => i.path)).toContain("/fields");

    const ready = await createForm("creatorA", "Ready", "contact");
    expect(ValidateResponseSchema.parse((await post(`${ready.path}/validate`, "creatorA")).body)).toMatchObject({ publishable: true, issues: [] });
    expect((await draftOf(ready.path)).revision).toBe(1);
  });
});

describe("publish", () => {
  it("creates an immutable version, activates it and records audit and outbox in the same commit", async () => {
    const f = await createForm("creatorA", "Event feedback", "contact");
    const res = await publish(f.path, "creatorA", f.revision, "publish-key-0001");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = PublishResponseSchema.parse(res.body);
    expect(body.form).toMatchObject({ state: "published", activeVersionId: body.version.id });
    expect(body.version).toMatchObject({ versionNumber: 1, draftRevision: 1, schemaVersion: "1.0", active: true, publishedBy: { id: users.creatorA } });
    expect(res.headers.location).toBe(`${f.path}/versions/${body.version.id}`);

    const audit = await auditFor(f.id);
    expect(audit.map((e) => e.action)).toEqual(["form.created", "form.published"]);
    expect(audit[1]).toMatchObject({
      actor_type: "user",
      actor_id: users.creatorA,
      action: "form.published",
      resource_type: "form",
      metadata: { versionId: body.version.id, versionNumber: 1, draftRevision: 1, previousVersionId: null },
    });
    expect(audit[1]!.request_id).toBe(res.headers["x-request-id"]);

    const outbox = await outboxFor(f.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ event_type: "form.published.v1", dispatched_at: null, trace_id: res.headers["x-request-id"] });
    // References only: no definition content in the event.
    expect(outbox[0]!.payload).toEqual({ formId: f.id, formVersionId: body.version.id, versionNumber: 1 });
  });

  it("returns the same version when a request is retried with the same key", async () => {
    const f = await createForm("creatorA", "Retry", "contact");
    const first = await publish(f.path, "creatorA", f.revision, "retry-key-0001");
    const again = await publish(f.path, "creatorA", f.revision, "retry-key-0001");
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(PublishResponseSchema.parse(again.body).version.id).toBe(PublishResponseSchema.parse(first.body).version.id);
    expect(VersionListResponseSchema.parse((await get(`${f.path}/versions`, "creatorA")).body).items).toHaveLength(1);
    expect(await outboxFor(f.id)).toHaveLength(1);

    // The same key for a different revision is a conflict, not a silent publish.
    const revision = await rename(f.path, "Retry, renamed");
    expectProblem(await publish(f.path, "creatorA", revision, "retry-key-0001"), 409, "IDEMPOTENCY_CONFLICT");
  });

  it("publishes once for concurrent retries and numbers concurrent publishes without gaps", async () => {
    const f = await createForm("creatorA", "Concurrent", "contact");
    const same = await Promise.all([1, 2, 3].map(() => publish(f.path, "creatorA", f.revision, "same-key-0001")));
    expect(same.map((r) => r.status).toSorted()).toEqual([200, 200, 201]);
    expect(new Set(same.map((r) => r.body.version.id)).size).toBe(1);

    const distinct = await Promise.all([1, 2, 3].map(() => publish(f.path, "creatorA", f.revision)));
    expect(distinct.map((r) => r.status)).toEqual([201, 201, 201]);
    const versions = VersionListResponseSchema.parse((await get(`${f.path}/versions`, "creatorA")).body).items;
    expect(versions.map((v) => v.versionNumber)).toEqual([4, 3, 2, 1]);
    expect(versions.filter((v) => v.active).map((v) => v.versionNumber)).toEqual([4]);
    expect(await outboxFor(f.id)).toHaveLength(4);
  });

  it("requires the current revision, an idempotency key and a valid definition", async () => {
    const f = await createForm("creatorA", "Checks", "contact");
    expectProblem(await publish(f.path, "creatorA", null), 428, "IF_MATCH_REQUIRED");
    expectProblem(await publish(f.path, "creatorA", f.revision, null), 400, "IDEMPOTENCY_KEY_REQUIRED");
    expectProblem(await publish(f.path, "creatorA", f.revision, "short"), 400, "IDEMPOTENCY_KEY_REQUIRED");
    const revision = await rename(f.path, "Checks, renamed");
    const stale = await publish(f.path, "creatorA", f.revision);
    expectProblem(stale, 412, "DRAFT_CONFLICT");
    expect(ProblemSchema.parse(stale.body).currentRevision).toBe(revision);

    const blank = await createForm("creatorA", "Nothing yet");
    const invalid = await publish(blank.path, "creatorA", blank.revision);
    expectProblem(invalid, 422, "NOT_PUBLISHABLE");
    expect(ProblemSchema.parse(invalid.body).errors?.map((e) => e.field)).toContain("/fields");

    // Low contrast blocks publishing like any other problem.
    const draft = await draftOf(f.path);
    const theme = { ...(draft.definition.theme as object), text: "#EEEEEE" };
    const saved = await putDraft(f.path, "creatorA", draft.revision, { ...draft.definition, theme });
    const lowContrast = await publish(f.path, "creatorA", saved.body.revision);
    expectProblem(lowContrast, 422, "NOT_PUBLISHABLE");
    expect(ProblemSchema.parse(lowContrast.body).errors?.map((e) => e.code)).toEqual(["THEME_LOW_CONTRAST"]);
    expect(VersionListResponseSchema.parse((await get(`${f.path}/versions`, "creatorA")).body).items).toEqual([]);
  });

  it("requires forms.publish and stays inside the organization", async () => {
    const f = await createForm("creatorA", "Guarded", "contact");
    // Without a grant the analyst cannot even see the form.
    expectProblem(await publish(f.path, "analystA", f.revision), 404, "NOT_FOUND");
    const granted = await request(app)
      .put(`${f.path}/grants`)
      .set("Cookie", cookie("creatorA"))
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .send({ grants: [{ principalType: "user", principalId: users.analystA, permission: "forms.read" }] });
    expect(granted.status).toBe(200);
    expectProblem(await publish(f.path, "analystA", f.revision), 403, "FORBIDDEN");
    expectProblem(await publish(formPath(b.id, f.id), "ownerB", f.revision), 404, "NOT_FOUND");
    expectProblem(await publish(formPath(a.id, f.id), "ownerB", f.revision), 404, "NOT_FOUND");
    expectProblem(await get(`${formPath(b.id, f.id)}/versions`, "ownerB"), 404, "NOT_FOUND");
    // With read access, the history is visible but what is live cannot be changed.
    expect((await get(`${f.path}/versions`, "analystA")).status).toBe(200);
    expectProblem(await post(`${f.path}/activate-version`, "analystA", { versionId: randomUUID() }), 403, "FORBIDDEN");
  });

  it("refuses to publish an archived form and restores a published one as closed", async () => {
    const f = await createForm("creatorA", "Archive me", "contact");
    expect((await publish(f.path, "creatorA", f.revision)).status).toBe(201);
    expect((await post(`${f.path}/archive`, "creatorA")).status).toBe(200);
    expectProblem(await publish(f.path, "creatorA", f.revision), 409, "FORM_ARCHIVED");
    const restored = FormResponseSchema.parse((await post(`${f.path}/restore`, "creatorA")).body);
    expect(restored.form.state).toBe("closed");

    // Publishing a closed form adds a version but does not reopen it.
    const again = PublishResponseSchema.parse((await publish(f.path, "creatorA", f.revision)).body);
    expect(again.form.state).toBe("closed");
    expect(again.version.versionNumber).toBe(2);
  });
});

describe("versions", () => {
  it("keeps published versions unchanged while the draft moves on", async () => {
    const f = await createForm("creatorA", "Immutable", "contact");
    const v1 = PublishResponseSchema.parse((await publish(f.path, "creatorA", f.revision)).body).version;

    expect(ValidateResponseSchema.parse((await post(`${f.path}/validate`, "creatorA")).body).warnings.map((w) => w.code)).toEqual(["NO_CHANGES"]);
    await rename(f.path, "Immutable, edited");
    expect(ValidateResponseSchema.parse((await post(`${f.path}/validate`, "creatorA")).body).warnings).toEqual([]);

    const res = await get(`${f.path}/versions/${v1.id}`, "ownerA");
    expect(res.status).toBe(200);
    const version = VersionResponseSchema.parse(res.body);
    expect(version.definition.title).toBe("Immutable");
    expect(version.version).toMatchObject({ id: v1.id, active: true, contentHash: v1.contentHash });
    // An old version is still a complete definition the engine can run.
    const checked = validateDefinition(version.definition);
    expect(checked.ok).toBe(true);
    expect(evaluate(version.definition as unknown as FormDefinition, {}).reachablePageIds).toHaveLength(1);

    expectProblem(await get(`${f.path}/versions/${randomUUID()}`, "creatorA"), 404, "NOT_FOUND");
    expectProblem(await get(`${f.path}/versions/not-a-uuid`, "creatorA"), 404, "NOT_FOUND");
  });

  it("cannot be changed or deleted by any runtime role", async () => {
    const f = await createForm("creatorA", "Locked", "contact");
    const v1 = PublishResponseSchema.parse((await publish(f.path, "creatorA", f.revision)).body).version;
    const update = (conn: Db) =>
      withTenant(conn, a.id, (trx) => trx.updateTable("form_versions").set({ definition: { tampered: true } }).where("id", "=", v1.id).execute());
    await expect(update(db)).rejects.toMatchObject({ code: "42501" });
    // Even the table owner is refused by the trigger.
    await expect(update(owner)).rejects.toMatchObject({ code: "23001", message: expect.stringMatching(/immutable/) });
    await expect(withTenant(db, a.id, (trx) => trx.deleteFrom("form_versions").where("id", "=", v1.id).execute())).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(db, a.id, (trx) => trx.updateTable("audit_events").set({ action: "form.nothing" }).where("resource_id", "=", f.id).execute()),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("is invisible to other tenants even with a known ID", async () => {
    const f = await createForm("creatorA", "Private history", "contact");
    const v1 = PublishResponseSchema.parse((await publish(f.path, "creatorA", f.revision)).body).version;
    const seen = await withTenant(db, b.id, (trx) => trx.selectFrom("form_versions").select("id").where("id", "=", v1.id).execute());
    expect(seen).toEqual([]);
  });
});

describe("activate-version (rollback)", () => {
  it("switches the active version atomically, audits it and keeps every version", async () => {
    const f = await createForm("creatorA", "Rollback", "contact");
    const v1 = PublishResponseSchema.parse((await publish(f.path, "creatorA", f.revision)).body).version;
    const revision = await rename(f.path, "Rollback v2");
    const v2 = PublishResponseSchema.parse((await publish(f.path, "creatorA", revision)).body).version;
    expect(v2).toMatchObject({ versionNumber: 2, active: true });

    const res = await post(`${f.path}/activate-version`, "creatorA", { versionId: v1.id });
    expect(res.status).toBe(200);
    const body = PublishResponseSchema.parse(res.body);
    expect(body.form.activeVersionId).toBe(v1.id);
    expect(body.version).toMatchObject({ id: v1.id, active: true });
    const versions = VersionListResponseSchema.parse((await get(`${f.path}/versions`, "creatorA")).body).items;
    expect(versions.map((v) => [v.versionNumber, v.active])).toEqual([
      [2, false],
      [1, true],
    ]);
    // Rollback does not touch the draft.
    expect((await draftOf(f.path)).definition.title).toBe("Rollback v2");

    // Activating the active version again changes nothing and is not audited twice.
    expect((await post(`${f.path}/activate-version`, "creatorA", { versionId: v1.id })).status).toBe(200);
    const audit = await auditFor(f.id);
    expect(audit.map((e) => e.action)).toEqual(["form.created", "form.published", "form.published", "form.version_activated"]);
    expect(audit[3]!.metadata).toEqual({ versionId: v1.id, versionNumber: 1, previousVersionId: v2.id });
    // Only publications emit events.
    expect(await outboxFor(f.id)).toHaveLength(2);
  });

  it("only accepts versions of the same form, in the API and in the database", async () => {
    const f = await createForm("creatorA", "Mine", "contact");
    const g = await createForm("creatorA", "Other", "contact");
    PublishResponseSchema.parse((await publish(f.path, "creatorA", f.revision)).body);
    const other = PublishResponseSchema.parse((await publish(g.path, "creatorA", g.revision)).body).version;

    const res = await post(`${f.path}/activate-version`, "creatorA", { versionId: other.id });
    expectProblem(res, 422, "VALIDATION_FAILED");
    expect(ProblemSchema.parse(res.body).errors?.[0]?.code).toBe("UNKNOWN_VERSION");
    expectProblem(await post(`${f.path}/activate-version`, "creatorA", { versionId: "nope" }), 422, "VALIDATION_FAILED");

    // The composite foreign key stops a direct write too.
    await expect(
      withTenant(db, a.id, (trx) => trx.updateTable("forms").set({ active_version_id: other.id }).where("id", "=", f.id).execute()),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
