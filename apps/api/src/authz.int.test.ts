import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { AI_GENERATE_JOB, aiGenerationJob, stubProvider } from "@workeasy/ai";
import { scanPendingUploads, type ObjectStore } from "@workeasy/files";
import { createMailer, DELIVER_JOB, deliverJob, FANOUT_JOB, fanoutJob } from "@workeasy/integrations";
import { dispatchOutbox, runJobs, type JobRegistry } from "@workeasy/jobs";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { FormResponseSchema, PublishResponseSchema, SessionStartResponseSchema, UploadCreateResponseSchema, UploadStatusResponseSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_INTEGRATION_KEY, TEST_RESPONDENT_ORIGIN, testObjectStore, testSettings, unusedIdentityProvider } from "./test-support.js";

/**
 * SEC-01: negative authorization suite. Every console route in the OpenAPI
 * contract is called with tenant A's real resource IDs by people who must
 * get nothing: signed-out callers, tenant B's owner (through tenant A's
 * organization and through their own), and a tenant A member without
 * grants. Afterwards tenant A's data must be byte-for-byte unchanged and no
 * response may carry tenant A's content. Routes added to the contract are
 * covered automatically; a route with an unknown path parameter fails the
 * suite until it is given an ID here. Needs `pnpm infra:up`.
 */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let workerDb: Db;
let owner: Db;
let app: Express;
let store: ObjectStore;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const SECRET_FORM_NAME = "Payroll corrections";
const SECRET_ANSWER = "Answer-only-tenant-A-may-read";
const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;

type Method = "get" | "post" | "put" | "patch" | "delete";
interface Route {
  method: Method;
  template: string;
}

