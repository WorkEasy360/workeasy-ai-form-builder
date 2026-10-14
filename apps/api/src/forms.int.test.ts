import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { definitionFromTemplate } from "@workeasy/form-engine";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  FormGrantsResponseSchema,
  FormListResponseSchema,
  FormResponseSchema,
  FormTemplatesResponseSchema,
  ProblemSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN } from "./test-support.js";

/** BLD-01: form list, create, duplicate and archive with grants. */
const urls = inject("testDatabase");

let db: Db;
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

async function addMember(tenant: TenantFixture, role: "creator" | "analyst") {
  const userId = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `forms-test-${randomUUID()}` });
  await withTenant(db, tenant.id, (trx) => trx.insertInto("memberships").values({ tenant_id: tenant.id, user_id: userId, role }).execute());
  return userId;
}

const get = (path: string, who: string) => request(app).get(path).set("Cookie", `we_session=${tokens[who]}`);
const post = (path: string, who: string, body: object = {}) =>
  request(app).post(path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN).send(body);

const forms = (org: string) => `/api/v1/organizations/${org}/forms`;
const form = (org: string, id: string) => `${forms(org)}/${id}`;

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

async function draftRow(tenantId: string, formId: string) {
  return withTenant(db, tenantId, (trx) =>
    trx.selectFrom("form_drafts").select(["revision", "definition", "workflow_draft"]).where("form_id", "=", formId).executeTakeFirst(),
  );
}

async function createAs(who: string, name: string, template?: string) {
  const res = await post(forms(a.id), who, template ? { name, template } : { name });
  expect(res.status).toBe(201);
  return FormResponseSchema.parse(res.body);
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  app = buildTestApp(db);
  a = createTenantFixture("Forms tenant A");
  b = createTenantFixture("Forms tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  await signIn("ownerA", roleUser(a, "owner"));
  await signIn("analystA", roleUser(a, "analyst"));
  await signIn("ownerB", roleUser(b, "owner"));
  await signIn("creatorA", await addMember(a, "creator"));
  await signIn("otherCreatorA", await addMember(a, "creator"));
});

afterAll(async () => {
  await db?.destroy();
});

describe("create", () => {
  it("creates a blank draft form and grants its creator edit, publish and access management", async () => {
    const res = await post(forms(a.id), "creatorA", { name: "  Visitor sign-up  " });
    expect(res.status).toBe(201);
    expect(res.headers.etag).toBe('"draft-1"');
    const body = FormResponseSchema.parse(res.body);
    expect(res.headers.location).toBe(form(a.id, body.form.id));
    expect(body.form).toMatchObject({ name: "Visitor sign-up", state: "draft", ownerId: users.creatorA });
    expect(body.form.slug).toMatch(/^f-[a-z0-9]{12}$/);
    expect(body.form.permissions).toEqual(["forms.read", "forms.edit", "forms.publish", "forms.manage_access"]);
    expect(body.draft.revision).toBe(1);

    const draft = await draftRow(a.id, body.form.id);
    expect(draft).toMatchObject({ revision: 1, definition: { title: "Visitor sign-up", fields: [] }, workflow_draft: {} });
    const grants = FormGrantsResponseSchema.parse((await get(`${form(a.id, body.form.id)}/grants`, "creatorA")).body).grants;
    expect(grants.map((g) => g.permission).toSorted()).toEqual(["forms.edit", "forms.manage_access", "forms.publish"]);
  });

  it("starts from a built-in template", async () => {
    const templates = FormTemplatesResponseSchema.parse((await get("/api/v1/form-templates", "creatorA")).body).templates;
    expect(templates.map((t) => t.id)).toEqual(["contact", "support-request", "feedback"]);
    const body = await createAs("creatorA", "IT helpdesk", "support-request");
    const draft = await draftRow(a.id, body.form.id);
    expect(draft?.definition).toEqual(definitionFromTemplate("support-request", "IT helpdesk"));
  });

  it("validates the name and template", async () => {
    expectProblem(await post(forms(a.id), "creatorA", { name: "   " }), 422, "VALIDATION_FAILED");
    expectProblem(await post(forms(a.id), "creatorA", { name: "x".repeat(201) }), 422, "VALIDATION_FAILED");
    expectProblem(await post(forms(a.id), "creatorA", { name: "Ok", template: "payroll-export" }), 422, "VALIDATION_FAILED");
  });

  it("requires forms.create, and never creates in another organization", async () => {
    expectProblem(await post(forms(a.id), "analystA", { name: "Not allowed" }), 403, "FORBIDDEN");
    expectProblem(await post(forms(a.id), "ownerB", { name: "Wrong tenant" }), 404, "NOT_FOUND");
  });

  it("rejects cookie-authenticated creation from another origin", async () => {
    const res = await request(app).post(forms(a.id)).set("Cookie", `we_session=${tokens.creatorA}`).send({ name: "CSRF" });
    expectProblem(res, 403, "CROSS_ORIGIN_REQUEST");
  });
});

