import { randomUUID } from "node:crypto";
import { createDb, identityRepo, jobsRepo, publishRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { blankDefinition } from "@workeasy/form-engine";
import { dispatchOutbox, PermanentJobError, runJobs, type JobContext, type JobDeps, type JobRegistry } from "@workeasy/jobs";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { FormResponseSchema, JobListResponseSchema, JobResponseSchema, ProblemSchema, PublishResponseSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** JOB-01: outbox dispatch, durable jobs, leases, retries and dead letters. Needs `pnpm infra:up`. */
const urls = inject("testDatabase");

let db: Db;
let workerDb: Db;
let owner: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};

const consoleReq = (who: string, method: "get" | "post" | "put", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);

/** What handlers saw, and how the next attempts of each type should end. */
const seen: JobContext[] = [];
const behavior: Record<string, () => Promise<void>> = {};
const handle = (ctx: JobContext) => {
  seen.push(ctx);
  return (behavior[ctx.type] ?? (() => Promise.resolve()))();
};

// Job types unique to this file; dispatch and claims are also limited to tenant A.
const registry: JobRegistry = {
  "test_jobs.record": { events: ["form.published.v1", "test_jobs.happened.v1"], handle },
  "test_jobs.mirror": { events: ["test_jobs.happened.v1"], handle },
  "test_jobs.direct": { handle },
};
const deps = (): JobDeps => ({ workerDb, tenantId: a.id, backoff: { baseMs: 60_000 } });

const jobsWhere = (column: "source_event_id" | "dedupe_key", values: string[]) =>
  withTenant(owner, a.id, (trx) => trx.selectFrom("jobs").selectAll().where(column, "in", values).orderBy("type").execute());
const jobRow = (id: string) => withTenant(owner, a.id, (trx) => trx.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
/** Stands in for time passing: the job's lease or backoff is over now. */
const makeDue = (id: string) =>
  withTenant(owner, a.id, (trx) =>
    trx
      .updateTable("jobs")
      .set({ lease_until: sql<Date>`case when status = 'running' then now() - interval '1 second' end`, next_attempt_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute(),
  );

function definition() {
  const def = blankDefinition("Dispatch");
  def.fields = [{ id: "f_name", type: "text", label: "Name", required: true, settings: {} }];
  def.pages = [{ id: "page_1", title: "", fieldIds: ["f_name"] }];
  return def;
}

function enqueue(type: string, maxAttempts?: number) {
  return withTenant(db, a.id, (trx) =>
    jobsRepo.enqueueJob(trx, { tenantId: a.id, type, dedupeKey: `action-${randomUUID()}`, payload: { ref: randomUUID() }, ...(maxAttempts ? { maxAttempts } : {}) }),
  );
}

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(ProblemSchema.parse(res.body).code).toBe(code);
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  workerDb = createDb({ connectionString: urls.worker, maxConnections: 4 });
  owner = createDb({ connectionString: urls.owner, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings);
  a = createTenantFixture("Jobs tenant A");
  b = createTenantFixture("Jobs tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  const admin = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `jobs-admin-${randomUUID()}` });
  await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: admin, role: "admin" }).execute());
  for (const [name, id] of [
    ["ownerA", a.members.find((m) => m.role === "owner")!.user.id],
    ["analystA", a.members.find((m) => m.role === "analyst")!.user.id],
    ["adminA", admin],
    ["ownerB", b.members.find((m) => m.role === "owner")!.user.id],
  ] as const) {
    tokens[name] = (await identityRepo.createSession(db, id, 60 * 60 * 1000)).token;
  }
});

beforeEach(() => {
  seen.length = 0;
  for (const key of Object.keys(behavior)) delete behavior[key];
});

afterAll(async () => {
  await db?.destroy();
  await workerDb?.destroy();
  await owner?.destroy();
});

describe("outbox dispatch", () => {
  it("delivers an event committed before a crash once the worker is back, as a job under the event's tenant", async () => {
    const path = `/api/v1/organizations/${a.id}/forms`;
    const created = FormResponseSchema.parse((await consoleReq("ownerA", "post", path).send({ name: "Dispatch" })).body);
    const formPath = `${path}/${created.form.id}`;
    const saved = await consoleReq("ownerA", "put", `${formPath}/draft`).set("If-Match", `"draft-${created.draft.revision}"`).send(definition());
    const published = await consoleReq("ownerA", "post", `${formPath}/publish`).set("If-Match", `"draft-${saved.body.revision}"`).set("Idempotency-Key", `k-${randomUUID()}`);
    expect(published.status).toBe(201);
    const version = PublishResponseSchema.parse(published.body).version;

    // The API committed the event and then "crashed": no worker has run.
    const [event] = await withTenant(owner, a.id, (trx) => trx.selectFrom("outbox_events").selectAll().where("aggregate_id", "=", created.form.id).execute());
    expect(event).toMatchObject({ event_type: "form.published.v1", dispatched_at: null });
    expect(await jobsWhere("source_event_id", [event!.id])).toEqual([]);

    // A fresh worker dispatches it and runs the job.
    expect(await dispatchOutbox(deps(), registry)).toEqual({ events: 1, jobs: 1 });
    expect(await runJobs(deps(), registry)).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tenantId: a.id,
      type: "test_jobs.record",
      dedupeKey: event!.id,
      attempt: 1,
      traceId: published.headers["x-request-id"],
      payload: {
        eventId: event!.id,
        eventType: "form.published.v1",
        tenantId: a.id,
        aggregateId: created.form.id,
        data: { formId: created.form.id, formVersionId: version.id, versionNumber: 1 },
      },
    });
    const [job] = await jobsWhere("source_event_id", [event!.id]);
    expect(job).toMatchObject({ status: "succeeded", attempt: 1, lease_token: null, last_error: null });
    expect((await withTenant(owner, a.id, (trx) => trx.selectFrom("outbox_events").select("dispatched_at").where("id", "=", event!.id).executeTakeFirstOrThrow())).dispatched_at).not.toBeNull();
    // Nothing left to do.
    expect(await dispatchOutbox(deps(), registry)).toEqual({ events: 0, jobs: 0 });
    expect(await runJobs(deps(), registry)).toBe(0);
  });

  it("creates exactly one job per subscribed type, with concurrent dispatchers and when an event is dispatched again", async () => {
    const ids: string[] = [];
    await withTenant(db, a.id, async (trx) => {
      for (let i = 0; i < 20; i++) {
        const id = randomUUID();
        ids.push(id);
        await publishRepo.appendOutbox(trx, { id, tenantId: a.id, eventType: "test_jobs.happened.v1", aggregateId: randomUUID(), occurredAt: new Date(), payload: { n: i } });
      }
    });
    const drain = async () => {
      let total = 0;
      for (let r = await dispatchOutbox(deps(), registry, 3); r.events > 0; r = await dispatchOutbox(deps(), registry, 3)) total += r.events;
      return total;
    };
    const handled = await Promise.all([drain(), drain(), drain()]);
    expect(handled.reduce((x, y) => x + y, 0)).toBe(20);
    const jobs = await jobsWhere("source_event_id", ids);
    expect(jobs).toHaveLength(40);
    expect(new Set(jobs.map((j) => `${j.source_event_id}/${j.type}`)).size).toBe(40);

    // A redelivered event (as after a restore, or a dispatcher bug) makes no second job.
    await withTenant(owner, a.id, (trx) => trx.updateTable("outbox_events").set({ dispatched_at: null }).where("id", "in", ids).execute());
    expect(await dispatchOutbox(deps(), registry, 100)).toEqual({ events: 20, jobs: 0 });
    expect(await jobsWhere("source_event_id", ids)).toHaveLength(40);

    while ((await runJobs(deps(), registry, 50)) > 0);
    expect(seen).toHaveLength(40);
    expect((await jobsWhere("source_event_id", ids)).every((j) => j.status === "succeeded")).toBe(true);
  });

  it("enqueues a direct job once per dedupe key", async () => {
    const first = await enqueue("test_jobs.direct");
    const again = await withTenant(db, a.id, (trx) =>
      jobsRepo.enqueueJob(trx, { tenantId: a.id, type: "test_jobs.direct", dedupeKey: first.job.dedupeKey, payload: { ref: "other" } }),
    );
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, job: { id: first.job.id, payload: first.job.payload } });
    expect(await runJobs(deps(), registry)).toBe(1);
  });
});

