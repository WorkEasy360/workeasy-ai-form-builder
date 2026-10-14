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
  };
  return destination ? pino(options, destination) : pino(options);
}
