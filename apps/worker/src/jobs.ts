import { AI_GENERATE_JOB, aiGenerationJob, type AiJobDeps } from "@workeasy/ai";
import { DELIVER_JOB, deliverJob, FANOUT_JOB, fanoutJob, type DeliveryDeps } from "@workeasy/integrations";
import type { JobRegistry } from "@workeasy/jobs";

/**
 * The job types this worker runs and the events that create them. AI
 * generation (AI-01) is enqueued by the API; accepted responses fan out into
 * one email or webhook delivery per integration (AUT-01). Events no type
 * subscribes to are marked dispatched with no jobs.
 */
export function createRegistry(deps: { ai: AiJobDeps; delivery: DeliveryDeps }): JobRegistry {
  return {
    [AI_GENERATE_JOB]: aiGenerationJob(deps.ai),
    [FANOUT_JOB]: fanoutJob(deps.delivery),
    [DELIVER_JOB]: deliverJob(deps.delivery),
  };
}
