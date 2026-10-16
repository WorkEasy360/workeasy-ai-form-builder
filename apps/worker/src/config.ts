import { AI_PROVIDERS } from "@workeasy/ai";
import { z } from "zod";

/** An optional setting where an empty value (`KEY=` in .env) means unset. */
const optionalText = (max: number) => z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).max(max).optional());

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
  /** AI authoring (AI-01): "disabled", "stub" (local, no account), "openai" or "gemini". */
  AI_PROVIDER: z.enum(AI_PROVIDERS).default("disabled"),
  /** The provider's model ID; required for openai and gemini. */
  AI_MODEL: optionalText(100),
  OPENAI_API_KEY: optionalText(500),
  GEMINI_API_KEY: optionalText(500),
  /** Encrypts webhook signing secrets at rest (AUT-01): 32 bytes, base64. Shared with the API. */
  INTEGRATION_SECRET_KEY: z.string().min(40),
  /** Local development only: let webhooks reach http:// and private addresses. Refused in production. */
  WEBHOOK_ALLOW_PRIVATE_NETWORKS: z.stringbool().default(false),
  /** SMTP relay for notification email; unset means email deliveries fail as email_not_configured. */
  SMTP_HOST: optionalText(200),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_USER: optionalText(200),
  SMTP_PASSWORD: optionalText(500),
  MAIL_FROM: z.string().min(3).max(200).default("Workeasy <notifications@workeasy.test>"),
  /** Links in notification email point at the console. */
  CONSOLE_PUBLIC_URL: z.url().default("http://localhost:3000"),
});

export type WorkerConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid worker configuration:\n${z.prettifyError(result.error)}`);
  }
  if (result.data.NODE_ENV === "production" && result.data.WEBHOOK_ALLOW_PRIVATE_NETWORKS) {
    throw new Error("Invalid worker configuration: WEBHOOK_ALLOW_PRIVATE_NETWORKS is for local development only");
  }
  if (result.data.NODE_ENV === "production" && result.data.AI_PROVIDER === "stub") {
    throw new Error("Invalid worker configuration: AI_PROVIDER=stub is for local development and tests only");
  }
  return result.data;
}
