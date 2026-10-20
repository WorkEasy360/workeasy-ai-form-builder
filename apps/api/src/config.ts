import { AI_PROVIDERS } from "@workeasy/ai";
import { z } from "zod";

/** An empty value (`KEY=` in .env) means unset. */
const unsetIfEmpty = (v: unknown) => (v === "" ? undefined : v);

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.url(),
    /** The public role's connection, used only by /public/v1 (docs/02 §3). */
    DATABASE_PUBLIC_URL: z.url(),
    OIDC_ISSUER_URL: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    CONSOLE_PUBLIC_URL: z.url(),
    /** Public origin of the respondent app: share links, QR codes and embeds point here. */
    RESPONDENT_PUBLIC_URL: z.url().default("http://localhost:3001"),
    /** S3-compatible storage for uploads (docs/06 §3). */
    /** Unset: Amazon S3 in OBJECT_STORAGE_REGION. */
    OBJECT_STORAGE_ENDPOINT: z.preprocess(unsetIfEmpty, z.url().optional()),
    /** Where browsers reach storage for presigned uploads and downloads; defaults to the endpoint. */
    OBJECT_STORAGE_PUBLIC_ENDPOINT: z.preprocess(unsetIfEmpty, z.url().optional()),
    OBJECT_STORAGE_REGION: z.string().min(1).default("us-east-1"),
    /** Both or neither; neither uses the AWS default credential chain (on EC2, the instance role). */
    OBJECT_STORAGE_ACCESS_KEY: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
    OBJECT_STORAGE_SECRET_KEY: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
    OBJECT_STORAGE_BUCKET_QUARANTINE: z.string().min(3),
    OBJECT_STORAGE_BUCKET_CLEAN: z.string().min(3),
    OBJECT_STORAGE_BUCKET_EXPORTS: z.string().min(3),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    SESSION_COOKIE_SECURE: z.stringbool().default(true),
    /** AI authoring (AI-01); the worker holds the provider keys. "disabled" hides it. */
    AI_PROVIDER: z.enum(AI_PROVIDERS).default("disabled"),
    /** Encrypts webhook signing secrets at rest (AUT-01): 32 bytes, base64. Shared with the worker. */
    INTEGRATION_SECRET_KEY: z.string().min(40),
    /** Local development only: accept http:// and private webhook URLs. Refused in production. */
    WEBHOOK_ALLOW_PRIVATE_NETWORKS: z.stringbool().default(false),
  })
  .superRefine((config, ctx) => {
    // Static storage keys come in pairs; with neither, the AWS default credential chain is used.
    if (!config.OBJECT_STORAGE_ACCESS_KEY !== !config.OBJECT_STORAGE_SECRET_KEY) {
      ctx.addIssue({ code: "custom", path: ["OBJECT_STORAGE_SECRET_KEY"], message: "set both OBJECT_STORAGE_ACCESS_KEY and OBJECT_STORAGE_SECRET_KEY, or neither" });
    }
    if (config.NODE_ENV !== "production") return;
    // Local-only conveniences must be impossible to enable in production (docs/06 §1).
    if (config.WEBHOOK_ALLOW_PRIVATE_NETWORKS) {
      ctx.addIssue({ code: "custom", path: ["WEBHOOK_ALLOW_PRIVATE_NETWORKS"], message: "is for local development only" });
    }
    if (config.AI_PROVIDER === "stub") {
      ctx.addIssue({ code: "custom", path: ["AI_PROVIDER"], message: "stub is for local development and tests only" });
    }
    if (!config.SESSION_COOKIE_SECURE) {
      ctx.addIssue({ code: "custom", path: ["SESSION_COOKIE_SECURE"], message: "must be true in production" });
    }
    for (const key of ["OIDC_ISSUER_URL", "CONSOLE_PUBLIC_URL", "RESPONDENT_PUBLIC_URL"] as const) {
      if (new URL(config[key]).protocol !== "https:") {
        ctx.addIssue({ code: "custom", path: [key], message: "must use https in production" });
      }
    }
  });

export type ApiConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid API configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