describe("leases", () => {
  it("reclaims a job whose worker died mid-attempt and ignores the dead worker's late completion", async () => {
    const { job } = await enqueue("test_jobs.direct");
    const [stale] = await jobsRepo.claimJobs(workerDb, ["test_jobs.direct"], 1, 60, a.id);
    expect(stale).toMatchObject({ id: job.id, attempt: 1, status: "running" });

    // While the lease holds, nobody else gets the job.
    expect(await runJobs(deps(), registry)).toBe(0);
    await makeDue(job.id);
    expect(await runJobs(deps(), registry)).toBe(1);
    expect(seen.map((s) => [s.id, s.attempt])).toEqual([[job.id, 2]]);
    expect(await jobRow(job.id)).toMatchObject({ status: "succeeded", attempt: 2 });

    // The first worker wakes up and reports a failure with its old lease: rejected.
    expect(await jobsRepo.completeJob(workerDb, stale!, { outcome: "failed", error: "late" })).toBeUndefined();
    expect(await jobRow(job.id)).toMatchObject({ status: "succeeded", attempt: 2, last_error: null });
  });

  it("dead-letters an abandoned job that had used its last attempt", async () => {
    const { job } = await enqueue("test_jobs.direct", 1);
    await jobsRepo.claimJobs(workerDb, ["test_jobs.direct"], 1, 60, a.id);
    await makeDue(job.id);
    expect(await runJobs(deps(), registry)).toBe(0);
    expect(await jobRow(job.id)).toMatchObject({ status: "dead", attempt: 1, last_error: "lease_expired", lease_token: null });
  });
});

