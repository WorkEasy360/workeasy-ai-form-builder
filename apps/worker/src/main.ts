import { createLogger } from "@workeasy/observability";
import { loadConfig } from "./config.js";
import { createHealthServer } from "./health.js";
import { startRunner, type PollingTask } from "./runner.js";

const config = loadConfig();
const logger = createLogger({ service: "worker", level: config.LOG_LEVEL });

// Outbox dispatch and job handlers are registered here by JOB-01 onwards.
const tasks: PollingTask[] = [];

const runner = startRunner({ tasks, intervalMs: config.WORKER_POLL_INTERVAL_MS, logger });
logger.info({ tasks: tasks.map((t) => t.name), intervalMs: config.WORKER_POLL_INTERVAL_MS }, "worker started");

const health = createHealthServer({
  lastIterationAt: runner.lastIterationAt,
  // Tasks may legitimately take a while; only a loop that stops iterating is unhealthy.
  maxStalenessMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 3, config.WORKER_MAX_ITERATION_MS),
});
health.listen(config.WORKER_HEALTH_PORT, () => {
  logger.info({ port: config.WORKER_HEALTH_PORT }, "worker health endpoint listening");
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker stopping; finishing in-flight work");
  await runner.stop();
  health.close();
  logger.info("worker stopped");
  process.exit(0);
}

process.on("SIGTERM", (s) => void shutdown(s));
process.on("SIGINT", (s) => void shutdown(s));