/** Every /api/v1 route in the published contract. */
function contractRoutes(): Route[] {
  const spec = JSON.parse(readFileSync(new URL("../../../contracts/openapi.json", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(spec.paths).flatMap(([template, ops]) =>
    template.startsWith("/api/v1/")
      ? (Object.keys(ops).filter((m) => ["get", "post", "put", "patch", "delete"].includes(m)) as Method[]).map((method) => ({ method, template }))
      : [],
  );
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (!value) throw new Error(`No test ID for path parameter {${name}} in ${template}; add one to the authorization suite`);
    return value;
  });
}

/** Bodies and headers valid enough to get past request validation, so the authorization check is what answers. */
function bodyFor(route: Route): { body?: unknown; headers?: Record<string, string> } {
  const key = `${route.method.toUpperCase()} ${route.template.replace("/api/v1/organizations/{orgId}", "")}`;
  const bodies: Record<string, { body?: unknown; headers?: Record<string, string> }> = {
    "POST /forms": { body: { name: "Injected" } },
    "DELETE /forms/{formId}": { body: { reason: "attacker cleanup" } },
    "PUT /forms/{formId}/draft": { body: definition(), headers: { "If-Match": '"draft-2"' } },
    "POST /forms/{formId}/duplicate": { body: { name: "Copy" } },
    "POST /forms/{formId}/publish": { headers: { "If-Match": '"draft-2"', "Idempotency-Key": `attack-${randomUUID()}` } },
    "POST /forms/{formId}/activate-version": { body: { versionId: ids.versionId } },
    "POST /forms/{formId}/close": { body: {} },
    "DELETE /forms/{formId}/submissions/{submissionId}": { body: { reason: "attacker cleanup" } },
    "PATCH /forms/{formId}/retention": { body: { legalHold: false, retentionDays: 1 } },
    "PATCH /members/{userId}": { body: { status: "revoked" } },
    "POST /invitations": { body: { role: "analyst" } },
    "POST /api/v1/invitations/accept": { body: { token: "x".repeat(43) } },
    "POST /forms/{formId}/ai-jobs": { body: { prompt: "Make a form", operation: "create", baseRevision: 2 } },
    "PUT /ai-settings": { body: { enabled: false, dailyTokenLimit: 1000 } },
    "POST /ai-jobs/{jobId}/apply": { body: { expectedRevision: 2 } },
    "POST /forms/{formId}/integrations": { body: { kind: "email", name: "Exfiltrate", recipients: ["attacker@example.test"] } },
    "PATCH /integrations/{integrationId}": { body: { recipients: ["attacker@example.test"] } },
    "POST /forms/{formId}/exports": { body: {} },
    "PATCH /forms/{formId}/access-policy": { body: { mode: "public", maxResponses: null } },
    "PUT /forms/{formId}/grants": { body: { grants: [] } },
  };
  return bodies[key] ?? {};
}

function call(route: Route, path: string, who?: string, origin = true) {
  let req = request(app)[route.method](path);
  if (who) req = req.set("Cookie", `we_session=${tokens[who]}`);
  if (origin) req = req.set("Origin", TEST_CONSOLE_ORIGIN);
  const { body, headers } = bodyFor(route);
  for (const [name, value] of Object.entries(headers ?? {})) req = req.set(name, value);
  return body === undefined ? req : req.send(body as object);
}

function definition(): FormDefinition {
  const def = blankDefinition(SECRET_FORM_NAME);
  def.fields = [
    { id: "f_name", type: "text", label: "Name", required: true, settings: {} },
    { id: "f_receipt", type: "file", label: "Receipt", required: false, settings: { allowedMimeTypes: ["text/plain"], maxFileBytes: 4096, maxFiles: 1 } },
  ];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_name", "f_receipt"] }];
  return def;
}

const TABLES = [
  "memberships",
  "invitations",
  "forms",
  "form_drafts",
  "form_versions",
  "form_grants",
  "form_access_policies",
  "submissions",
  "file_uploads",
  "exports",
  "integrations",
  "deliveries",
  "jobs",
  "ai_settings",
  "ai_generations",
  "audit_events",
  "outbox_events",
] as const;

/**
 * A digest of every row tenant A owns in the tables an attack could change.
 * Filtered by tenant explicitly: the owner role's lookup policies see all tenants.
 */
async function tenantSnapshot(tenantId: string): Promise<Record<string, string>> {
  return withTenant(owner, tenantId, async (trx) => {
    const out: Record<string, string> = {};
    for (const table of TABLES) {
      // Other test files' export workers claim any tenant's queued export, so
      // only the columns the API writes are compared; a new export is still a new row.
      const row = table === "exports" ? sql`(t.id, t.form_id, t.requested_by, t.filter_snapshot, t.raw, t.created_at)::text` : sql`t::text`;
      const { rows } = await sql<{ digest: string }>`SELECT count(*) || ':' || md5(coalesce(string_agg(${row}, '|' ORDER BY ${row}), '')) AS digest FROM ${sql.table(`app.${table}`)} t WHERE t.tenant_id = ${tenantId}::uuid`.execute(trx);
      out[table] = rows[0]!.digest;
    }
    return out;
  });
}

async function seedTenantA() {
  const created = FormResponseSchema.parse(
    (await request(app).post(`/api/v1/organizations/${a.id}/forms`).set("Cookie", `we_session=${tokens.ownerA}`).set("Origin", TEST_CONSOLE_ORIGIN).send({ name: SECRET_FORM_NAME })).body,
  );
  const ownerReq = (method: Method, path: string) => request(app)[method](path).set("Cookie", `we_session=${tokens.ownerA}`).set("Origin", TEST_CONSOLE_ORIGIN);
  const formPath = `/api/v1/organizations/${a.id}/forms/${created.form.id}`;
  ids.formId = created.form.id;
  const saved = await ownerReq("put", `${formPath}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(definition());
  expect(saved.status).toBe(200);
  const published = await ownerReq("post", `${formPath}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `k-${randomUUID()}`);
  expect(published.status).toBe(201);
  ids.versionId = PublishResponseSchema.parse(published.body).version.id;

  // An email integration, so the response below creates a delivery.
  const integration = await ownerReq("post", `${formPath}/integrations`).send({ kind: "email", name: "Ops", recipients: ["ops@example.test"] });
  expect(integration.status).toBe(201);
  ids.integrationId = integration.body.integration.id as string;

  // A response with a scanned file.
  const session = SessionStartResponseSchema.parse((await request(app).post(`/public/v1/forms/${created.form.slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body);
  ids.sessionId = session.sessionId;
  ids.capability = session.capability;
  const auth = { Authorization: `Bearer ${session.capability}` };
  const bytes = Buffer.from("receipt");
  const target = UploadCreateResponseSchema.parse(
    (await request(app).post(`/public/v1/sessions/${session.sessionId}/uploads`).set(auth).send({ fieldId: "f_receipt", fileName: "r.txt", contentType: "text/plain", bytes: bytes.length })).body,
  );
  expect((await fetch(target.uploadUrl, { method: "PUT", headers: target.headers, body: bytes })).status).toBe(200);
  await request(app).post(`/public/v1/sessions/${session.sessionId}/uploads/${target.uploadId}/complete`).set(auth).expect(202);
  const scanner = { host: process.env.SCANNER_HOST ?? "127.0.0.1", port: Number(process.env.SCANNER_PORT ?? 3310) };
  const deadline = Date.now() + 15_000;
  for (;;) {
    while ((await scanPendingUploads({ workerDb, store, scanner, tenantId: a.id }, 20)) > 0);
    const { state } = UploadStatusResponseSchema.parse((await request(app).get(`/public/v1/sessions/${session.sessionId}/uploads/${target.uploadId}`).set(auth)).body);
    if (state !== "pending_scan" && state !== "scanning") break;
    if (Date.now() > deadline) throw new Error("upload scan did not finish");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ids.uploadId = target.uploadId;
  const submitted = await request(app)
    .post(`/public/v1/sessions/${session.sessionId}/submissions`)
    .set(auth)
    .set("Idempotency-Key", `k-${randomUUID()}`)
    .send({ formVersionId: session.versionId, answers: { f_name: SECRET_ANSWER, f_receipt: [target.uploadId] } });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  ids.submissionId = submitted.body.submissionId as string;

  // The worker turns the response into a delivery.
  const deps = {
    workerDb,
    secretKey: TEST_INTEGRATION_KEY,
    policy: testSettings.webhookPolicy,
    mailer: createMailer({ host: "127.0.0.1", port: Number(process.env.MAIL_SMTP_PORT ?? 1025), secure: false, from: "Workeasy <notifications@workeasy.test>" }),
    consolePublicUrl: TEST_CONSOLE_ORIGIN,
  };
  const registry: JobRegistry = { [FANOUT_JOB]: fanoutJob(deps), [DELIVER_JOB]: deliverJob(deps) };
  await dispatchOutbox({ workerDb, tenantId: a.id }, registry);
  while ((await runJobs({ workerDb, tenantId: a.id }, registry)) > 0);
  const deliveries = await ownerReq("get", `/api/v1/organizations/${a.id}/integrations/${ids.integrationId}/deliveries`);
  ids.deliveryId = deliveries.body.items[0].id as string;
  const jobs = await ownerReq("get", `/api/v1/organizations/${a.id}/jobs`);
  ids.jobId = jobs.body.items[0].id as string;

  const exported = await ownerReq("post", `${formPath}/exports`).send({});
  expect(exported.status, JSON.stringify(exported.body)).toBe(202);
  ids.exportId = exported.body.id as string;

  expect((await ownerReq("put", `/api/v1/organizations/${a.id}/ai-settings`).send({ enabled: true, dailyTokenLimit: 1_000_000 })).status).toBe(200);
  const ai = await ownerReq("post", `${formPath}/ai-jobs`).send({ prompt: "Add a phone number question", operation: "edit", baseRevision: saved.body.revision });
  expect(ai.status, JSON.stringify(ai.body)).toBe(202);
  ids.aiJobId = ai.body.job.id as string;
  // Finish the generation now, scoped to tenant A, so no other test file's worker changes it during the attacks.
  while ((await runJobs({ workerDb, tenantId: a.id }, { [AI_GENERATE_JOB]: aiGenerationJob({ workerDb, provider: stubProvider() }) })) > 0);

  const invitation = await ownerReq("post", `/api/v1/organizations/${a.id}/invitations`).send({ role: "admin" });
  ids.invitationId = invitation.body.invitation.id as string;
  ids.userId = roleUser(a, "analyst");
}

/** Path values: tenant A's resources, for the given organization ID. */
const valuesFor = (orgId: string) => ({
  orgId,
  formId: ids.formId!,
  versionId: ids.versionId!,
  submissionId: ids.submissionId!,
  uploadId: ids.uploadId!,
  integrationId: ids.integrationId!,
  deliveryId: ids.deliveryId!,
  // Generations and durable jobs share the {jobId} name; each route gets the matching kind.
  jobId: ids.jobId!,
  exportId: ids.exportId!,
  invitationId: ids.invitationId!,
  userId: ids.userId!,
});

const pathFor = (route: Route, orgId: string) => {
  const values = valuesFor(orgId);
  return fill(route.template, route.template.includes("/ai-jobs/") ? { ...values, jobId: ids.aiJobId! } : values);
};

function expectNoLeak(res: request.Response, label: string) {
  const text = JSON.stringify(res.body ?? "") + (res.text ?? "");
  expect(text, label).not.toContain(SECRET_ANSWER);
  expect(text, label).not.toContain(SECRET_FORM_NAME);
}

let before: Record<string, string>;

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 6 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 2 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 2 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  store = testObjectStore();
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb, unusedIdentityProvider, store);
  a = createTenantFixture("Authz tenant A");
  b = createTenantFixture("Authz tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  for (const [name, id] of [
    ["ownerA", roleUser(a, "owner")],
    ["analystA", roleUser(a, "analyst")],
    ["ownerB", roleUser(b, "owner")],
  ] as const) {
    tokens[name] = (await identityRepo.createSession(db, id, 60 * 60 * 1000)).token;
  }
  // A member of both organizations: owner of B, analyst without grants in A.
  const both = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `authz-${randomUUID()}` });
  await withTenant(db, b.id, (trx) => trx.insertInto("memberships").values({ tenant_id: b.id, user_id: both, role: "owner" }).execute());
  await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: both, role: "analyst" }).execute());
  tokens.both = (await identityRepo.createSession(db, both, 60 * 60 * 1000)).token;
  await seedTenantA();
  before = await tenantSnapshot(a.id);
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
  await workerDb?.destroy();
  await owner?.destroy();
});

const routes = contractRoutes();
const orgRoutes = routes.filter((r) => r.template.includes("{orgId}"));
const mutations = routes.filter((r) => r.method !== "get");

describe("negative authorization (SEC-01)", () => {
  it("covers every console route in the contract", () => {
    expect(orgRoutes.length).toBeGreaterThan(50);
    for (const r of orgRoutes) expect(() => pathFor(r, a.id)).not.toThrow();
  });

  it("asks signed-out callers to sign in on every console route", async () => {
    for (const r of routes) {
      if (r.template === "/api/v1/form-templates") continue;
      const res = await call(r, r.template.includes("{orgId}") ? pathFor(r, a.id) : r.template);
      expect(res.status, `${r.method} ${r.template}`).toBe(401);
      expectNoLeak(res, `${r.method} ${r.template}`);
    }
  });

  it("shows another organization nothing when its ID is used directly", async () => {
    for (const r of orgRoutes) {
      const res = await call(r, pathFor(r, a.id), "ownerB");
      expect([404, 422], `${r.method} ${r.template} -> ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
      expectNoLeak(res, `${r.method} ${r.template}`);
    }
  });

  it("finds none of tenant A's resources through tenant B's own organization", async () => {
    for (const r of orgRoutes) {
      if (!/\{(formId|submissionId|integrationId|deliveryId|jobId|exportId|invitationId|userId)\}/.test(r.template)) continue;
      const res = await call(r, pathFor(r, b.id), "ownerB");
      expect([404, 422], `${r.method} ${r.template} -> ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
      expectNoLeak(res, `${r.method} ${r.template}`);
    }
  });

  it("gives a member of both organizations no more in A than their A role allows", async () => {
    // Routes every member may use; they still must not show the ungranted form.
    const memberRoutes = new Set(["get /api/v1/organizations/{orgId}/forms", "get /api/v1/organizations/{orgId}/ai-settings"]);
    for (const r of orgRoutes) {
      const res = await call(r, pathFor(r, a.id), "both");
      const label = `${r.method} ${r.template} -> ${res.status} ${JSON.stringify(res.body)}`;
      const allowed = memberRoutes.has(`${r.method} ${r.template}`) ? [200] : [403, 404, 422];
      expect(allowed, label).toContain(res.status);
      expectNoLeak(res, label);
    }
  });

  it("refuses every console change without the console's Origin", async () => {
    for (const r of mutations) {
      if (r.template === "/api/v1/form-templates") continue;
      const path = r.template.includes("{orgId}") ? pathFor(r, a.id) : r.template;
      const res = await call(r, path, "ownerA", false);
      expect(res.status, `${r.method} ${r.template} -> ${res.status}`).toBe(403);
    }
  });

  it("keeps a respondent session's uploads and status from other sessions", async () => {
    const other = SessionStartResponseSchema.parse(
      (await request(app).post(`/public/v1/forms/${(await withTenant(owner, a.id, (trx) => trx.selectFrom("forms").select("slug").where("id", "=", ids.formId!).executeTakeFirstOrThrow())).slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body,
    );
    const auth = { Authorization: `Bearer ${other.capability}` };
    const s = ids.sessionId!;
    for (const [method, path] of [
      ["get", `/public/v1/sessions/${s}/acceptance`],
      ["get", `/public/v1/sessions/${s}/uploads/${ids.uploadId}`],
      ["post", `/public/v1/sessions/${s}/uploads/${ids.uploadId}/complete`],
      ["post", `/public/v1/sessions/${s}/started`],
      ["get", `/public/v1/sessions/${other.sessionId}/uploads/${ids.uploadId}`],
    ] as const) {
      const res = await request(app)[method](path).set(auth).set("Origin", TEST_RESPONDENT_ORIGIN);
      expect(res.status, `${method} ${path} -> ${res.status}`).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expectNoLeak(res, path);
    }
  });

  it("left tenant A's data exactly as it was", async () => {
    expect(await tenantSnapshot(a.id)).toEqual(before);
  });
});
