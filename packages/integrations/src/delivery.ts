import { createHash } from "node:crypto";
import { integrationsRepo, jobsRepo, withTenant, type AttemptRecord, type ConfirmationLimits, type Database, type Db, type DeliveryContext } from "@workeasy/database";
import { PermanentJobError, RetryLaterError, type JobDefinition } from "@workeasy/jobs";
import type { Transaction } from "kysely";
import { headerSafe, type Mailer } from "./email.js";
import { decryptSecret } from "./secrets.js";
import { signatureHeader } from "./signing.js";
import type { DestinationPolicy, Resolver } from "./ssrf.js";
import { sendWebhook } from "./webhook.js";

export const FANOUT_JOB = "integrations.fanout";
export const DELIVER_JOB = "integrations.deliver";
/** The first try plus six retries (docs/05 §6). */
export const DELIVERY_MAX_ATTEMPTS = 7;
const RETRY_SCHEDULE_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000];

/** Roughly 1m, 5m, 30m, 2h, 8h, 24h after attempts 1..6, each ±20%. */
export function deliveryRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_SCHEDULE_MS[Math.min(Math.max(attempt, 1), RETRY_SCHEDULE_MS.length) - 1]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface DeliveryDeps {
  workerDb: Db;
  /** Decrypts webhook signing secrets. */
  secretKey: Buffer;
  policy: DestinationPolicy;
  resolve?: Resolver;
  /** Undefined when no SMTP relay is configured: email deliveries fail as email_not_configured. */
  mailer: Mailer | undefined;
  /** Links in emails point here. */
  consolePublicUrl: string;
  log?: (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
}

type Trx = Transaction<Database>;

/**
 * Turns an accepted response into one delivery per enabled integration of
 * its form, and their jobs, in one transaction. Dispatched again, it finds
 * the same deliveries and jobs: nothing is sent twice.
 */
export function fanoutJob(deps: Pick<DeliveryDeps, "workerDb">): JobDefinition {
  return {
    events: ["submission.accepted.v1"],
    async handle(ctx) {
      const eventId = String(ctx.payload.eventId);
      const data = ctx.payload.data as { formId: string; submissionId: string };
      await withTenant(deps.workerDb, ctx.tenantId, async (trx: Trx) => {
        for (const integration of await integrationsRepo.enabledIntegrations(trx, data.formId)) {
          const deliveryId = await integrationsRepo.ensureDelivery(trx, {
            tenantId: ctx.tenantId,
            integrationId: integration.id,
            formId: data.formId,
            submissionId: data.submissionId,
            eventId,
          });
          await jobsRepo.enqueueJob(trx, {
            tenantId: ctx.tenantId,
            type: DELIVER_JOB,
            dedupeKey: deliveryId,
            payload: { deliveryId },
            traceId: ctx.traceId ?? undefined,
            maxAttempts: DELIVERY_MAX_ATTEMPTS,
          });
        }
      });
    },
  };
}

type Outcome =
  | { kind: "succeeded"; statusCode: number | null }
  | { kind: "retry"; code: string; statusCode: number | null; retryAfterMs?: number | undefined; ambiguous?: boolean }
  | { kind: "failed"; code: string; statusCode: number | null }
  /** Not sent, by design (no address given, or a sending limit); never retried. */
  | { kind: "skipped"; code: string };

/** The webhook body: version, identifiers, timestamp, and only the configured fields. */
export function webhookPayload(context: DeliveryContext, occurredAt: string): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const id of context.integration.fieldIds) {
    if (id in context.submission.answers) answers[id] = context.submission.answers[id];
  }
  return {
    version: "1",
    eventId: context.delivery.eventId,
    eventType: "submission.accepted",
    occurredAt,
    formId: context.delivery.formId,
    submissionId: context.delivery.submissionId,
    receivedAt: context.submission.receivedAt.toISOString(),
    answers,
  };
}

