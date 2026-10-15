import { randomUUID } from "node:crypto";
import { createDb, identityRepo, publicFormsRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  FormResponseSchema,
  ProblemSchema,
  PublicFormResponseSchema,
  PublishResponseSchema,
  ShareResponseSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** PUB-02: public link, embed and QR payloads, and closed-state behaviour. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let owner: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;
const cookie = (who: string) => `we_session=${tokens[who]}`;
const get = (path: string, who: string) => request(app).get(path).set("Cookie", cookie(who));
const post = (path: string, who: string, body: object = {}) =>
  request(app).post(path).set("Cookie", cookie(who)).set("Origin", TEST_CONSOLE_ORIGIN).send(body);

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

interface Published {
  id: string;
  slug: string;
  path: string;
  versionId: string;
}

async function publishedForm(who = "ownerA", tenant = a): Promise<Published> {
  const created = FormResponseSchema.parse((await post(`/api/v1/organizations/${tenant.id}/forms`, who, { name: "Public form", template: "contact" })).body);
  const path = `/api/v1/organizations/${tenant.id}/forms/${created.form.id}`;
  const published = await request(app)
    .post(`${path}/publish`)
    .set("Cookie", cookie(who))
    .set("Origin", TEST_CONSOLE_ORIGIN)
    .set("If-Match", `"draft-${created.draft.revision}"`)
    .set("Idempotency-Key", `key-${randomUUID()}`);
  expect(published.status).toBe(201);
  return { id: created.form.id, slug: created.form.slug, path, versionId: PublishResponseSchema.parse(published.body).version.id };
}

const publicGet = (slug: string) => request(app).get(`/public/v1/forms/${slug}`);
const acceptance = (slug: string, versionId: string) => request(app).get(`/public/v1/forms/${slug}/acceptance`).query({ versionId });

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 2 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 1 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb);
  a = createTenantFixture("Public tenant A");
  b = createTenantFixture("Public tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  tokens.ownerA = (await identityRepo.createSession(db, roleUser(a, "owner"), 60 * 60 * 1000)).token;
  tokens.analystA = (await identityRepo.createSession(db, roleUser(a, "analyst"), 60 * 60 * 1000)).token;
  tokens.ownerB = (await identityRepo.createSession(db, roleUser(b, "owner"), 60 * 60 * 1000)).token;
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await owner?.destroy();
});

