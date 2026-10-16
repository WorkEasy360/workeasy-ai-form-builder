/**
 * @workeasy/jobs
 *
 * Outbox dispatch and durable jobs (docs/04 §6, ADR-008). Job types and the
 * events they subscribe to are declared in a registry; the worker dispatches
 * committed outbox events into jobs and runs them under leases, retrying with
 * backoff and dead-lettering after the last attempt. Execution is at least
 * once: handlers pass `dedupeKey` to destinations so a repeat is recognized.
 */
export { backoffDelayMs, type BackoffOptions } from "./backoff.js";
export { dispatchOutbox, errorCode, PermanentJobError, routesFor, runJobs, type JobContext, type JobDefinition, type JobDeps, type JobRegistry } from "./runner.js";