describe("retries", () => {
  it("backs off after a failure, dead-letters after the last attempt, and stores a code, never the message", async () => {
    behavior["test_jobs.direct"] = () => Promise.reject(new Error("Ada Lovelace's answer: 4111 1111 1111 1111"));
    const { job } = await enqueue("test_jobs.direct", 3);

    expect(await runJobs(deps(), registry)).toBe(1);
    const afterFirst = await jobRow(job.id);
    expect(afterFirst).toMatchObject({ status: "queued", attempt: 1, last_error: "handler_error", finished_at: null });
    // Backoff for attempt 1 with a 60 s base: 30 to 60 s away.
    expect(afterFirst.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(await runJobs(deps(), registry)).toBe(0);

    for (const attempt of [2, 3]) {
      await makeDue(job.id);
      expect(await runJobs(deps(), registry)).toBe(1);
      expect((await jobRow(job.id)).attempt).toBe(attempt);
    }
    const dead = await jobRow(job.id);
    expect(dead).toMatchObject({ status: "dead", attempt: 3, last_error: "handler_error" });
    expect(dead.finished_at).not.toBeNull();
    expect(JSON.stringify(dead)).not.toMatch(/Ada Lovelace|4111 1111/);
    await makeDue(job.id);
    expect(await runJobs(deps(), registry)).toBe(0);
  });

  it("dead-letters a permanent failure at once", async () => {
    behavior["test_jobs.direct"] = () => Promise.reject(new PermanentJobError("destination_rejected", "422 from https://hooks.example.test/secret"));
    const { job } = await enqueue("test_jobs.direct");
    expect(await runJobs(deps(), registry)).toBe(1);
    expect(await jobRow(job.id)).toMatchObject({ status: "dead", attempt: 1, max_attempts: 8, last_error: "destination_rejected" });
  });
});

describe("concurrency (OPS-02)", () => {
  it("runs claimed jobs up to the given number at once, and one at a time by default", async () => {
    let running = 0;
    let peak = 0;
    behavior["test_jobs.direct"] = async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 150));
      running--;
    };
    const only = { "test_jobs.direct": registry["test_jobs.direct"]! };
    try {
      const parallel = await Promise.all([1, 2, 3, 4].map(() => enqueue("test_jobs.direct")));
      expect(await runJobs(deps(), only, 10, 4)).toBe(4);
      expect(peak).toBe(4);
      for (const { job } of parallel) expect((await jobRow(job.id)).status).toBe("succeeded");

      peak = 0;
      await Promise.all([1, 2, 3].map(() => enqueue("test_jobs.direct")));
      expect(await runJobs(deps(), only)).toBe(3);
      expect(peak).toBe(1);
    } finally {
      delete behavior["test_jobs.direct"];
    }
  });
});