describe("visibility", () => {
  it("shows a new form to its creator and owners, not to members without grants", async () => {
    const { form: created } = await createAs("creatorA", "Private draft");
    const listIds = async (who: string) => FormListResponseSchema.parse((await get(forms(a.id), who)).body).items.map((f) => f.id);
    expect(await listIds("creatorA")).toContain(created.id);
    expect(await listIds("ownerA")).toContain(created.id);
    expect(await listIds("otherCreatorA")).not.toContain(created.id);
    expectProblem(await get(form(a.id, created.id), "otherCreatorA"), 404, "NOT_FOUND");
    expectProblem(await get(form(a.id, created.id), "analystA"), 404, "NOT_FOUND");
  });

  it("returns 404 for a form addressed through another organization", async () => {
    const { form: created } = await createAs("creatorA", "Tenant A only");
    expectProblem(await get(form(b.id, created.id), "ownerB"), 404, "NOT_FOUND");
    expectProblem(await get(form(a.id, created.id), "ownerB"), 404, "NOT_FOUND");
    expectProblem(await get(form(b.id, created.id), "ownerA"), 404, "NOT_FOUND");
  });

  it("reports each caller's effective permissions", async () => {
    const { form: created } = await createAs("creatorA", "Permission view");
    const ownerView = FormResponseSchema.parse((await get(form(a.id, created.id), "ownerA")).body);
    expect(ownerView.form.permissions).toHaveLength(11);
    const listed = FormListResponseSchema.parse((await get(forms(a.id), "creatorA")).body).items.find((f) => f.id === created.id);
    expect(listed?.permissions).toEqual(["forms.read", "forms.edit", "forms.publish", "forms.manage_access"]);
  });
});

describe("duplicate", () => {
  it("copies only the draft definition into an independent form", async () => {
    const source = await createAs("creatorA", "Onboarding", "contact");
    // Give an analyst access and attach workflow configuration to the source.
    const grants = await request(app)
      .put(`${form(a.id, source.form.id)}/grants`)
      .set("Cookie", `we_session=${tokens.creatorA}`)
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .send({
        grants: [
          ...["forms.edit", "forms.publish", "forms.manage_access"].map((permission) => ({ principalType: "user", principalId: users.creatorA, permission })),
          { principalType: "user", principalId: users.analystA, permission: "responses.read" },
        ],
      });
    expect(grants.status).toBe(200);
    await withTenant(db, a.id, (trx) =>
      trx.updateTable("form_drafts").set({ workflow_draft: { webhookConnection: "secret-ref-123" } }).where("form_id", "=", source.form.id).execute(),
    );

    const res = await post(`${form(a.id, source.form.id)}/duplicate`, "creatorA", { name: "Onboarding (copy)" });
    expect(res.status).toBe(201);
    const copy = FormResponseSchema.parse(res.body);
    expect(copy.form.id).not.toBe(source.form.id);
    expect(copy.form.slug).not.toBe(source.form.slug);
    expect(copy.form).toMatchObject({ name: "Onboarding (copy)", state: "draft", ownerId: users.creatorA });
    expect(copy.draft.revision).toBe(1);

    const [sourceDraft, copyDraft] = await Promise.all([draftRow(a.id, source.form.id), draftRow(a.id, copy.form.id)]);
    expect(copyDraft?.definition).toEqual({ ...sourceDraft!.definition, title: "Onboarding (copy)" });
    expect(copyDraft?.workflow_draft).toEqual({});

    const copyGrants = FormGrantsResponseSchema.parse((await get(`${form(a.id, copy.form.id)}/grants`, "creatorA")).body).grants;
    expect(copyGrants.every((g) => g.principalId === users.creatorA)).toBe(true);
    expectProblem(await get(form(a.id, copy.form.id), "analystA"), 404, "NOT_FOUND");
  });

  it("needs forms.create and edit access to the source", async () => {
    const source = await createAs("creatorA", "Restricted source");
    await request(app)
      .put(`${form(a.id, source.form.id)}/grants`)
      .set("Cookie", `we_session=${tokens.creatorA}`)
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .send({
        grants: [
          { principalType: "user", principalId: users.creatorA, permission: "forms.edit" },
          { principalType: "user", principalId: users.creatorA, permission: "forms.publish" },
          { principalType: "user", principalId: users.creatorA, permission: "forms.manage_access" },
          { principalType: "user", principalId: users.otherCreatorA, permission: "forms.read" },
          { principalType: "user", principalId: users.analystA, permission: "forms.edit" },
        ],
      });
    // Can read but not edit the source.
    expectProblem(await post(`${form(a.id, source.form.id)}/duplicate`, "otherCreatorA", { name: "Copy" }), 403, "FORBIDDEN");
    // Can edit the source but may not create forms.
    expectProblem(await post(`${form(a.id, source.form.id)}/duplicate`, "analystA", { name: "Copy" }), 403, "FORBIDDEN");
    // Another organization cannot see the source at all.
    expectProblem(await post(`${form(a.id, source.form.id)}/duplicate`, "ownerB", { name: "Copy" }), 404, "NOT_FOUND");
    expectProblem(await post(`${form(b.id, source.form.id)}/duplicate`, "ownerB", { name: "Copy" }), 404, "NOT_FOUND");
    expectProblem(await post(`${form(a.id, source.form.id)}/duplicate`, "creatorA", {}), 422, "VALIDATION_FAILED");
  });
});

