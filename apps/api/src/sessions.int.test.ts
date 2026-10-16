import { createHash, randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  AccessPolicyResponseSchema,
  FormResponseSchema,
  ProblemSchema,
  PublicFormResponseSchema,
  PublishResponseSchema,
  SessionStartResponseSchema,
  ShareResponseSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** RUN-01: access checks and version-bound respondent sessions. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let owner: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
/** Console session tokens (we_session) and respondent sign-in tokens (we_respondent), by person. */
const consoleTokens: Record<string, string> = {};
const respondentTokens: Record<string, string> = {};
const users: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;

const consolePost = (path: string, who: string, body: object = {}) =>
  request(app).post(path).set("Cookie", `we_session=${consoleTokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN).send(body);
const consolePatch = (path: string, who: string, body: object) =>
  request(app).patch(path).set("Cookie", `we_session=${consoleTokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN).send(body);

function respondentCookie(who?: string): Record<string, string> {
  return who ? { Cookie: `we_respondent=${respondentTokens[who]}` } : {};
}
const publicGet = (slug: string, who?: string) => request(app).get(`/public/v1/forms/${slug}`).set(respondentCookie(who));
const startSession = (slug: string, who?: string, origin = TEST_RESPONDENT_ORIGIN) =>
  request(app).post(`/public/v1/forms/${slug}/sessions`).set(respondentCookie(who)).set("Origin", origin);
const acceptance = (sessionId: string, capability: string) =>
  request(app).get(`/public/v1/sessions/${sessionId}/acceptance`).set("Authorization", `Bearer ${capability}`);

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

async function publishedForm(tenant = a, who = "ownerA") {
  const created = FormResponseSchema.parse((await consolePost(`/api/v1/organizations/${tenant.id}/forms`, who, { name: "Staff survey", template: "contact" })).body);
  const path = `/api/v1/organizations/${tenant.id}/forms/${created.form.id}`;
  const published = await request(app)
    .post(`${path}/publish`)
    .set("Cookie", `we_session=${consoleTokens[who]}`)
    .set("Origin", TEST_CONSOLE_ORIGIN)
    .set("If-Match", `"draft-${created.draft.revision}"`)
    .set("Idempotency-Key", `key-${randomUUID()}`);
  expect(published.status).toBe(201);
  return { id: created.form.id, slug: created.form.slug, path, versionId: PublishResponseSchema.parse(published.body).version.id };
}

async function membersOnly(path: string) {
  const res = await consolePatch(`${path}/access-policy`, "ownerA", { mode: "organization" });
  expect(res.status).toBe(200);
}

async function addMember(tenant: TenantFixture, role: "creator" | "analyst") {
  const userId = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `sessions-test-${randomUUID()}` });
  await withTenant(db, tenant.id, (trx) => trx.insertInto("memberships").values({ tenant_id: tenant.id, user_id: userId, role }).execute());
  return userId;
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 3 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 1 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb);
  a = createTenantFixture("Sessions tenant A");
  b = createTenantFixture("Sessions tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  const people: Array<[string, string]> = [
    ["ownerA", roleUser(a, "owner")],
    ["analystA", roleUser(a, "analyst")],
    ["memberA", await addMember(a, "creator")],
    ["ownerB", roleUser(b, "owner")],
  ];
  for (const [name, userId] of people) {
    users[name] = userId;
    consoleTokens[name] = (await identityRepo.createSession(db, userId, 60 * 60 * 1000)).token;
    respondentTokens[name] = (await identityRepo.createSession(db, userId, 60 * 60 * 1000)).token;
  }
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await owner?.destroy();
});

