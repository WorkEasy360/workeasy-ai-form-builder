import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { AccessPolicyResponseSchema, FormResponseSchema, ProblemSchema, SessionStartResponseSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** PAR-04: spam protection and the redirect after submitting. Needs `pnpm infra:up`. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let owner: Db;
/** The real two-second minimum, as in production. */
let app: Express;
let a: TenantFixture;
const tokens: Record<string, string> = {};

const consoleReq = (method: "get" | "post" | "put" | "patch", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens.owner}`).set("Origin", TEST_CONSOLE_ORIGIN);

function definition(success: FormDefinition["success"] = { message: "Thanks!" }): FormDefinition {
  const def = blankDefinition("Contact");
  def.fields = [{ id: "f_name", type: "text", label: "Name", required: true, settings: {} }];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_name"] }];
  def.success = success;
  return def;
}

async function publishedForm(def = definition()) {
  const created = FormResponseSchema.parse((await consoleReq("post", `/api/v1/organizations/${a.id}/forms`).send({ name: "Contact" })).body);
  const path = `/api/v1/organizations/${a.id}/forms/${created.form.id}`;
  const saved = await consoleReq("put", `${path}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(def);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const published = await consoleReq("post", `${path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `k-${randomUUID()}`);
  return { id: created.form.id, slug: created.form.slug, path, published, revision: saved.body.revision as number };
}

const open = async (slug: string) => SessionStartResponseSchema.parse((await request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body);
const submit = (s: { sessionId: string; capability: string; versionId: string }, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/public/v1/sessions/${s.sessionId}/submissions`)
    .set("Authorization", `Bearer ${s.capability}`)
    .set("Idempotency-Key", `k-${randomUUID()}`)
    .send({ formVersionId: s.versionId, answers: { f_name: "Ada" }, ...extra });
/** Stands in for a person taking their time: the session was opened five seconds ago. */
const age = (sessionId: string) =>
  withTenant(owner, a.id, (trx) => trx.updateTable("respondent_sessions").set({ created_at: sql`now() - interval '5 seconds'` as never }).where("id", "=", sessionId).execute());
const stored = (formId: string) => withTenant(owner, a.id, (trx) => trx.selectFrom("submissions").select("id").where("form_id", "=", formId).execute());

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 4 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  const { minFillMs: _testMinimum, ...production } = testSettings;
  app = buildTestApp(db, unusedIdentityProvider, production, publicDb);
  a = createTenantFixture("Settings tenant");
  await seedTenantFixture(db, a);
  tokens.owner = (await identityRepo.createSession(db, a.members.find((m) => m.role === "owner")!.user.id, 3_600_000)).token;
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await owner?.destroy();
});

describe("spam protection", () => {
  it("is on by default, and refuses instant submissions and filled-in honeypots without storing anything", async () => {
    const form = await publishedForm();
    expect(AccessPolicyResponseSchema.parse((await consoleReq("get", `${form.path}/access-policy`)).body).spamProtection).toBe(true);

    const fast = await open(form.slug);
    const blocked = await submit(fast);
    expect(blocked.status).toBe(422);
    expect(ProblemSchema.parse(blocked.body)).toMatchObject({ code: "SUBMISSION_BLOCKED" });

    const bot = await open(form.slug);
    await age(bot.sessionId);
    expect(ProblemSchema.parse((await submit(bot, { hp: "https://spam.example" })).body).code).toBe("SUBMISSION_BLOCKED");
    expect(await stored(form.id)).toEqual([]);

    // A person who took a few seconds gets through; so does the earlier session once enough time has passed.
    const person = await open(form.slug);
    await age(person.sessionId);
    expect((await submit(person)).status).toBe(201);
    await age(fast.sessionId);
    expect((await submit(fast)).status).toBe(201);
    expect(await stored(form.id)).toHaveLength(2);
  });

  it("can be turned off by people who publish, which lets instant submissions through, and is audited", async () => {
    const form = await publishedForm();
    const off = await consoleReq("patch", `${form.path}/access-policy`).send({ spamProtection: false });
    expect(AccessPolicyResponseSchema.parse(off.body)).toMatchObject({ spamProtection: false, mode: "public" });
    expect((await submit(await open(form.slug))).status).toBe(201);
    const audit = await withTenant(owner, a.id, (trx) =>
      trx.selectFrom("audit_events").select("metadata").where("resource_id", "=", form.id).where("action", "=", "form.access_policy_changed").execute(),
    );
    expect(audit.at(-1)!.metadata).toEqual({ changed: { spamProtection: false }, previous: { spamProtection: true } });
  });
});

describe("redirect after submitting", () => {
  it("is published with the form and refused unless it is a plain web address", async () => {
    const form = await publishedForm(definition({ message: "Thanks!", redirectUrl: "https://example.com/next" }));
    expect(form.published.status, JSON.stringify(form.published.body)).toBe(201);
    const page = await request(app).get(`/public/v1/forms/${form.slug}`);
    expect(page.body.definition.success).toEqual({ message: "Thanks!", redirectUrl: "https://example.com/next" });

    const refused = await consoleReq("put", `${form.path}/draft`)
      .set("If-Match", `"draft-${form.revision}"`)
      .send(definition({ message: "Thanks!", redirectUrl: "ftp://example.com/x" }));
    expect(refused.status).toBe(422);

    // Credentials in the address pass the format check but can't be published.
    const saved = await consoleReq("put", `${form.path}/draft`)
      .set("If-Match", `"draft-${form.revision}"`)
      .send(definition({ message: "Thanks!", redirectUrl: "https://user:secret@example.com/" }));
    expect(saved.status).toBe(200);
    const publish = await consoleReq("post", `${form.path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `k-${randomUUID()}`);
    expect(publish.status).toBe(422);
    expect(ProblemSchema.parse(publish.body).errors?.map((e) => e.code)).toContain("INVALID_REDIRECT");
  });
});