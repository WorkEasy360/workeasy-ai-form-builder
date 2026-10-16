import { AI_GENERATE_JOB, aiGenerationJob, type AiJobDeps } from "@workeasy/ai";
import type { JobRegistry } from "@workeasy/jobs";

/**
 * The job types this worker runs and the events that create them. AI
 * generation (AI-01) is enqueued directly by the API; email and webhook
 * delivery (AUT-01) will subscribe to events here. Events no type subscribes
 * to are marked dispatched with no jobs.
 */
export function createRegistry(deps: AiJobDeps): JobRegistry {
  return {
    [AI_GENERATE_JOB]: aiGenerationJob(deps),
  };
}