describe("public form", () => {
  it("serves the active version's public projection without a session, cacheable for a short time", async () => {
    const f = await publishedForm();
    const res = await publicGet(f.slug);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=30");
    expect(res.headers["set-cookie"]).toBeUndefined();
    const body = PublicFormResponseSchema.parse(res.body);
    expect(body).toMatchObject({ slug: f.slug, versionId: f.versionId, versionNumber: 1 });
    expect(body.definition).toMatchObject({ schemaVersion: "1.0", title: "Public form" });
    // Nothing internal: only the projected keys.
    expect(Object.keys(body.definition).toSorted()).toEqual(["fields", "locale", "pages", "rules", "schemaVersion", "success", "theme", "title"]);
  });

  it("does not reveal drafts, archived forms or unknown slugs", async () => {
    const draft = FormResponseSchema.parse((await post(`/api/v1/organizations/${a.id}/forms`, "ownerA", { name: "Not yet" })).body);
    for (const slug of [draft.form.slug, "f-doesnotexist", "Not A Slug!", "x"]) {
      const res = await publicGet(slug);
      expectProblem(res, 404, "NOT_FOUND");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const archived = await publishedForm();
    expect((await post(`${archived.path}/archive`, "ownerA")).status).toBe(200);
    expectProblem(await publicGet(archived.slug), 404, "NOT_FOUND");
  });
});

describe("close and reopen", () => {
  it("rejects a page opened before the form closed, at once, and accepts it again after reopening", async () => {
    const f = await publishedForm();
    // A respondent loads the form while it is open...
    const loaded = PublicFormResponseSchema.parse((await publicGet(f.slug)).body);
    expect((await acceptance(f.slug, loaded.versionId)).body).toEqual({ accepting: true });

    // ...the creator closes it...
    const closedRes = await post(`${f.path}/close`, "ownerA", { reason: "Event is full" });
    expect(closedRes.status).toBe(200);
    expect(FormResponseSchema.parse(closedRes.body).form.state).toBe("closed");

    // ...and the stale page's acceptance check fails immediately, uncached.
    const stale = await acceptance(f.slug, loaded.versionId);
    expectProblem(stale, 410, "FORM_CLOSED");
    expect(stale.headers["cache-control"]).toBe("no-store");
    // A fresh load shows the closed state.
    expectProblem(await publicGet(f.slug), 410, "FORM_CLOSED");
    // The authoritative check RUN-02's intake will call says the same.
    const located = (await publicFormsRepo.resolveSlug(publicDb, f.slug))!;
    expect(await withTenant(publicDb, a.id, (trx) => publicFormsRepo.checkAcceptance(trx, located.formId, loaded.versionId))).toEqual({
      accepting: false,
      reason: "closed",
    });

    expectProblem(await post(`${f.path}/close`, "ownerA"), 409, "FORM_STATE_CONFLICT");
    const reopened = await post(`${f.path}/reopen`, "ownerA");
    expect(FormResponseSchema.parse(reopened.body).form.state).toBe("published");
    expect((await acceptance(f.slug, loaded.versionId)).body).toEqual({ accepting: true });
    expectProblem(await post(`${f.path}/reopen`, "ownerA"), 409, "FORM_STATE_CONFLICT");

    const audit = await withTenant(owner, a.id, (trx) =>
      trx.selectFrom("audit_events").select(["action", "metadata"]).where("resource_id", "=", f.id).orderBy("occurred_at").orderBy("id").execute(),
    );
    expect(audit.map((e) => e.action)).toEqual(["form.published", "form.closed", "form.reopened"]);
    expect(audit[1]!.metadata).toEqual({ activeVersionId: f.versionId, reason: "Event is full" });
  });

  it("tells a page loaded with a replaced version to reload", async () => {
    const f = await publishedForm();
    const draft = (await get(`${f.path}/draft`, "ownerA")).body as { revision: number; definition: object };
    const saved = await request(app)
      .put(`${f.path}/draft`)
      .set("Cookie", cookie("ownerA"))
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .set("If-Match", `"draft-${draft.revision}"`)
      .send({ ...draft.definition, title: "Public form v2" });
    await request(app)
      .post(`${f.path}/publish`)
      .set("Cookie", cookie("ownerA"))
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .set("If-Match", `"draft-${saved.body.revision}"`)
      .set("Idempotency-Key", `key-${randomUUID()}`)
      .expect(201);
    expectProblem(await acceptance(f.slug, f.versionId), 409, "VERSION_CHANGED");
    expectProblem(await acceptance(f.slug, "not-a-uuid"), 422, "VALIDATION_FAILED");
    expectProblem(await acceptance(f.slug, randomUUID()), 409, "VERSION_CHANGED");
  });

  it("only lets publishers close or reopen, inside their organization", async () => {
    const f = await publishedForm();
    expectProblem(await post(`${f.path}/close`, "ownerB"), 404, "NOT_FOUND");
    expectProblem(await post(`/api/v1/organizations/${b.id}/forms/${f.id}/close`, "ownerB"), 404, "NOT_FOUND");
    // Never-published forms cannot be closed.
    const draft = FormResponseSchema.parse((await post(`/api/v1/organizations/${a.id}/forms`, "ownerA", { name: "Draft only" })).body);
    expectProblem(await post(`/api/v1/organizations/${a.id}/forms/${draft.form.id}/close`, "ownerA"), 409, "FORM_STATE_CONFLICT");
    expectProblem(await post(`${f.path}/close`, "ownerA", { reason: "x".repeat(501) }), 422, "VALIDATION_FAILED");
  });
});

describe("share", () => {
  it("gives the public link, an embed snippet and the QR payload", async () => {
    const f = await publishedForm();
    const res = await get(`${f.path}/share`, "ownerA");
    expect(res.status).toBe(200);
    const share = ShareResponseSchema.parse(res.body);
    expect(share).toMatchObject({
      url: `${TEST_RESPONDENT_ORIGIN}/f/${f.slug}`,
      embedUrl: `${TEST_RESPONDENT_ORIGIN}/f/${f.slug}?embed=1`,
      qrPayload: `${TEST_RESPONDENT_ORIGIN}/f/${f.slug}`,
      live: true,
    });
    expect(share.embedHtml).toContain(`<iframe id="workeasy-form-${f.slug}" src="${TEST_RESPONDENT_ORIGIN}/f/${f.slug}?embed=1" title="Public form"`);
    // The resize script only trusts messages from the respondent origin and this iframe.
    expect(share.embedHtml).toContain(`event.origin !== "${TEST_RESPONDENT_ORIGIN}"`);
    expect(share.embedHtml).toContain("event.source !== frame.contentWindow");

    await post(`${f.path}/close`, "ownerA");
    expect(ShareResponseSchema.parse((await get(`${f.path}/share`, "ownerA")).body).live).toBe(false);
    expectProblem(await get(`${f.path}/share`, "ownerB"), 404, "NOT_FOUND");
  });

  it("escapes the form name in the embed snippet", async () => {
    const created = FormResponseSchema.parse(
      (await post(`/api/v1/organizations/${a.id}/forms`, "ownerA", { name: `"><script>alert(1)</script>` })).body,
    );
    const share = ShareResponseSchema.parse((await get(`/api/v1/organizations/${a.id}/forms/${created.form.id}/share`, "ownerA")).body);
    expect(share.embedHtml).not.toContain("<script>alert");
    expect(share.embedHtml).toContain('title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(share.live).toBe(false);
  });
});

describe("public database role", () => {
  it("reads only the granted columns, and only inside the resolved tenant", async () => {
    const f = await publishedForm();
    // Without a tenant context nothing is visible.
    expect(await publicDb.selectFrom("forms").select("id").where("id", "=", f.id).execute()).toEqual([]);
    // Inside another tenant's context the form stays invisible.
    expect(await withTenant(publicDb, b.id, (trx) => trx.selectFrom("forms").select("id").where("id", "=", f.id).execute())).toEqual([]);
    // Names, drafts, full definitions, grants and audit data are out of reach.
    const denied = [
      sql`SELECT name FROM app.forms`,
      sql`SELECT definition FROM app.form_versions`,
      sql`SELECT * FROM app.form_drafts`,
      sql`SELECT * FROM app.form_grants`,
      sql`SELECT * FROM app.memberships`,
      sql`SELECT * FROM app.audit_events`,
    ];
    for (const query of denied) {
      await expect(withTenant(publicDb, a.id, (trx) => query.execute(trx))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(withTenant(publicDb, a.id, (trx) => trx.updateTable("forms").set({ state: "closed" }).where("id", "=", f.id).execute())).rejects.toMatchObject({
      code: "42501",
    });
  });
});
