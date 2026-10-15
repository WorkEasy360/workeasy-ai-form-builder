import { randomUUID } from "node:crypto";
import { addField, updateField } from "@workeasy/builder";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { definitionFromTemplate } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DraftResponseSchema, FormResponseSchema, ProblemSchema, SaveDraftResponseSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN } from "./test-support.js";

/** Draft load/save with optimistic concurrency (BLD-02, groundwork for BLD-03). */
const urls = inject("testDatabase");

let db: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;
const auth = (req: request.Test, who: string) => req.set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);
const draftPath = (org: string, id: string) => `/api/v1/organizations/${org}/forms/${id}/draft`;

function getDraft(org: string, id: string, who: string) {
  return auth(request(app).get(draftPath(org, id)), who);
}

function saveDraft(org: string, id: string, who: string, definition: unknown, ifMatch?: string) {
  const req = auth(request(app).put(draftPath(org, id)), who).send(definition as object);
  return ifMatch === undefined ? req : req.set("If-Match", ifMatch);
}

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const problem = ProblemSchema.parse(res.body);
  expect(problem.code).toBe(code);
  return problem;
}

async function newForm(who: string, template?: string): Promise<string> {
  const res = await auth(request(app).post(`/api/v1/organizations/${a.id}/forms`), who).send(template ? { name: "Draft test", template } : { name: "Draft test" });
  expect(res.status).toBe(201);
  return FormResponseSchema.parse(res.body).form.id;
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  app = buildTestApp(db);
  a = createTenantFixture("Drafts tenant A");
  b = createTenantFixture("Drafts tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  const sign = async (name: string, userId: string) => {
    tokens[name] = (await identityRepo.createSession(db, userId, 3_600_000)).token;
  };
  await sign("ownerA", roleUser(a, "owner"));
  await sign("analystA", roleUser(a, "analyst"));
  await sign("ownerB", roleUser(b, "owner"));
  const creator = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `drafts-${randomUUID()}` });
  await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: creator, role: "creator" }).execute());
  await sign("creatorA", creator);
});

afterAll(async () => {
  await db?.destroy();
});

describe("loading a draft", () => {
  it("returns a blank draft with its revision and what is missing", async () => {
    const id = await newForm("creatorA");
    const res = await getDraft(a.id, id, "creatorA");
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"draft-1"');
    const body = DraftResponseSchema.parse(res.body);
    expect(body.revision).toBe(1);
    expect(body.definition).toMatchObject({ title: "Draft test", fields: [] });
    expect(body.issues.map((i) => i.code)).toEqual(["SCHEMA_MINITEMS"]);
  });

  it("needs edit access and stays inside the organization", async () => {
    const id = await newForm("creatorA");
    expectProblem(await getDraft(a.id, id, "analystA"), 404, "NOT_FOUND");
    expectProblem(await getDraft(a.id, id, "ownerB"), 404, "NOT_FOUND");
    expectProblem(await getDraft(b.id, id, "ownerB"), 404, "NOT_FOUND");
  });
});

