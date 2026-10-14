import { z } from "zod";

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.url(),
    OIDC_ISSUER_URL: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    CONSOLE_PUBLIC_URL: z.url(),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    SESSION_COOKIE_SECURE: z.stringbool().default(true),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== "production") return;
    // Local-only conveniences must be impossible to enable in production (docs/06 §1).
    if (!config.SESSION_COOKIE_SECURE) {
      ctx.addIssue({ code: "custom", path: ["SESSION_COOKIE_SECURE"], message: "must be true in production" });
    }
    for (const key of ["OIDC_ISSUER_URL", "CONSOLE_PUBLIC_URL"] as const) {
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
