/**
 * @workeasy/integrations
 *
 * Server-only destination adapters (docs/05 §6): signed webhooks with SSRF
 * defenses, notification email over SMTP, encrypted signing secrets, and the
 * durable fan-out and delivery jobs that keep a history of every attempt.
 * Never imported by browser code.
 */
export {
  DELIVER_JOB,
  DELIVERY_MAX_ATTEMPTS,
  deliverJob,
  deliveryRetryDelayMs,
  FANOUT_JOB,
  fanoutJob,
  webhookPayload,
  type DeliveryDeps,
} from "./delivery.js";
export { createMailer, headerSafe, type Mailer, type MailerSettings, type MailResult } from "./email.js";
export { decryptSecret, encryptSecret, newWebhookSecret, parseSecretKey } from "./secrets.js";
export { SIGNATURE_TOLERANCE_SECONDS, signatureHeader, verifyWebhookSignature } from "./signing.js";
export {
  checkWebhookUrl,
  DestinationBlockedError,
  isBlockedAddress,
  resolveDestination,
  STRICT_POLICY,
  systemResolver,
  type DestinationPolicy,
  type DestinationProblem,
  type Resolver,
} from "./ssrf.js";
export { sendWebhook, WEBHOOK_TIMEOUT_MS, type WebhookRequest, type WebhookResult } from "./webhook.js";
