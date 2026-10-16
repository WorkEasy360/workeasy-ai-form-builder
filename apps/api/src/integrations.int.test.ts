import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import {
  createMailer,
  DELIVER_JOB,
  deliverJob,
  FANOUT_JOB,
  fanoutJob,
  STRICT_POLICY,
  verifyWebhookSignature,
  type DeliveryDeps,
  type DestinationPolicy,
} from "@workeasy/integrations";
import { dispatchOutbox, runJobs, type JobRegistry } from "@workeasy/jobs";
import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  DeliveryDetailResponseSchema,
  DeliveryListResponseSchema,
  FormResponseSchema,
  IntegrationListResponseSchema,
  IntegrationResponseSchema,
  ProblemSchema,
  PublishResponseSchema,
  SessionStartResponseSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, TEST_INTEGRATION_KEY, TEST_RESPONDENT_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** AUT-01: email and signed webhooks. Needs `pnpm infra:up` (PostgreSQL and Mailpit). */
const urls = inject("testDatabase");
const MAILPIT = `http://127.0.0.1:${process.env.MAIL_UI_PORT ?? 8025}`;
const LOCAL: DestinationPolicy = { allowHttp: true, allowPrivateNetworks: true, allowedPorts: [] };

let db: Db;
let publicDb: Db;
let workerDb: Db;
let owner: Db;
let app: Express;
let strictApp: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};

// A local webhook receiver: each path answers with queued statuses (then 200) and records requests.
let receiver: http.Server;
let base = "";
const received: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
const plans = new Map<string, Array<{ status: number; headers?: Record<string, string> }>>();

const consoleReq = (who: string, method: "get" | "post" | "put" | "patch" | "delete", path: string, on = app) =>
  request(on)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);

function deliveryDeps(over: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return {
    workerDb,
    secretKey: TEST_INTEGRATION_KEY,
    policy: LOCAL,
    mailer: createMailer({ host: "127.0.0.1", port: Number(process.env.MAIL_SMTP_PORT ?? 1025), secure: false, from: "Workeasy <notifications@workeasy.test>" }),
    consolePublicUrl: "http://localhost:3000",
    ...over,
  };
}
/** The worker: dispatches tenant A's outbox and runs its due jobs until nothing is left. */
async function work(over: Partial<DeliveryDeps> = {}) {
  const deps = deliveryDeps(over);
  const registry: JobRegistry = { [FANOUT_JOB]: fanoutJob(deps), [DELIVER_JOB]: deliverJob(deps) };
  await dispatchOutbox({ workerDb, tenantId: a.id }, registry);
  while ((await runJobs({ workerDb, tenantId: a.id }, registry)) > 0);
}
/** Stands in for the retry schedule passing. */
const makeDue = () =>
  withTenant(owner, a.id, (trx) => trx.updateTable("jobs").set({ next_attempt_at: sql<Date>`now()` }).where("status", "=", "queued").execute());

async function publishedForm() {
  const def = blankDefinition("Volunteers");
  def.fields = [
    { id: "f_name", type: "text", label: "Name", required: true, settings: {} },
    { id: "f_email", type: "email", label: "Email", required: false, privacy: "personal", settings: {} },
  ];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_name", "f_email"] }];
  const created = FormResponseSchema.parse((await consoleReq("ownerA", "post", `/api/v1/organizations/${a.id}/forms`).send({ name: "Volunteers" })).body);
  const path = `/api/v1/organizations/${a.id}/forms/${created.form.id}`;
  const saved = await consoleReq("ownerA", "put", `${path}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(def);
  const published = await consoleReq("ownerA", "post", `${path}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `k-${randomUUID()}`);
  expect(published.status).toBe(201);
  PublishResponseSchema.parse(published.body);
  return { id: created.form.id, slug: created.form.slug, path };
}