describe("operators", () => {
  it("list jobs without payloads and replay dead ones with the same dedupe key; audited and tenant-bound", async () => {
    behavior["test_jobs.direct"] = () => Promise.reject(new PermanentJobError("destination_rejected"));
    const { job } = await enqueue("test_jobs.direct");
    await runJobs(deps(), registry);
    const base = `/api/v1/organizations/${a.id}/jobs`;

    const list = await consoleReq("ownerA", "get", `${base}?status=dead&type=test_jobs.direct`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const listed = JobListResponseSchema.parse(list.body).items.find((j) => j.id === job.id);
    expect(listed).toMatchObject({ status: "dead", attempt: 1, lastError: "destination_rejected", sourceEventId: null });
    expect(list.body.items[0]).not.toHaveProperty("payload");
    expect((await consoleReq("adminA", "get", base)).status).toBe(200);
    expectProblem(await consoleReq("analystA", "get", base), 403, "FORBIDDEN");
    expectProblem(await consoleReq("ownerB", "get", base), 404, "NOT_FOUND");

    // Paging walks every job once.
    const pageIds: string[] = [];
    for (let cursor: string | undefined, guard = 0; guard < 50; guard++) {
      const page = JobListResponseSchema.parse((await consoleReq("ownerA", "get", `${base}?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).body);
      pageIds.push(...page.items.map((j) => j.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(pageIds).toContain(job.id);

    const replay = `${base}/${job.id}/replay`;
    expectProblem(await consoleReq("analystA", "post", replay), 403, "FORBIDDEN");
    expectProblem(await consoleReq("ownerB", "post", `/api/v1/organizations/${b.id}/jobs/${job.id}/replay`), 404, "NOT_FOUND");
    const replayed = await consoleReq("adminA", "post", replay);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(JobResponseSchema.parse(replayed.body).job).toMatchObject({ status: "queued", attempt: 1, maxAttempts: 4, lastError: null, finishedAt: null });
    expectProblem(await consoleReq("adminA", "post", replay), 409, "JOB_NOT_DEAD");

    const audit = await withTenant(owner, a.id, (trx) => trx.selectFrom("audit_events").select(["action", "metadata"]).where("resource_id", "=", job.id).execute());
    expect(audit).toEqual([{ action: "job.replayed", metadata: { type: "test_jobs.direct", attempts: 1, lastError: "destination_rejected" } }]);

    // The destination is fixed; the replay succeeds and keeps the original dedupe key.
    behavior["test_jobs.direct"] = () => Promise.resolve();
    expect(await runJobs(deps(), registry)).toBe(1);
    expect(seen.at(-1)).toMatchObject({ id: job.id, dedupeKey: job.dedupeKey, attempt: 2 });
    expect(await jobRow(job.id)).toMatchObject({ status: "succeeded", attempt: 2 });
  });
});
