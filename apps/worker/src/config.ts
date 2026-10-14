import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  /** Longest a single loop iteration may run before liveness reports the worker as stalled. */
  WORKER_MAX_ITERATION_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),
});

export type WorkerConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid worker configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
