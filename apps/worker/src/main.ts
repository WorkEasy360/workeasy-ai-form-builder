import { createDb } from "@workeasy/database";
import { providerFromSettings } from "@workeasy/ai";
import { dispatchOutbox, runJobs, type JobDeps } from "@workeasy/jobs";
import { createObjectStore, expireStaleUploads, scanPendingUploads, type ScanDeps } from "@workeasy/files";
import { createLogger } from "@workeasy/observability";
import { applyRetention, expireOldExports, processExports, purgeDeletedResponses } from "@workeasy/responses";
import { loadConfig } from "./config.js";
import { createHealthServer } from "./health.js";
import { createRegistry } from "./jobs.js";
import { startRunner, type PollingTask } from "./runner.js";

const config = loadConfig();
const logger = createLogger({ service: "worker", level: config.LOG_LEVEL });

const workerDb = createDb({ connectionString: config.DATABASE_WORKER_URL, applicationName: "workeasy-worker" });
const scanDeps: ScanDeps = {
  workerDb,
  store: createObjectStore({
    endpoint: config.OBJECT_STORAGE_ENDPOINT,
    publicEndpoint: config.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? config.OBJECT_STORAGE_ENDPOINT,
    region: config.OBJECT_STORAGE_REGION,
    accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY,
    secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY,
    quarantineBucket: config.OBJECT_STORAGE_BUCKET_QUARANTINE,
    cleanBucket: config.OBJECT_STORAGE_BUCKET_CLEAN,
    exportsBucket: config.OBJECT_STORAGE_BUCKET_EXPORTS,
  }),
  scanner: { host: config.SCANNER_HOST, port: config.SCANNER_PORT },
  log: (level, message, fields) => logger[level](fields, message),
};

const jobDeps: JobDeps = { workerDb, log: (level, message, fields) => logger[level](fields, message) };
const aiProvider = providerFromSettings(config);
const registry = createRegistry({ workerDb, provider: aiProvider, log: jobDeps.log! });

const tasks: PollingTask[] = [
  {
    // Committed outbox events become jobs; a crash before this runs only delays them.
    name: "dispatch-outbox",
    async run() {
      while ((await dispatchOutbox(jobDeps, registry, 100)).events === 100);
    },
  },
  {
    name: "run-jobs",
    async run() {
      await runJobs(jobDeps, registry, 10);
    },
  },
  {
    name: "scan-uploads",
    async run() {
      // One batch per iteration: if the scanner is down, retries wait for the next interval.
      await scanPendingUploads(scanDeps, 10);
    },
  },
  {
    name: "build-exports",
    async run() {
      await processExports(scanDeps, 2);
    },
  },
  {
    name: "expire-exports",
    async run() {
      await expireOldExports(scanDeps, 100);
    },
  },
  {
    // Retention first, so responses it deletes are purged in the same iteration.
    name: "apply-retention",
    async run() {
      await applyRetention(scanDeps, 500);
    },
  },
  {
    name: "purge-deleted",
    async run() {
      await purgeDeletedResponses(scanDeps, 50);
    },
  },
  {
    name: "expire-uploads",
    async run() {
      await expireStaleUploads(scanDeps, 100);
    },
  },
];

const runner = startRunner({ tasks, intervalMs: config.WORKER_POLL_INTERVAL_MS, logger });
logger.info({ tasks: tasks.map((t) => t.name), intervalMs: config.WORKER_POLL_INTERVAL_MS, aiProvider: aiProvider ? `${aiProvider.name}/${aiProvider.model}` : "disabled" }, "worker started");

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
  await workerDb.destroy();
  logger.info("worker stopped");
  process.exit(0);
}

process.on("SIGTERM", (s) => void shutdown(s));
process.on("SIGINT", (s) => void shutdown(s));
