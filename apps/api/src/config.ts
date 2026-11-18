import { AI_PROVIDERS } from "@workeasy/ai";
import { ORG_ROLES } from "@workeasy/auth";
import { z } from "zod";

/** An empty value (`KEY=` in .env) means unset. */
const unsetIfEmpty = (v: unknown) => (v === "" ? undefined : v);

/** The callback path of WorkEasy360 sign-in on the console origin (docs/workeasy360-sso.md). */
export const WORKEASY360_CALLBACK_PATH = "/auth/workeasy360/callback";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Plain http is accepted only for a provider on this machine, and never in production. */
export function isLoopbackHttp(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.url(),
    /** The public role's connection, used only by /public/v1 (docs/02 §3). */
    DATABASE_PUBLIC_URL: z.url(),
    /** The generic OpenID Connect provider: all three, or none (then password and WorkEasy360 sign-in only). */
    OIDC_ISSUER_URL: z.preprocess(unsetIfEmpty, z.url().optional()),
    OIDC_CLIENT_ID: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
    OIDC_CLIENT_SECRET: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
    // --- WorkEasy360 Accounts (docs/workeasy360-sso.md); names as in the integration kit's .env.example ---
    /** Exactly the issuer WorkEasy360's discovery document names; no trailing slash. */
    WORKEASY360_ISSUER: z.preprocess(unsetIfEmpty, z.url().optional()),
    WORKEASY360_CLIENT_ID: z.preprocess(unsetIfEmpty, z.string().min(1).max(200).optional()),
    WORKEASY360_PRODUCT_CODE: z.preprocess(unsetIfEmpty, z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).default("workeasy_forms")),
    /** Defaults to <CONSOLE_PUBLIC_URL>/auth/workeasy360/callback; registered with WorkEasy360 exactly. */
    WORKEASY360_REDIRECT_URI: z.preprocess(unsetIfEmpty, z.url().optional()),
    /** Where WorkEasy360 returns the browser after its own sign-out; registered exactly. Defaults to <CONSOLE_PUBLIC_URL>/. */
    WORKEASY360_POST_LOGOUT_REDIRECT_URI: z.preprocess(unsetIfEmpty, z.url().optional()),
    /** The credential id WorkEasy360 shows for the registered public key (the client assertion's kid). */
    WORKEASY360_KEY_ID: z.preprocess(unsetIfEmpty, z.string().min(1).max(200).optional()),
    /** PEM file holding the private key (RSA or EC P-256). Never in the repository or an image. */
    WORKEASY360_PRIVATE_KEY_FILE: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
    WORKEASY360_SCOPES: z.preprocess(unsetIfEmpty, z.string().default("openid email profile organization")),
    /** true: WorkEasy360 is the only way in; password and generic sign-in, and their sessions, are refused. */
    WORKEASY360_SSO_ONLY: z.stringbool().default(false),
    /** The role someone gets on joining a tenant that already exists; the first person of a new tenant is its owner. */
    WORKEASY360_DEFAULT_ROLE: z.preprocess(unsetIfEmpty, z.enum(ORG_ROLES).default("creator")),
    /** false: an organization's first sign-in does not create a tenant; tenants are linked by the operator only. */
    WORKEASY360_PROVISION_TENANTS: z.stringbool().default(true),
    /** Shown on the "no access" page; defaults to the issuer. */
    WORKEASY360_PURCHASE_URL: z.preprocess(unsetIfEmpty, z.url().optional()),
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
    /** AI authoring (AI-01, run by the worker) and the console assistant (run here, docs/09). "disabled" hides both. */
    AI_PROVIDER: z.enum(AI_PROVIDERS).default("disabled"),
    /** The provider's model ID and key, shared with the worker; required for openai and gemini. */
    AI_MODEL: z.preprocess(unsetIfEmpty, z.string().min(1).max(100).optional()),
    OPENAI_API_KEY: z.preprocess(unsetIfEmpty, z.string().min(1).max(500).optional()),
    GEMINI_API_KEY: z.preprocess(unsetIfEmpty, z.string().min(1).max(500).optional()),
    /** Assistant questions per organization per UTC day. */
    ASSISTANT_DAILY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(200),
    /** Encrypts webhook signing secrets at rest (AUT-01): 32 bytes, base64. Shared with the worker. */
    INTEGRATION_SECRET_KEY: z.string().min(40),
    /** Local development only: accept http:// and private webhook URLs. Refused in production. */
    WEBHOOK_ALLOW_PRIVATE_NETWORKS: z.stringbool().default(false),
  })
  .superRefine((config, ctx) => {
    const oidc = [config.OIDC_ISSUER_URL, config.OIDC_CLIENT_ID, config.OIDC_CLIENT_SECRET].filter(Boolean).length;
    if (oidc !== 0 && oidc !== 3) {
      ctx.addIssue({ code: "custom", path: ["OIDC_ISSUER_URL"], message: "set OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET together, or none of them" });
    }
    const w360 = [config.WORKEASY360_ISSUER, config.WORKEASY360_CLIENT_ID, config.WORKEASY360_KEY_ID, config.WORKEASY360_PRIVATE_KEY_FILE];
    if (w360.some(Boolean) && !w360.every(Boolean)) {
      ctx.addIssue({
        code: "custom",
        path: ["WORKEASY360_ISSUER"],
        message: "set WORKEASY360_ISSUER, WORKEASY360_CLIENT_ID, WORKEASY360_KEY_ID and WORKEASY360_PRIVATE_KEY_FILE together, or none of them",
      });
    }
    if (config.WORKEASY360_SSO_ONLY && !config.WORKEASY360_ISSUER) {
      ctx.addIssue({ code: "custom", path: ["WORKEASY360_SSO_ONLY"], message: "needs WorkEasy360 sign-in to be configured" });
    }
    if (config.WORKEASY360_ISSUER) {
      const issuer = config.WORKEASY360_ISSUER;
      // Compared by exact string equality: a trailing slash would break every sign-in.
      if (issuer.endsWith("/")) ctx.addIssue({ code: "custom", path: ["WORKEASY360_ISSUER"], message: "must not end with a slash" });
      const https = new URL(issuer).protocol === "https:";
      if (!https && !(config.NODE_ENV !== "production" && isLoopbackHttp(issuer))) {
        ctx.addIssue({ code: "custom", path: ["WORKEASY360_ISSUER"], message: "must use https (plain http only for a loopback provider outside production)" });
      }
      if (config.OIDC_ISSUER_URL === issuer) {
        ctx.addIssue({ code: "custom", path: ["OIDC_ISSUER_URL"], message: "must not be the WorkEasy360 issuer; WorkEasy360 sign-in replaces it" });
      }
      const consoleOrigin = new URL(config.CONSOLE_PUBLIC_URL).origin;
      if (config.WORKEASY360_REDIRECT_URI) {
        const redirect = new URL(config.WORKEASY360_REDIRECT_URI);
        if (redirect.origin !== consoleOrigin || redirect.pathname !== WORKEASY360_CALLBACK_PATH || redirect.search || redirect.hash) {
          ctx.addIssue({ code: "custom", path: ["WORKEASY360_REDIRECT_URI"], message: `must be ${consoleOrigin}${WORKEASY360_CALLBACK_PATH}` });
        }
      }
      if (config.WORKEASY360_POST_LOGOUT_REDIRECT_URI && new URL(config.WORKEASY360_POST_LOGOUT_REDIRECT_URI).origin !== consoleOrigin) {
        ctx.addIssue({ code: "custom", path: ["WORKEASY360_POST_LOGOUT_REDIRECT_URI"], message: "must be on the console origin" });
      }
      const scopes = config.WORKEASY360_SCOPES.split(" ").filter(Boolean);
      if (!scopes.includes("openid") || !scopes.includes("email")) {
        // email_verified, which every sign-in requires, is released with the email scope.
        ctx.addIssue({ code: "custom", path: ["WORKEASY360_SCOPES"], message: "must include openid and email" });
      }
    }
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
    for (const key of ["OIDC_ISSUER_URL", "CONSOLE_PUBLIC_URL", "RESPONDENT_PUBLIC_URL", "WORKEASY360_REDIRECT_URI", "WORKEASY360_POST_LOGOUT_REDIRECT_URI"] as const) {
      const value = config[key];
      if (value && new URL(value).protocol !== "https:") {
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
