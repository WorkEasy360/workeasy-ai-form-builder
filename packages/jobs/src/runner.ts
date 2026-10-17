import { jobsRepo, type ClaimedJob, type Db } from "@workeasy/database";
import { backoffDelayMs, type BackoffOptions } from "./backoff.js";

export interface JobContext {
  id: string;
  tenantId: string;
  type: string;
  /** References only; for event-derived jobs, the event envelope. */
  payload: Record<string, unknown>;
  /** Stable across retries and replays: pass it to destinations as their idempotency key. */
  dedupeKey: string;
  /** 1 on the first try. */
  attempt: number;
  maxAttempts: number;
  traceId: string | null;
  /** Aborted shortly before the lease runs out; stop and let the retry take over. */
  signal: AbortSignal;
}

export interface JobDefinition {
  /** Event types that create this job when dispatched. */
  events?: readonly string[];
  /**
   * Runs one attempt. Use `withTenant(workerDb, ctx.tenantId, …)` for data:
   * a job executes under its recorded tenant and nothing else. Throw
   * PermanentJobError for failures a retry cannot fix; anything else retries.
   */
  handle(ctx: JobContext): Promise<void>;
  /** How long one attempt may hold the job. Default 60 seconds. */
  leaseSeconds?: number;
  /** Delay before retrying after the given attempt; default exponential backoff with jitter. */
  retryDelayMs?: (attempt: number) => number;
}

/** Job types by name. */
export type JobRegistry = Readonly<Record<string, JobDefinition>>;

export interface JobDeps {
  workerDb: Db;
  log?: (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
  backoff?: BackoffOptions;
  /** Limits dispatch and claims to one tenant (tests and operator tooling). */
  tenantId?: string;
}

/** A failure that retrying cannot fix: the job is dead-lettered at once. */
export class PermanentJobError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/**
 * A transient failure with a known retry time, such as a 429 with
 * Retry-After. The delay replaces the job type's own schedule.
 */
export class RetryLaterError extends Error {
  constructor(
    readonly code: string,
    readonly delayMs: number,
  ) {
    super(code);
    this.name = "RetryLaterError";
  }
}

const DEFAULT_LEASE_SECONDS = 60;
/** The handler's signal aborts this long before the lease ends. */
const LEASE_MARGIN_MS = 2_000;

/**
 * A storable code for an error, never its message (messages can carry
 * answers or credentials): PermanentJobError's code, a Node-style `code`, or
 * a generic one.
 */
export function errorCode(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  const raw = err !== null && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
  if (typeof raw === "string") {
    const code = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 100);
    if (/^[a-z][a-z0-9_]*$/.test(code)) return code;
  }
  return "handler_error";
}

function retryDelay(def: JobDefinition, attempt: number, err: unknown, deps: JobDeps): number {
  if (err instanceof RetryLaterError) return Math.max(0, err.delayMs);
  return def.retryDelayMs ? def.retryDelayMs(attempt) : backoffDelayMs(attempt, deps.backoff);
}

/** The event → job types map the dispatcher needs, from the registry. */
export function routesFor(registry: JobRegistry): Record<string, string[]> {
  const routes: Record<string, string[]> = {};
  for (const [type, def] of Object.entries(registry)) {
    for (const event of def.events ?? []) (routes[event] ??= []).push(type);
  }
  return routes;
}

/** Dispatches up to `limit` committed outbox events into jobs. */
export function dispatchOutbox(deps: JobDeps, registry: JobRegistry, limit = 100): Promise<{ events: number; jobs: number }> {
  return jobsRepo.dispatchOutbox(deps.workerDb, routesFor(registry), limit, deps.tenantId);
}

async function runOne(deps: JobDeps, def: JobDefinition, job: ClaimedJob): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, job.leaseUntil.getTime() - Date.now() - LEASE_MARGIN_MS));
  const fields = { jobId: job.id, type: job.type, tenantId: job.tenantId, attempt: job.attempt, traceId: job.traceId };
  let status: string | undefined;
  try {
    await def.handle({
      id: job.id,
      tenantId: job.tenantId,
      type: job.type,
      payload: job.payload,
      dedupeKey: job.dedupeKey,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      traceId: job.traceId,
      signal: controller.signal,
    });
    status = await jobsRepo.completeJob(deps.workerDb, job, { outcome: "succeeded" });
  } catch (err) {
    const error = errorCode(err);
    status =
      err instanceof PermanentJobError
        ? await jobsRepo.completeJob(deps.workerDb, job, { outcome: "failed", error })
        : await jobsRepo.completeJob(deps.workerDb, job, { outcome: "retry", error, retryAt: new Date(Date.now() + retryDelay(def, job.attempt, err, deps)) });
    deps.log?.(status === "dead" ? "error" : "warn", status === "dead" ? "job dead-lettered" : "job attempt failed; will retry", { ...fields, error });
  } finally {
    clearTimeout(timer);
  }
  // Another worker reclaimed it after the lease ran out; its outcome stands.
  if (status === undefined) deps.log?.("warn", "job lease lost before completion; outcome discarded", fields);
}

/**
 * Claims and runs up to `limit` due jobs per lease length, `concurrency` at
 * a time; returns how many were claimed. A crash at any point leaves the job leased,
 * and it is claimed again once the lease runs out.
 */
export async function runJobs(deps: JobDeps, registry: JobRegistry, limit = 10, concurrency = 1): Promise<number> {
  const byLease = new Map<number, string[]>();
  for (const [type, def] of Object.entries(registry)) {
    const lease = def.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    byLease.set(lease, [...(byLease.get(lease) ?? []), type]);
  }
  let claimed = 0;
  for (const [lease, types] of byLease) {
    const jobs = await jobsRepo.claimJobs(deps.workerDb, types, limit, lease, deps.tenantId);
    claimed += jobs.length;
    // Up to `concurrency` jobs at once, so one slow job (an AI generation) does not hold up the rest.
    let next = 0;
    const lane = async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        await runOne(deps, registry[job.type]!, job);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, lane));
  }
  return claimed;
}