async function deliverWebhook(deps: DeliveryDeps, context: DeliveryContext, tenantId: string): Promise<Outcome> {
  const integration = context.integration;
  const secrets = [decryptSecret(integration.secretCiphertext!, deps.secretKey)];
  if (integration.previousSecretCiphertext && integration.previousSecretExpiresAt && integration.previousSecretExpiresAt > new Date()) {
    secrets.push(decryptSecret(integration.previousSecretCiphertext, deps.secretKey));
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify(webhookPayload(context, context.submission.receivedAt.toISOString())), "utf8");
  const result = await sendWebhook({
    url: integration.url!,
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": "Workeasy-Webhooks/1",
      "workeasy-event-id": context.delivery.eventId,
      "workeasy-delivery-id": context.delivery.id,
      "workeasy-tenant-id": tenantId,
      "workeasy-timestamp": String(timestamp),
      "workeasy-signature": signatureHeader(secrets, timestamp, body),
    },
    policy: deps.policy,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  if (result.kind === "error") {
    if (result.code === "destination_blocked") return { kind: "failed", code: result.code, statusCode: null };
    return { kind: "retry", code: result.code, statusCode: null, ambiguous: result.ambiguous };
  }
  const status = result.status;
  if (status >= 200 && status < 300) return { kind: "succeeded", statusCode: status };
  if (status >= 300 && status < 400) return { kind: "failed", code: "redirect_not_followed", statusCode: status };
  if (status === 408 || status === 429 || status >= 500) return { kind: "retry", code: `http_${status}`, statusCode: status, retryAfterMs: result.retryAfterMs };
  return { kind: "failed", code: `http_${status}`, statusCode: status };
}

async function deliverEmail(deps: DeliveryDeps, context: DeliveryContext, tenantId: string): Promise<Outcome> {
  if (!deps.mailer) return { kind: "failed", code: "email_not_configured", statusCode: null };
  const { delivery, integration, formName } = context;
  const link = new URL(`/o/${tenantId}/forms/${delivery.formId}/responses/${delivery.submissionId}`, deps.consolePublicUrl).toString();
  const result = await deps.mailer.send({
    to: integration.recipients ?? [],
    subject: `New response: ${headerSafe(formName, 150)}`,
    text: [
      `A new response to "${headerSafe(formName)}" was received at ${context.submission.receivedAt.toISOString()}.`,
      "",
      "View it in Workeasy (you need to sign in):",
      link,
      "",
      `You receive this because of the "${headerSafe(integration.name)}" notification on this form.`,
    ].join("\n"),
    messageId: `<${delivery.eventId}.${integration.id}@notifications.workeasy>`,
  });
  if (result.ok) return { kind: "succeeded", statusCode: null };
  return result.retryable
    ? { kind: "retry", code: result.code, statusCode: result.statusCode ?? null }
    : { kind: "failed", code: result.code, statusCode: result.statusCode ?? null };
}

/** Sending limits for confirmation emails (PAR-06). */
export const CONFIRMATION_LIMITS: ConfirmationLimits = { perRecipientPerDay: 5, perIntegrationPerHour: 500 };

/** The address a respondent gave, normalized, or undefined if there is none. */
export function confirmationRecipient(answer: unknown): string | undefined {
  if (typeof answer !== "string") return undefined;
  const address = answer.trim().toLowerCase();
  // The engine validated it; this only guards against stored data that is not an address at all.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && address.length <= 254 ? address : undefined;
}

/**
 * The respondent's confirmation: the owners' subject and message, to the
 * address the respondent gave, at most CONFIRMATION_LIMITS often. Nothing a
 * respondent typed, other than the address, goes into the message.
 */
async function deliverConfirmation(deps: DeliveryDeps, context: DeliveryContext, tenantId: string): Promise<Outcome> {
  if (!deps.mailer) return { kind: "failed", code: "email_not_configured", statusCode: null };
  const { delivery, integration, formName } = context;
  const to = confirmationRecipient(context.submission.answers[integration.recipientFieldId ?? ""]);
  if (!to) return { kind: "skipped", code: "no_recipient" };
  const hash = createHash("sha256").update(to, "utf8").digest();
  const claim = await withTenant(deps.workerDb, tenantId, (trx: Trx) => integrationsRepo.claimConfirmation(trx, delivery.id, integration.id, hash, CONFIRMATION_LIMITS));
  if (claim !== "ok") return { kind: "skipped", code: claim };
  const result = await deps.mailer.send({
    to: [to],
    subject: headerSafe(integration.subject ?? formName, 150),
    text: [
      integration.message ?? "",
      "",
      "--",
      `You receive this because this address was given in a response to "${headerSafe(formName)}" on ${context.submission.receivedAt.toISOString().slice(0, 10)}.`,
      "If that wasn't you, you can ignore this email.",
    ].join("\n"),
    messageId: `<${delivery.eventId}.${integration.id}@notifications.workeasy>`,
  });
  if (result.ok) return { kind: "succeeded", statusCode: null };
  return result.retryable
    ? { kind: "retry", code: result.code, statusCode: result.statusCode ?? null }
    : { kind: "failed", code: result.code, statusCode: result.statusCode ?? null };
}

/**
 * Sends one delivery. Every attempt is recorded in the delivery history.
 * Transient failures retry on the delivery schedule (or a bounded
 * Retry-After); permanent ones, and the last retry, fail the delivery and
 * dead-letter the job, which can be replayed with the same event ID.
 */
export function deliverJob(deps: DeliveryDeps): JobDefinition {
  return {
    leaseSeconds: 60,
    retryDelayMs: (attempt) => deliveryRetryDelayMs(attempt),
    async handle(ctx) {
      const deliveryId = String(ctx.payload.deliveryId);
      const inTenant = <T>(fn: (trx: Trx) => Promise<T>) => withTenant(deps.workerDb, ctx.tenantId, fn);
      const context = await inTenant((trx) => integrationsRepo.deliveryContext(trx, deliveryId));
      if (!context || context.delivery.status === "succeeded" || context.delivery.status === "skipped") return;
      const startedAt = new Date();
      const record = (a: Omit<AttemptRecord, "attempt" | "startedAt" | "durationMs">) =>
        inTenant((trx) => integrationsRepo.recordAttempt(trx, ctx.tenantId, deliveryId, { ...a, attempt: ctx.attempt, startedAt, durationMs: Date.now() - startedAt.getTime() }));
      const fields = { deliveryId, integrationId: context.integration.id, kind: context.integration.kind, attempt: ctx.attempt, tenantId: ctx.tenantId };

      // A response deleted (or purged) since, or an integration switched off, is not sent.
      const skip = context.submission.deleted ? "response_deleted" : context.integration.deleted || !context.integration.enabled ? "integration_disabled" : undefined;
      if (skip) {
        await record({ statusCode: null, errorCode: skip, outcome: "skipped" });
        return;
      }

      const outcome =
        context.integration.kind === "webhook"
          ? await deliverWebhook(deps, context, ctx.tenantId)
          : context.integration.kind === "confirmation"
            ? await deliverConfirmation(deps, context, ctx.tenantId)
            : await deliverEmail(deps, context, ctx.tenantId);
      if (outcome.kind === "skipped") {
        await record({ statusCode: null, errorCode: outcome.code, outcome: "skipped" });
        deps.log?.("info", "delivery skipped", { ...fields, reason: outcome.code });
        return;
      }
      if (outcome.kind === "succeeded") {
        await record({ statusCode: outcome.statusCode, errorCode: null, outcome: "succeeded" });
        deps.log?.("info", "delivery succeeded", fields);
        return;
      }
      if (outcome.kind === "retry" && ctx.attempt < ctx.maxAttempts) {
        const delayMs = outcome.retryAfterMs ?? deliveryRetryDelayMs(ctx.attempt);
        await record({ statusCode: outcome.statusCode, errorCode: outcome.code, outcome: "retry", ambiguous: outcome.ambiguous ?? false, nextAttemptAt: new Date(Date.now() + delayMs) });
        deps.log?.("warn", "delivery attempt failed; will retry", { ...fields, error: outcome.code });
        throw new RetryLaterError(outcome.code, delayMs);
      }
      await record({ statusCode: outcome.statusCode, errorCode: outcome.code, outcome: "failed", ambiguous: outcome.kind === "retry" && (outcome.ambiguous ?? false) });
      deps.log?.("error", "delivery failed", { ...fields, error: outcome.code });
      throw new PermanentJobError(outcome.code);
    },
  };
}