async function respond(slug: string, name: string, email = "volunteer@example.test") {
  const session = SessionStartResponseSchema.parse((await request(app).post(`/public/v1/forms/${slug}/sessions`).set("Origin", TEST_RESPONDENT_ORIGIN)).body);
  const res = await request(app)
    .post(`/public/v1/sessions/${session.sessionId}/submissions`)
    .set({ Authorization: `Bearer ${session.capability}` })
    .set("Idempotency-Key", `k-${randomUUID()}`)
    .send({ formVersionId: session.versionId, answers: { f_name: name, f_email: email } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.submissionId as string;
}

async function webhook(formPath: string, path: string, fieldIds: string[] = ["f_name"]) {
  const res = await consoleReq("ownerA", "post", `${formPath}/integrations`).send({ kind: "webhook", name: `Hook ${path}`, url: `${base}${path}`, fieldIds });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return IntegrationResponseSchema.parse(res.body);
}

const deliveriesOf = async (integrationId: string) =>
  DeliveryListResponseSchema.parse((await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/integrations/${integrationId}/deliveries`)).body).items;
const detail = async (deliveryId: string) => DeliveryDetailResponseSchema.parse((await consoleReq("ownerA", "get", `/api/v1/organizations/${a.id}/deliveries/${deliveryId}`)).body);
const hits = (path: string) => received.filter((r) => r.path === path);

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 4 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 4 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb);
  strictApp = buildTestApp(db, unusedIdentityProvider, { ...testSettings, webhookPolicy: STRICT_POLICY }, publicDb);
  a = createTenantFixture("Integrations tenant A");
  b = createTenantFixture("Integrations tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  for (const [name, id] of [
    ["ownerA", a.members.find((m) => m.role === "owner")!.user.id],
    ["analystA", a.members.find((m) => m.role === "analyst")!.user.id],
    ["ownerB", b.members.find((m) => m.role === "owner")!.user.id],
  ] as const) {
    tokens[name] = (await identityRepo.createSession(db, id, 3_600_000)).token;
  }
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      received.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
      const next = plans.get(path)?.shift() ?? { status: 200 };
      res.writeHead(next.status, next.headers).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

beforeEach(() => {
  received.length = 0;
  plans.clear();
});

afterAll(async () => {
  receiver?.closeAllConnections();
  receiver?.close();
  await db?.destroy();
  await publicDb?.destroy();
  await workerDb?.destroy();
  await owner?.destroy();
});

describe("webhooks", () => {
  it("deliver a signed payload with only the configured fields, once per event", async () => {
    const form = await publishedForm();
    const { integration, secret } = await webhook(form.path, "/signed");
    expect(secret).toMatch(/^whsec_/);
    const listed = IntegrationListResponseSchema.parse((await consoleReq("ownerA", "get", `${form.path}/integrations`)).body).items;
    expect(listed).toEqual([integration]);
    expect(JSON.stringify(listed)).not.toContain(secret!);

    const submissionId = await respond(form.slug, "Ada Lovelace", "ada@example.test");
    await work();
    const [hit] = hits("/signed");
    expect(hits("/signed")).toHaveLength(1);
    expect(hit!.headers["content-type"]).toBe("application/json");
    expect(
      verifyWebhookSignature({
        secret: secret!,
        signatureHeader: String(hit!.headers["workeasy-signature"]),
        timestamp: String(hit!.headers["workeasy-timestamp"]),
        body: hit!.body,
      }),
    ).toBe(true);
    const payload = JSON.parse(hit!.body.toString()) as Record<string, unknown>;
    expect(payload).toMatchObject({ version: "1", eventType: "submission.accepted", formId: form.id, submissionId, answers: { f_name: "Ada Lovelace" } });
    expect(payload.eventId).toBe(hit!.headers["workeasy-event-id"]);
    // The email field was not chosen, so it is not sent.
    expect(hit!.body.toString()).not.toContain("ada@example.test");

    const [delivery] = await deliveriesOf(integration.id);
    expect(delivery).toMatchObject({ status: "succeeded", attempts: 1, lastStatusCode: 200, lastError: null, eventId: payload.eventId, submissionId });
    expect((await detail(delivery!.id)).attempts).toMatchObject([{ attempt: 1, statusCode: 200, outcome: "succeeded" }]);

    // The event dispatched again (as after a restore) sends nothing new.
    await withTenant(owner, a.id, (trx) => trx.updateTable("outbox_events").set({ dispatched_at: null }).where("aggregate_id", "=", submissionId).execute());
    await work();
    expect(hits("/signed")).toHaveLength(1);
  });

  it("retry transient failures on the schedule, honouring Retry-After, and keep every attempt", async () => {
    const form = await publishedForm();
    const { integration } = await webhook(form.path, "/flaky");
    plans.set("/flaky", [{ status: 503 }, { status: 429, headers: { "retry-after": "120" } }]);
    await respond(form.slug, "Grace");
    await work();
    let [delivery] = await deliveriesOf(integration.id);
    expect(delivery).toMatchObject({ status: "retrying", attempts: 1, lastStatusCode: 503, lastError: "http_503" });
    const firstWait = Date.parse(delivery!.nextAttemptAt!) - Date.now();
    expect(firstWait).toBeGreaterThan(40_000);
    expect(firstWait).toBeLessThan(75_000);

    await makeDue();
    await work();
    [delivery] = await deliveriesOf(integration.id);
    expect(delivery).toMatchObject({ status: "retrying", attempts: 2, lastStatusCode: 429 });
    const retryAfter = Date.parse(delivery!.nextAttemptAt!) - Date.now();
    expect(retryAfter).toBeGreaterThan(110_000);
    expect(retryAfter).toBeLessThanOrEqual(121_000);

    await makeDue();
    await work();
    const done = await detail(delivery!.id);
    expect(done.delivery).toMatchObject({ status: "succeeded", attempts: 3, nextAttemptAt: null });
    expect(done.attempts.map((x) => [x.statusCode, x.outcome])).toEqual([
      [503, "retry"],
      [429, "retry"],
      [200, "succeeded"],
    ]);
    // Every attempt carried the same event ID.
    expect(new Set(hits("/flaky").map((h) => h.headers["workeasy-event-id"])).size).toBe(1);
  });

  it("show permanent failures and can be sent again by hand with the same event ID", async () => {
    const form = await publishedForm();
    const { integration } = await webhook(form.path, "/gone");
    plans.set("/gone", [{ status: 410 }]);
    await respond(form.slug, "Hedy");
    await work();
    const [failed] = await deliveriesOf(integration.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, lastStatusCode: 410, lastError: "http_410", nextAttemptAt: null });
    expect(failed!.completedAt).not.toBeNull();
    const [job] = await withTenant(owner, a.id, (trx) => trx.selectFrom("jobs").select(["status", "last_error"]).where("dedupe_key", "=", failed!.id).execute());
    expect(job).toEqual({ status: "dead", last_error: "http_410" });

    // The destination is fixed; someone sends it again.
    expectProblem(await consoleReq("analystA", "post", `/api/v1/organizations/${a.id}/deliveries/${failed!.id}/retry`), 404, "NOT_FOUND");
    const retried = await consoleReq("ownerA", "post", `/api/v1/organizations/${a.id}/deliveries/${failed!.id}/retry`);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.delivery).toMatchObject({ status: "pending", completedAt: null });
    expectProblem(await consoleReq("ownerA", "post", `/api/v1/organizations/${a.id}/deliveries/${failed!.id}/retry`), 409, "DELIVERY_NOT_FAILED");
    await work();
    const done = await detail(failed!.id);
    expect(done.delivery).toMatchObject({ status: "succeeded", lastStatusCode: 200 });
    expect(done.attempts.map((x) => [x.attempt, x.statusCode, x.outcome])).toEqual([
      [1, 410, "failed"],
      [2, 200, "succeeded"],
    ]);
    const [first, second] = hits("/gone");
    expect(second!.headers["workeasy-event-id"]).toBe(first!.headers["workeasy-event-id"]);
    const audit = await withTenant(owner, a.id, (trx) => trx.selectFrom("audit_events").select("action").where("resource_id", "=", failed!.id).execute());
    expect(audit).toEqual([{ action: "delivery.retried" }]);
  });

  it("give up after the last retry and say so", async () => {
    const form = await publishedForm();
    const { integration } = await webhook(form.path, "/down");
    plans.set("/down", Array.from({ length: 7 }, () => ({ status: 500 })));
    await respond(form.slug, "Katherine");
    await work();
    for (let i = 0; i < 6; i++) {
      await makeDue();
      await work();
    }
    const [delivery] = await deliveriesOf(integration.id);
    expect(delivery).toMatchObject({ status: "failed", attempts: 7, lastError: "http_500" });
    expect((await detail(delivery!.id)).attempts.map((x) => x.outcome)).toEqual(["retry", "retry", "retry", "retry", "retry", "retry", "failed"]);
    expect(hits("/down")).toHaveLength(7);
  });

  it("send both signatures for a day after the secret is rotated", async () => {
    const form = await publishedForm();
    const { integration, secret: oldSecret } = await webhook(form.path, "/rotated");
    const rotated = IntegrationResponseSchema.parse((await consoleReq("ownerA", "post", `/api/v1/organizations/${a.id}/integrations/${integration.id}/rotate-secret`)).body);
    expect(rotated.secret).not.toBe(oldSecret);
    expect(Date.parse(rotated.integration.previousSecretExpiresAt!) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    await respond(form.slug, "Radia");
    await work();
    const [hit] = hits("/rotated");
    const header = String(hit!.headers["workeasy-signature"]);
    expect(header.split(",")).toHaveLength(2);
    for (const secret of [oldSecret!, rotated.secret!]) {
      expect(verifyWebhookSignature({ secret, signatureHeader: header, timestamp: String(hit!.headers["workeasy-timestamp"]), body: hit!.body })).toBe(true);
    }
  });
});

describe("SSRF protection", () => {
  it("refuses local, private and metadata destinations when saving", async () => {
    const form = await publishedForm();
    for (const url of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/x", "https://localhost/x", "https://10.0.0.8/x"]) {
      const res = await consoleReq("ownerA", "post", `${form.path}/integrations`, strictApp).send({ kind: "webhook", name: "Bad", url, fieldIds: [] });
      expectProblem(res, 422, "VALIDATION_FAILED");
      expect(res.body.errors[0].field).toBe("url");
    }
  });

  it("checks DNS again before every delivery and never connects to a private answer", async () => {
    const form = await publishedForm();
    const res = await consoleReq("ownerA", "post", `${form.path}/integrations`, strictApp).send({ kind: "webhook", name: "Rebinding", url: "https://hooks.example.test/x", fieldIds: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { integration } = IntegrationResponseSchema.parse(res.body);
    await respond(form.slug, "Mallory");
    // The name now resolves to a private address (DNS rebinding).
    await work({ policy: STRICT_POLICY, resolve: () => Promise.resolve([{ address: "10.0.0.8", family: 4 }]) });
    const [delivery] = await deliveriesOf(integration.id);
    expect(delivery).toMatchObject({ status: "failed", attempts: 1, lastError: "destination_blocked", lastStatusCode: null });
    expect(received).toHaveLength(0);
  });
});

describe("email", () => {
  it("sends a link to the response, never its answers, to the fixed recipients", async () => {
    const form = await publishedForm();
    const to = `ops-${randomUUID()}@example.test`;
    const created = await consoleReq("ownerA", "post", `${form.path}/integrations`).send({ kind: "email", name: "Ops inbox", recipients: [to] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { integration, secret } = IntegrationResponseSchema.parse(created.body);
    expect(secret).toBeUndefined();
    const submissionId = await respond(form.slug, "Unique-Answer-5512");
    await work();
    const [delivery] = await deliveriesOf(integration.id);
    expect(delivery).toMatchObject({ status: "succeeded", attempts: 1 });

    const search = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as { messages: Array<{ ID: string; Subject: string }> };
    expect(search.messages).toHaveLength(1);
    expect(search.messages[0]!.Subject).toBe("New response: Volunteers");
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`)).json()) as { Text: string; HTML: string };
    expect(message.Text).toContain(`http://localhost:3000/o/${a.id}/forms/${form.id}/responses/${submissionId}`);
    expect(message.Text).not.toContain("Unique-Answer-5512");
    expect(message.HTML).toBe("");
  });

  it("retries while the mail server is unreachable", async () => {
    const form = await publishedForm();
    const { body } = await consoleReq("ownerA", "post", `${form.path}/integrations`).send({ kind: "email", name: "Down", recipients: ["ops@example.test"] });
    await respond(form.slug, "Ida");
    await work({ mailer: createMailer({ host: "127.0.0.1", port: 1, secure: false, from: "x@workeasy.test" }) });
    const [delivery] = await deliveriesOf(body.integration.id as string);
    expect(delivery).toMatchObject({ status: "retrying", attempts: 1, lastError: "smtp_unavailable" });
  });
});