describe("saving a draft", () => {
  it("saves builder edits, bumps the revision and reports remaining issues", async () => {
    const id = await newForm("creatorA");
    const { definition } = DraftResponseSchema.parse((await getDraft(a.id, id, "creatorA")).body);
    let next = definition as unknown as FormDefinition;
    const added = addField(next, "email", next.pages[0]!.id);
    next = updateField(added.definition, added.fieldId, { label: "Work email", required: true });

    const res = await saveDraft(a.id, id, "creatorA", next, '"draft-1"');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"draft-2"');
    expect(SaveDraftResponseSchema.parse(res.body)).toEqual({ revision: 2, issues: [] });

    const reloaded = DraftResponseSchema.parse((await getDraft(a.id, id, "creatorA")).body);
    expect(reloaded.revision).toBe(2);
    expect(reloaded.definition).toEqual(next);
  });

  it("keeps semantic problems as issues without blocking the save", async () => {
    const id = await newForm("creatorA", "contact");
    const def = definitionFromTemplate("contact", "Contact")!;
    def.fields[0]!.settings = { minLength: 10, maxLength: 5 };
    const res = await saveDraft(a.id, id, "creatorA", def, '"draft-1"');
    expect(res.status).toBe(200);
    expect(SaveDraftResponseSchema.parse(res.body).issues.map((i) => i.code)).toEqual(["INVERTED_RANGE"]);
  });

  it("rejects a stale revision with 412 and never overwrites newer changes", async () => {
    const id = await newForm("creatorA", "contact");
    const first = definitionFromTemplate("contact", "Saved first")!;
    const second = definitionFromTemplate("contact", "Saved second")!;
    expect((await saveDraft(a.id, id, "creatorA", first, '"draft-1"')).status).toBe(200);
    const stale = expectProblem(await saveDraft(a.id, id, "ownerA", second, '"draft-1"'), 412, "DRAFT_CONFLICT");
    expect(stale.currentRevision).toBe(2);
    const current = DraftResponseSchema.parse((await getDraft(a.id, id, "creatorA")).body);
    expect(current.definition).toMatchObject({ title: "Saved first" });
  });

  it("lets exactly one of two concurrent saves of the same revision win", async () => {
    const id = await newForm("creatorA", "contact");
    const results = await Promise.all([
      saveDraft(a.id, id, "creatorA", definitionFromTemplate("contact", "One")!, '"draft-1"'),
      saveDraft(a.id, id, "ownerA", definitionFromTemplate("contact", "Two")!, '"draft-1"'),
    ]);
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 412]);
    expect(DraftResponseSchema.parse((await getDraft(a.id, id, "creatorA")).body).revision).toBe(2);
  });

  it("requires a well-formed If-Match", async () => {
    const id = await newForm("creatorA");
    const def = definitionFromTemplate("contact", "x");
    expectProblem(await saveDraft(a.id, id, "creatorA", def), 428, "IF_MATCH_REQUIRED");
    expectProblem(await saveDraft(a.id, id, "creatorA", def, "*"), 400, "INVALID_IF_MATCH");
    expectProblem(await saveDraft(a.id, id, "creatorA", def, 'W/"draft-1"'), 400, "INVALID_IF_MATCH");
  });

  it("rejects malformed definitions with field paths", async () => {
    const id = await newForm("creatorA");
    const bad = { ...definitionFromTemplate("contact", "x")!, theme: { accent: "red" } };
    const problem = expectProblem(await saveDraft(a.id, id, "creatorA", bad, '"draft-1"'), 422, "VALIDATION_FAILED");
    expect(problem.errors?.some((e) => e.field.startsWith("/theme"))).toBe(true);
    const executable = { ...definitionFromTemplate("contact", "x")!, onload: "alert(1)" };
    expectProblem(await saveDraft(a.id, id, "creatorA", executable, '"draft-1"'), 422, "VALIDATION_FAILED");
    // Nothing was saved.
    expect(DraftResponseSchema.parse((await getDraft(a.id, id, "creatorA")).body).revision).toBe(1);
  });

  it("refuses edits to archived forms", async () => {
    const id = await newForm("creatorA");
    expect((await auth(request(app).post(`/api/v1/organizations/${a.id}/forms/${id}/archive`), "creatorA")).status).toBe(200);
    expectProblem(await saveDraft(a.id, id, "creatorA", definitionFromTemplate("contact", "x"), '"draft-1"'), 409, "FORM_ARCHIVED");
  });

  it("needs edit access, the console origin, and the right organization", async () => {
    const id = await newForm("creatorA");
    const def = definitionFromTemplate("contact", "x");
    expectProblem(await saveDraft(a.id, id, "analystA", def, '"draft-1"'), 404, "NOT_FOUND");
    expectProblem(await saveDraft(a.id, id, "ownerB", def, '"draft-1"'), 404, "NOT_FOUND");
    const crossSite = await request(app).put(draftPath(a.id, id)).set("Cookie", `we_session=${tokens.creatorA}`).set("If-Match", '"draft-1"').send(def!);
    expectProblem(crossSite, 403, "CROSS_ORIGIN_REQUEST");
  });
});
