import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";

export type { Logger };

/**
 * Log keys that must never reach log output (docs/06 §8): credentials,
 * capability tokens, signed URLs, respondent answers and AI prompts.
 */
export const REDACTED_PATHS: readonly string[] = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "answers",
  "*.answers",
  "prompt",
  "*.prompt",
  "signedUrl",
  "*.signedUrl",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
];

export interface SafeError {
  type: string;
  message?: string;
  code?: string;
  constraint?: string;
  table?: string;
  stack?: string;
}

/**
 * Error serializer that keeps an allowlist of fields. Libraries attach
 * request data to errors (PostgreSQL `detail`/`where`, HTTP client bodies),
 * so nothing outside the allowlist is logged. PostgreSQL messages can quote
 * submitted values (e.g. `invalid input syntax for type uuid: "…"`), so for
 * database errors only the SQLSTATE and schema object names are kept.
 */
export function serializeError(value: unknown): SafeError | unknown {
  if (!(value instanceof Error)) return value;
  const err = value as Error & Record<string, unknown>;
  const code = typeof err.code === "string" ? err.code : undefined;
  const isDatabaseError = typeof err.severity === "string" && code !== undefined && /^[0-9A-Z]{5}$/.test(code);
  const safe: SafeError = { type: err.name };
  if (isDatabaseError) {
    safe.code = code;
    if (typeof err.constraint === "string") safe.constraint = err.constraint;
    if (typeof err.table === "string") safe.table = err.table;
    safe.message = "database error (message withheld; see code)";
  } else {
    safe.message = err.message;
    if (code !== undefined) safe.code = code;
  }
  if (err.stack) safe.stack = isDatabaseError ? err.stack.split("\n").slice(1).join("\n") : err.stack;
  return safe;
}

export interface CreateLoggerOptions {
  /** Logical process name, e.g. "api" or "worker". */
  service: string;
  level?: string;
  /** Output stream; defaults to stdout. */
  destination?: DestinationStream;
}

export function createLogger({ service, level = "info", destination }: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACTED_PATHS], censor: "[REDACTED]" },
    serializers: { err: serializeError, error: serializeError },
  };
  return destination ? pino(options, destination) : pino(options);
}
