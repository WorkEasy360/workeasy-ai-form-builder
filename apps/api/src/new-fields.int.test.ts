import { randomUUID } from "node:crypto";
import { createDb, identityRepo, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { processExports } from "@workeasy/responses";
import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  ExportSchema,
  FormResponseSchema,
  ProblemSchema,
  PublishResponseSchema,
  ResponseDetailResponseSchema,
  ResponseListResponseSchema,
  SessionStartResponseSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_RESPONDENT_ORIGIN, testObjectStore, testSettings, unusedIdentityProvider } from "./test-support.js";

/** PAR-03: name, address, date and time, slider, section headings and descriptions end to end. Needs `pnpm infra:up`. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let workerDb: Db;
let app: Express;
let a: TenantFixture;
const tokens: Record<string, string> = {};

const consoleReq = (method: "get" | "post" | "put", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens.owner}`).set("Origin", TEST_CONSOLE_ORIGIN);

function definition(): FormDefinition {
  const def = blankDefinition("Registration");
  def.fields = [
    { id: "f_intro", type: "section", label: "About you", helpText: "So we can reach you.", required: false, settings: {} },
    { id: "f_name", type: "name", label: "Your name", required: true, settings: {} },
    { id: "f_address", type: "address", label: "Postal address", required: false, settings: {} },
    { id: "f_when", type: "date_time", label: "Arrival", required: false, settings: {} },
    { id: "f_score", type: "slider", label: "How excited are you?", required: false, settings: { min: 0, max: 10, step: 1 } },
    { id: "f_note", type: "description", label: "We'll email you a confirmation.", required: false, settings: {} },
  ];
  def.pages = [{ id: "page_1", title: "", fieldIds: def.fields.map((f) => f.id) }];
  return def;
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 4 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb);
  a = createTenantFixture("New fields tenant");
  await seedTenantFixture(db, a);
  tokens.owner = (await identityRepo.createSession(db, a.members.find((m) => m.role === "owner")!.user.id, 3_600_000)).token;
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await workerDb?.destroy();
});

describe("new field types end to end", () => {
  it("publish, take answers, store them canonically, and show and export them without the layout items", async () => {
    const created = FormResponseSchema.parse((await consoleReq("post", `/api/v1/organizations/${a.id}/forms`).send({ name: "Registration" })).body);
    const path = `/api/v1/organizations/${a.id}/forms/${created.form.id}`;
    const saved = await consoleReq("put", `${path}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(definition());
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const published = await consoleReq("post", `${path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `k-${randomUUID()}`);
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    PublishResponseSchema.parse(published.body);

    const session = SessionStartResponseSchema.parse((await request(app).post(`/public/v1/forms/${created.form.slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body);
    const submit = (answers: Record<string, unknown>) =>
      request(app)
        .post(`/public/v1/sessions/${session.sessionId}/submissions`)
        .set("Authorization", `Bearer ${session.capability}`)
        .set("Idempotency-Key", `k-${randomUUID()}`)
        .send({ formVersionId: session.versionId, answers });

    const refused = await submit({ f_name: { first: "Ada" }, f_intro: "not an answer" });
    expect(refused.status).toBe(422);
    expect(ProblemSchema.parse(refused.body).errors?.map((e) => e.code).toSorted()).toEqual(["INCOMPLETE", "NOT_AN_INPUT"]);

    const accepted = await submit({
      f_name: { first: "Ada", last: "Lovelace" },
      f_address: { line1: "12 St James's Square", city: "London", postalCode: "SW1Y 4JH", country: "United Kingdom" },
      f_when: "2026-11-02T09:15",
      f_score: 9,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const id = accepted.body.submissionId as string;

    // The list shows only answerable questions, with readable text for the new types.
    const list = ResponseListResponseSchema.parse((await consoleReq("get", `${path}/submissions`)).body);
    expect(list.columns.map((c) => c.fieldId)).toEqual(["f_name", "f_address", "f_when", "f_score"]);
    const row = list.items.find((r) => r.id === id)!;
    expect(Object.keys(row.answers).toSorted()).toEqual(["f_address", "f_name", "f_score", "f_when"]);
    expect(row.answers.f_name).toMatchObject({ masked: false, value: { first: "Ada", last: "Lovelace" }, display: "Ada Lovelace" });
    expect(row.answers.f_address).toMatchObject({ display: "12 St James's Square, London, SW1Y 4JH, United Kingdom" });
    expect(row.answers.f_when).toMatchObject({ value: "2026-11-02T09:15", display: "2026-11-02 09:15" });
    expect(row.answers.f_score).toMatchObject({ value: 9, display: "9" });

    const detail = ResponseDetailResponseSchema.parse((await consoleReq("get", `${path}/submissions/${id}`)).body);
    expect(detail.fields.map((f) => f.fieldId)).toEqual(["f_name", "f_address", "f_when", "f_score"]);
    // Name and address default to personal data.
    expect(detail.fields.find((f) => f.fieldId === "f_address")).toMatchObject({ privacy: "personal" });

    // "Contains" searches inside the parts of an address.
    const found = ResponseListResponseSchema.parse((await consoleReq("get", `${path}/submissions?field=f_address&op=contains&value=st%20james`)).body);
    expect(found.items.map((r) => r.id)).toEqual([id]);
    const missed = ResponseListResponseSchema.parse((await consoleReq("get", `${path}/submissions?field=f_address&op=contains&value=paris`)).body);
    expect(missed.items).toEqual([]);

    // Raw exports keep the parts as JSON, readable exports as text; layout items are no columns.
    const exportCsv = async (raw: boolean) => {
      const requested = await consoleReq("post", `${path}/exports`).send({ raw });
      expect(requested.status, JSON.stringify(requested.body)).toBe(202);
      const exportId = ExportSchema.parse(requested.body).id;
      while ((await processExports({ workerDb, store: testObjectStore() }, 5)) > 0);
      const link = await consoleReq("get", `/api/v1/organizations/${a.id}/exports/${exportId}/download`);
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      const csv = new TextDecoder().decode(await (await fetch(link.body.url as string)).arrayBuffer());
      return csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/) as [string, string];
    };
    const [readableHeader, readableLine] = await exportCsv(false);
    expect(readableHeader).not.toMatch(/About you|confirmation/);
    expect(readableLine).toContain("Ada Lovelace");
    expect(readableLine).toContain("2026-11-02 09:15");
    const [rawHeader, rawLine] = await exportCsv(true);
    expect(rawHeader).toBe("submission_id,received_at,version,f_name,f_address,f_when,f_score");
    expect(rawLine).toContain('"{""first"":""Ada"",""last"":""Lovelace""}"');
    expect(rawLine).toContain(`""line1"":""12 St James's Square"",""city"":""London""`);
  });
});