describe("sessions on an anyone-with-the-link form", () => {
  it("starts a session pinned to the live version and stores only the capability's hash", async () => {
    const f = await publishedForm();
    const before = Date.now();
    const res = await startSession(f.slug);
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const session = SessionStartResponseSchema.parse(res.body);
    expect(session).toMatchObject({ versionId: f.versionId, versionNumber: 1, accessMode: "public" });
    const ttl = Date.parse(session.expiresAt) - before;
    expect(ttl).toBeGreaterThan(2 * 60 * 60 * 1000 - 5000);
    expect(ttl).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 5000);

    const row = await withTenant(owner, a.id, (trx) => trx.selectFrom("respondent_sessions").selectAll().where("id", "=", session.sessionId).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ form_id: f.id, form_version_id: f.versionId, actor_id: null });
    expect(row.token_hash.equals(createHash("sha256").update(session.capability).digest())).toBe(true);
    expect(JSON.stringify(row)).not.toContain(session.capability);

    expect((await acceptance(session.sessionId, session.capability)).body).toEqual({ accepting: true, versionId: f.versionId });
  });

  it("only starts sessions from the respondent origin", async () => {
    const f = await publishedForm();
    expectProblem(await startSession(f.slug, undefined, "https://evil.example"), 403, "CROSS_ORIGIN_REQUEST");
    expectProblem(await startSession(f.slug, undefined, TEST_CONSOLE_ORIGIN), 403, "CROSS_ORIGIN_REQUEST");
  });

  it("rejects missing, forged, expired and mismatched capabilities", async () => {
    const f = await publishedForm();
    const one = SessionStartResponseSchema.parse((await startSession(f.slug)).body);
    const two = SessionStartResponseSchema.parse((await startSession(f.slug)).body);
    expectProblem(await request(app).get(`/public/v1/sessions/${one.sessionId}/acceptance`), 401, "SESSION_INVALID");
    expectProblem(await acceptance(one.sessionId, "A".repeat(43)), 401, "SESSION_INVALID");
    expectProblem(await acceptance(one.sessionId, "not a capability"), 401, "SESSION_INVALID");
    // One session's capability cannot act for another session.
    expectProblem(await acceptance(two.sessionId, one.capability), 401, "SESSION_INVALID");

    await withTenant(owner, a.id, (trx) =>
      sql`UPDATE app.respondent_sessions SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' WHERE id = ${one.sessionId}`.execute(trx),
    );
    expectProblem(await acceptance(one.sessionId, one.capability), 401, "SESSION_INVALID");
  });
});

describe("organization-only forms", () => {
  it("denies anonymous respondents and points them to sign-in", async () => {
    const f = await publishedForm();
    await membersOnly(f.path);
    for (const res of [await publicGet(f.slug), await startSession(f.slug)]) {
      expectProblem(res, 401, "SIGN_IN_REQUIRED");
      expect(res.headers["cache-control"]).toBe("no-store");
      const signIn = new URL(ProblemSchema.parse(res.body).signInUrl!);
      expect(signIn.origin).toBe(TEST_RESPONDENT_ORIGIN);
      expect(signIn.pathname).toBe("/public/v1/auth/login");
      expect(signIn.searchParams.get("returnTo")).toBe(`/f/${f.slug}`);
    }
    // The definition is not served to anonymous respondents at all.
    expect(JSON.stringify((await publicGet(f.slug)).body)).not.toContain("Staff survey");
  });

  it("does not accept the console cookie in place of a respondent sign-in", async () => {
    const f = await publishedForm();
    await membersOnly(f.path);
    const res = await request(app).post(`/public/v1/forms/${f.slug}/sessions`).set("Cookie", `we_session=${consoleTokens.ownerA}`).set("Origin", TEST_RESPONDENT_ORIGIN);
    expectProblem(res, 401, "SIGN_IN_REQUIRED");
  });

  it("refuses signed-in people from other organizations", async () => {
    const f = await publishedForm();
    await membersOnly(f.path);
    expectProblem(await publicGet(f.slug, "ownerB"), 403, "NOT_A_MEMBER");
    expectProblem(await startSession(f.slug, "ownerB"), 403, "NOT_A_MEMBER");
  });

  it("serves members privately and records who the session belongs to", async () => {
    const f = await publishedForm();
    await membersOnly(f.path);
    const page = await publicGet(f.slug, "memberA");
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("private, no-store");
    expect(PublicFormResponseSchema.parse(page.body).accessMode).toBe("organization");

    const session = SessionStartResponseSchema.parse((await startSession(f.slug, "memberA")).body);
    const row = await withTenant(owner, a.id, (trx) => trx.selectFrom("respondent_sessions").select("actor_id").where("id", "=", session.sessionId).executeTakeFirstOrThrow());
    expect(row.actor_id).toBe(users.memberA);
    expect((await acceptance(session.sessionId, session.capability)).body).toEqual({ accepting: true, versionId: f.versionId });
  });

  it("stops accepting a session as soon as the member is removed", async () => {
    const f = await publishedForm();
    await membersOnly(f.path);
    const leaver = await addMember(a, "analyst");
    const token = (await identityRepo.createSession(db, leaver, 60 * 60 * 1000)).token;
    const res = await request(app).post(`/public/v1/forms/${f.slug}/sessions`).set("Cookie", `we_respondent=${token}`).set("Origin", TEST_RESPONDENT_ORIGIN);
    const session = SessionStartResponseSchema.parse(res.body);

    await withTenant(db, a.id, (trx) => trx.updateTable("memberships").set({ status: "revoked" }).where("user_id", "=", leaver).execute());
    expectProblem(await acceptance(session.sessionId, session.capability), 403, "NOT_A_MEMBER");
  });

  it("applies a policy change to sessions that already started", async () => {
    const f = await publishedForm();
    const anonymous = SessionStartResponseSchema.parse((await startSession(f.slug)).body);
    await membersOnly(f.path);
    expectProblem(await acceptance(anonymous.sessionId, anonymous.capability), 403, "NOT_A_MEMBER");

    const back = await consolePatch(`${f.path}/access-policy`, "ownerA", { mode: "public" });
    expect(AccessPolicyResponseSchema.parse(back.body).mode).toBe("public");
    expect((await acceptance(anonymous.sessionId, anonymous.capability)).status).toBe(200);
  });

  it("is changed only by publishers in the organization, and audited", async () => {
    const f = await publishedForm();
    expect(AccessPolicyResponseSchema.parse((await request(app).get(`${f.path}/access-policy`).set("Cookie", `we_session=${consoleTokens.ownerA}`)).body).mode).toBe("public");
    expectProblem(await consolePatch(`${f.path}/access-policy`, "ownerB", { mode: "organization" }), 404, "NOT_FOUND");
    expectProblem(await consolePatch(`${f.path}/access-policy`, "ownerA", { mode: "everyone" }), 422, "VALIDATION_FAILED");
    // The analyst cannot see the form at all without a grant.
    expectProblem(await consolePatch(`${f.path}/access-policy`, "analystA", { mode: "organization" }), 404, "NOT_FOUND");

    await membersOnly(f.path);
    await membersOnly(f.path);
    expect(ShareResponseSchema.parse((await request(app).get(`${f.path}/share`).set("Cookie", `we_session=${consoleTokens.ownerA}`)).body).accessMode).toBe("organization");
    const audit = await withTenant(owner, a.id, (trx) =>
      trx.selectFrom("audit_events").select(["action", "metadata"]).where("resource_id", "=", f.id).where("action", "=", "form.access_policy_changed").execute(),
    );
    // Setting the same mode twice is one change.
    expect(audit).toEqual([{ action: "form.access_policy_changed", metadata: { changed: { mode: "organization" }, previous: { mode: "public" } } }]);
  });
});