describe("skipping and access", () => {
  it("skips a response deleted before delivery, and a paused integration", async () => {
    const form = await publishedForm();
    const { integration } = await webhook(form.path, "/skip");
    const submissionId = await respond(form.slug, "Deleted Person");
    const deleted = await consoleReq("ownerA", "delete", `${form.path}/submissions/${submissionId}`).send({ reason: "Asked to be removed" });
    expect(deleted.status).toBe(202);
    await work();
    expect((await deliveriesOf(integration.id))[0]).toMatchObject({ status: "skipped", lastError: "response_deleted" });

    await consoleReq("ownerA", "patch", `/api/v1/organizations/${a.id}/integrations/${integration.id}`).send({ enabled: false });
    await respond(form.slug, "Paused");
    await work();
    // Paused integrations get no new deliveries at all.
    expect(await deliveriesOf(integration.id)).toHaveLength(1);
    expect(hits("/skip")).toHaveLength(0);
  });

  it("needs integrations.manage, readable fields and the right tenant", async () => {
    const form = await publishedForm();
    expectProblem(await consoleReq("analystA", "get", `${form.path}/integrations`), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerB", "get", `${form.path}/integrations`), 404, "NOT_FOUND");
    const unknown = await consoleReq("ownerA", "post", `${form.path}/integrations`).send({ kind: "webhook", name: "X", url: `${base}/x`, fieldIds: ["f_nope"] });
    expectProblem(unknown, 422, "VALIDATION_FAILED");
    expect(unknown.body.errors[0]).toMatchObject({ field: "fieldIds[0]", code: "UNKNOWN_FIELD" });
    expectProblem(await consoleReq("ownerA", "post", `${form.path}/integrations`).send({ kind: "email", name: "X", recipients: ["not-an-email"] }), 422, "VALIDATION_FAILED");
    const { integration } = await webhook(form.path, "/x");
    expectProblem(await consoleReq("ownerB", "post", `/api/v1/organizations/${b.id}/integrations/${integration.id}/rotate-secret`), 404, "NOT_FOUND");
    expectProblem(await consoleReq("ownerA", "patch", `/api/v1/organizations/${a.id}/integrations/${integration.id}`).send({ recipients: ["a@example.test"] }), 422, "VALIDATION_FAILED");
    const audit = await withTenant(owner, a.id, (trx) => trx.selectFrom("audit_events").select(["action", "metadata"]).where("resource_id", "=", integration.id).execute());
    expect(audit.map((e) => e.action)).toEqual(["integration.created"]);
    expect(JSON.stringify(audit)).not.toContain(base);
  });
});
