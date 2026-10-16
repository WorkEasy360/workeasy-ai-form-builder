import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  /** Longest a single loop iteration may run before liveness reports the worker as stalled. */
  WORKER_MAX_ITERATION_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),
  /** The worker database role (docs/02 §3). */
  DATABASE_WORKER_URL: z.url(),
  OBJECT_STORAGE_ENDPOINT: z.url(),
  OBJECT_STORAGE_PUBLIC_ENDPOINT: z.url().optional(),
  OBJECT_STORAGE_REGION: z.string().min(1).default("us-east-1"),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(1),
  OBJECT_STORAGE_BUCKET_QUARANTINE: z.string().min(3),
  OBJECT_STORAGE_BUCKET_CLEAN: z.string().min(3),
  OBJECT_STORAGE_BUCKET_EXPORTS: z.string().min(3),
  /** clamd for upload scanning (FIL-01). */
  SCANNER_HOST: z.string().min(1).default("127.0.0.1"),
  SCANNER_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
});

export type WorkerConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid worker configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
