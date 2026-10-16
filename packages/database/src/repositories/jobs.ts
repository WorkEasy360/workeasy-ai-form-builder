import { sql, type Selectable, type Transaction } from "kysely";
import type { Db } from "../client.js";
import type { Database, JobStatus, JobsTable } from "../schema.js";

/**
 * Outbox dispatch and durable jobs (docs/04 §6). The worker dispatches,
 * claims and completes through the migration 0014 functions, which work
 * across tenants; handlers then run under the job's recorded tenant. The API
 * enqueues jobs, lists them and replays dead ones in its tenant context.
 */
type Trx = Transaction<Database>;

export interface Job {
  id: string;
  tenantId: string;
  type: string;
  sourceEventId: string | null;
  dedupeKey: string;
  payload: Record<string, unknown>;
  traceId: string | null;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

/** A job held under a lease; completing it needs the lease token. */
export interface ClaimedJob extends Job {
  leaseToken: string;
  leaseUntil: Date;
}

export type JobOutcome = { outcome: "succeeded" } | { outcome: "retry"; error: string; retryAt: Date } | { outcome: "failed"; error: string };

function toJob(r: Selectable<JobsTable>): Job {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type,
    sourceEventId: r.source_event_id,
    dedupeKey: r.dedupe_key,
    payload: r.payload,
    traceId: r.trace_id,
    status: r.status,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

/**
 * Moves up to `limit` committed outbox events into jobs, one per subscribed
 * job type, and marks them dispatched in the same transaction.
 */
export async function dispatchOutbox(db: Db, routes: Record<string, readonly string[]>, limit: number, tenantId?: string): Promise<{ events: number; jobs: number }> {
  const { rows } = await sql<{ events: number; jobs: number }>`
    SELECT * FROM app.dispatch_outbox(${JSON.stringify(routes)}::jsonb, ${limit}::integer, ${tenantId ?? null}::uuid)`.execute(db);
  return rows[0] ?? { events: 0, jobs: 0 };
}

export async function claimJobs(db: Db, types: readonly string[], limit: number, leaseSeconds: number, tenantId?: string): Promise<ClaimedJob[]> {
  if (types.length === 0) return [];
  const { rows } = await sql<Selectable<JobsTable>>`
    SELECT * FROM app.claim_jobs(${[...types]}::text[], ${limit}::integer, ${leaseSeconds}::integer, ${tenantId ?? null}::uuid)`.execute(db);
  return rows.map((r) => ({ ...toJob(r), leaseToken: r.lease_token!, leaseUntil: r.lease_until! }));
}

/** Records an attempt's outcome; returns the new status, or undefined if the lease was lost. */
export async function completeJob(db: Db, job: Pick<ClaimedJob, "id" | "leaseToken">, result: JobOutcome): Promise<JobStatus | undefined> {
  const error = result.outcome === "succeeded" ? null : result.error;
  const retryAt = result.outcome === "retry" ? result.retryAt : null;
  const { rows } = await sql<{ status: JobStatus | null }>`
    SELECT app.complete_job(${job.id}::uuid, ${job.leaseToken}::uuid, ${result.outcome}, ${error}, ${retryAt}::timestamptz) AS status`.execute(db);
  return rows[0]?.status ?? undefined;
}

export interface NewJob {
  tenantId: string;
  type: string;
  /** Stable for the action, so enqueueing it again returns the existing job. */
  dedupeKey: string;
  payload: Record<string, unknown>;
  traceId?: string | undefined;
  maxAttempts?: number;
}

/** Enqueues a job in the tenant context; returns it and whether it is new. */
export async function enqueueJob(trx: Trx, input: NewJob): Promise<{ job: Job; created: boolean }> {
  const inserted = await trx
    .insertInto("jobs")
    .values({
      tenant_id: input.tenantId,
      type: input.type,
      dedupe_key: input.dedupeKey,
      payload: input.payload,
      trace_id: input.traceId ?? null,
      ...(input.maxAttempts ? { max_attempts: input.maxAttempts } : {}),
    })
    .onConflict((oc) => oc.constraint("jobs_dedupe").doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return { job: toJob(inserted), created: true };
  const existing = await trx
    .selectFrom("jobs")
    .selectAll()
    .where("tenant_id", "=", input.tenantId)
    .where("type", "=", input.type)
    .where("dedupe_key", "=", input.dedupeKey)
    .executeTakeFirstOrThrow();
  return { job: toJob(existing), created: false };
}

export async function getJob(trx: Trx, id: string): Promise<Job | undefined> {
  const row = await trx.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? toJob(row) : undefined;
}

export interface JobQuery {
  status?: JobStatus | undefined;
  type?: string | undefined;
  /** Keyset: the last job of the previous page. */
  after?: { createdAt: string; id: string } | undefined;
  limit: number;
}

/** Newest first. `createdAtKey` is the exact timestamp text for the next cursor. */
export async function listJobs(trx: Trx, query: JobQuery): Promise<{ jobs: Array<Job & { createdAtKey: string }>; more: boolean }> {
  let q = trx.selectFrom("jobs").selectAll().select(sql<string>`created_at::text`.as("created_at_key"));
  if (query.after) q = q.where(sql<boolean>`(created_at, id) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`);
  if (query.status) q = q.where("status", "=", query.status);
  if (query.type) q = q.where("type", "=", query.type);
  const rows = await q.orderBy("created_at", "desc").orderBy("id", "desc").limit(query.limit + 1).execute();
  return { jobs: rows.slice(0, query.limit).map((r) => ({ ...toJob(r), createdAtKey: r.created_at_key })), more: rows.length > query.limit };
}

/** Additional attempts a replay grants a dead job. */
export const REPLAY_ATTEMPTS = 3;

/**
 * Requeues a dead job now with a few more attempts. Its dedupe key is kept,
 * so destinations still recognize a repeat of the same action.
 */
export async function replayJob(trx: Trx, id: string): Promise<Job | undefined> {
  const row = await trx
    .updateTable("jobs")
    .set((eb) => ({
      status: "queued",
      max_attempts: sql<number>`least(${eb.ref("attempt")} + ${REPLAY_ATTEMPTS}, 1000)`,
      next_attempt_at: sql<Date>`now()`,
      last_error: null,
      finished_at: null,
      updated_at: sql<Date>`now()`,
    }))
    .where("id", "=", id)
    .where("status", "=", "dead")
    .returningAll()
    .executeTakeFirst();
  return row ? toJob(row) : undefined;
}
