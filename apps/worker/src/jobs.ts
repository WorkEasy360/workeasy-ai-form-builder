import type { JobRegistry } from "@workeasy/jobs";

/**
 * The job types this worker runs and the events that create them. Email and
 * webhook delivery (AUT-01) and AI generation (AI-01) register here. Until a
 * type subscribes to an event, dispatch marks the event delivered with no jobs.
 */
export const registry: JobRegistry = {};