describe("archive and restore", () => {
  it("archives, hides from the default list, and restores to draft", async () => {
    const { form: created } = await createAs("creatorA", "Seasonal survey");
    const archived = await post(`${form(a.id, created.id)}/archive`, "creatorA");
    expect(archived.status).toBe(200);
    expect(FormResponseSchema.parse(archived.body).form.state).toBe("archived");

    const defaultList = FormListResponseSchema.parse((await get(forms(a.id), "creatorA")).body).items.map((f) => f.id);
    expect(defaultList).not.toContain(created.id);
    const archivedList = FormListResponseSchema.parse((await get(`${forms(a.id)}?state=archived`, "creatorA")).body).items.map((f) => f.id);
    expect(archivedList).toContain(created.id);

    expectProblem(await post(`${form(a.id, created.id)}/archive`, "creatorA"), 409, "FORM_STATE_CONFLICT");
    const restored = await post(`${form(a.id, created.id)}/restore`, "creatorA");
    expect(FormResponseSchema.parse(restored.body).form.state).toBe("draft");
    expectProblem(await post(`${form(a.id, created.id)}/restore`, "creatorA"), 409, "FORM_STATE_CONFLICT");
  });

  it("lets exactly one of two concurrent archive requests win", async () => {
    const { form: created } = await createAs("creatorA", "Race");
    const results = await Promise.all([post(`${form(a.id, created.id)}/archive`, "creatorA"), post(`${form(a.id, created.id)}/archive`, "ownerA")]);
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
  });

  it("requires forms.publish and stays inside the organization", async () => {
    const { form: created } = await createAs("creatorA", "Guarded");
    await request(app)
      .put(`${form(a.id, created.id)}/grants`)
      .set("Cookie", `we_session=${tokens.creatorA}`)
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .send({ grants: [{ principalType: "user", principalId: users.analystA, permission: "responses.read" }] });
    expectProblem(await post(`${form(a.id, created.id)}/archive`, "analystA"), 403, "FORBIDDEN");
    expectProblem(await post(`${form(a.id, created.id)}/archive`, "otherCreatorA"), 404, "NOT_FOUND");
    expectProblem(await post(`${form(a.id, created.id)}/archive`, "ownerB"), 404, "NOT_FOUND");
    expectProblem(await post(`${form(b.id, created.id)}/archive`, "ownerB"), 404, "NOT_FOUND");
    // Owners hold forms.publish through their role.
    expect((await post(`${form(a.id, created.id)}/archive`, "ownerA")).status).toBe(200);
  });
});