describe("version and tenant binding", () => {
  it("cannot pin a session to another form's or another tenant's version", async () => {
    const f = await publishedForm();
    const g = await publishedForm();
    const other = await publishedForm(b, "ownerB");
    const row = (formId: string, versionId: string, tenantId = a.id) => ({
      tenant_id: tenantId,
      form_id: formId,
      form_version_id: versionId,
      token_hash: createHash("sha256").update(randomUUID()).digest(),
      actor_id: null,
      expires_at: new Date(Date.now() + 60_000),
    });
    const insert = (values: ReturnType<typeof row>) => withTenant(publicDb, a.id, (trx) => trx.insertInto("respondent_sessions").values(values).execute());

    // Another form's version in the same tenant.
    await expect(insert(row(f.id, g.versionId))).rejects.toMatchObject({ code: "23503" });
    // Another tenant's form and version, labelled as this tenant.
    await expect(insert(row(other.id, other.versionId))).rejects.toMatchObject({ code: "23503" });
    // Rows for another tenant are refused outright.
    await expect(insert(row(other.id, other.versionId, b.id))).rejects.toMatchObject({ code: "42501" });
    // The public role cannot rewrite a session's version or owner.
    const session = SessionStartResponseSchema.parse((await startSession(f.slug)).body);
    await expect(
      withTenant(publicDb, a.id, (trx) => trx.updateTable("respondent_sessions").set({ form_version_id: g.versionId }).where("id", "=", session.sessionId).execute()),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps sessions of one tenant invisible to another", async () => {
    const f = await publishedForm();
    const session = SessionStartResponseSchema.parse((await startSession(f.slug)).body);
    expect(await withTenant(publicDb, b.id, (trx) => trx.selectFrom("respondent_sessions").select("id").where("id", "=", session.sessionId).execute())).toEqual([]);
    expect(await publicDb.selectFrom("respondent_sessions").select("id").where("id", "=", session.sessionId).execute()).toEqual([]);
  });
});
