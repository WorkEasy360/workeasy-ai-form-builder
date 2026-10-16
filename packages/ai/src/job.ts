import { aiRepo, withTenant, type Database, type Db, type GenerationOutcome } from "@workeasy/database";
import type { Transaction } from "kysely";
import type { FormDefinition } from "@workeasy/form-schema";
import type { JobDefinition } from "@workeasy/jobs";
import { generateProposal } from "./generate.js";
import { ProviderError, type JsonCompletionProvider, type Usage } from "./provider.js";

export const AI_GENERATE_JOB = "ai.generate";
/** The first try plus at most two transient retries (docs/03 §4). */
export const AI_GENERATE_MAX_ATTEMPTS = 3;
/** Every generation must end this long after it was requested. */
export const AI_DEADLINE_SECONDS = 120;
/** Share of the daily budget at which the worker raises a spend alarm. */
export const AI_BUDGET_ALARM_RATIO = 0.8;

export interface AiJobDeps {
  workerDb: Db;
  /** Undefined when AI is disabled for this worker: queued generations fail as unavailable. */
  provider: JsonCompletionProvider | undefined;
  log?: (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/**
 * Runs one AI generation (enqueued by the API with the generation's ID as
 * dedupe key). The outcome is a validated proposal or a failure code on the
 * generation; the draft is never touched. Prompts and replies are never
 * logged. A cancellation while the provider works wins over the result.
 */
export function aiGenerationJob(deps: AiJobDeps): JobDefinition {
  return {
    // Two provider calls of up to 45 s each, with room to record the result.
    leaseSeconds: 150,
    async handle(ctx) {
      const id = String(ctx.payload.generationId);
      const inTenant = <T>(fn: (trx: Transaction<Database>) => Promise<T>) => withTenant(deps.workerDb, ctx.tenantId, fn);
      const fields = { generationId: id, jobId: ctx.id, attempt: ctx.attempt, tenantId: ctx.tenantId };
      // Records the outcome, releases the reservation, and warns when the day's budget is nearly spent.
      const finish = (outcome: GenerationOutcome, usage: Usage) =>
        inTenant(async (trx) => {
          await aiRepo.finishGeneration(trx, id, outcome, usage);
          await aiRepo.settleGeneration(trx, id);
          const [settings, today] = await Promise.all([aiRepo.getSettings(trx), aiRepo.usageToday(trx)]);
          if (today.used >= settings.dailyTokenLimit * AI_BUDGET_ALARM_RATIO) {
            deps.log?.("warn", "AI daily token budget nearly used", { tenantId: ctx.tenantId, usedTokens: today.used, dailyTokenLimit: settings.dailyTokenLimit });
          }
        });

      const provider = deps.provider ?? { name: "none", model: "none" };
      const generation = await inTenant((trx) => aiRepo.startGeneration(trx, id, provider));
      if (!generation) {
        // Cancelled, already finished, or out of time: release whatever it still holds.
        await inTenant(async (trx) => {
          await aiRepo.expireOverdue(trx, id);
          await aiRepo.settleGeneration(trx, id);
        });
        return;
      }
      if (!deps.provider) {
        await finish({ status: "failed", failureCode: "ai_unavailable" }, NO_USAGE);
        return;
      }
      // The organization may have turned AI off since the request.
      if (!(await inTenant((trx) => aiRepo.getSettings(trx))).enabled) {
        await finish({ status: "failed", failureCode: "ai_not_enabled" }, NO_USAGE);
        return;
      }

      const remaining = generation.deadlineAt.getTime() - Date.now();
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(0, remaining))]);
      let result: Awaited<ReturnType<typeof generateProposal>>;
      try {
        result = await generateProposal(
          deps.provider,
          { operation: generation.operation, prompt: generation.prompt!, base: generation.baseDefinition as unknown as FormDefinition },
          signal,
        );
      } catch (err) {
        const overdue = Date.now() >= generation.deadlineAt.getTime();
        if (err instanceof ProviderError) {
          if (err.retryable && !overdue && ctx.attempt < ctx.maxAttempts) {
            await inTenant((trx) => aiRepo.addUsage(trx, id, err.usage));
            deps.log?.("warn", "AI provider call failed; will retry", { ...fields, error: err.code });
            throw err;
          }
          await finish({ status: "failed", failureCode: overdue ? "deadline_exceeded" : err.code }, err.usage);
          deps.log?.("warn", "AI generation failed", { ...fields, error: overdue ? "deadline_exceeded" : err.code });
          return;
        }
        // A bug, or storage trouble: retry while attempts remain, then fail the generation.
        if (ctx.attempt >= ctx.maxAttempts) await finish({ status: "failed", failureCode: "internal_error" }, NO_USAGE);
        throw err;
      }

      if (result.ok) {
        await finish({ status: "succeeded", proposal: result.definition as unknown as Record<string, unknown>, summary: { ...result.summary } }, result.usage);
        deps.log?.("info", "AI generation succeeded", { ...fields, ...result.usage });
        return;
      }
      // Issue codes and paths only: messages can quote the reply.
      const issues = result.issues.slice(0, 20).map((i) => ({ path: i.path, code: i.code }));
      await finish({ status: "failed", failureCode: result.code, summary: { issues } }, result.usage);
      deps.log?.("warn", "AI generation produced no valid form", { ...fields, issues: issues.length });
    },
  };
}
