import type { Logger } from "@workeasy/observability";

/** One unit of background work, e.g. claiming outbox events or due jobs. */
export interface PollingTask {
  name: string;
  run(signal: AbortSignal): Promise<void>;
}

export interface RunnerOptions {
  tasks: readonly PollingTask[];
  intervalMs: number;
  logger: Logger;
}

export interface Runner {
  stop(): Promise<void>;
  /** Epoch milliseconds when the loop last started an iteration; a stuck loop stops advancing it. */
  lastIterationAt(): number;
}

/**
 * Runs each task once per interval until stopped. Stopping prevents new
 * iterations and resolves after the in-flight iteration finishes, so the
 * process never abandons a claimed unit of work mid-flight.
 */
export function startRunner({ tasks, intervalMs, logger }: RunnerOptions): Runner {
  const controller = new AbortController();
  let wake: (() => void) | undefined;
  let lastIteration = Date.now();

  const loop = (async () => {
    while (!controller.signal.aborted) {
      lastIteration = Date.now();
      for (const task of tasks) {
        if (controller.signal.aborted) break;
        try {
          await task.run(controller.signal);
        } catch (err) {
          logger.error({ err, task: task.name }, "worker task failed");
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();

  return {
    async stop() {
      controller.abort();
      wake?.();
      await loop;
    },
    lastIterationAt: () => lastIteration,
  };
}
