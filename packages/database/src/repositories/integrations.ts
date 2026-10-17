import { sql, type Selectable, type Transaction } from "kysely";
import type { AttemptOutcome, Database, DeliveriesTable, DeliveryStatus, IntegrationKind, IntegrationsTable } from "../schema.js";

/**
 * Integrations and their delivery history (docs/05 §6). The API manages
 * integrations and reads deliveries; the worker creates deliveries from
 * accepted responses and records attempts. All in the tenant context.
 */
type Trx = Transaction<Database>;

export interface Integration {
  id: string;
  formId: string;
  kind: IntegrationKind;
  name: string;
  enabled: boolean;
  url: string | null;
  recipients: string[] | null;
  fieldIds: string[];
  /** Confirmation emails: the email question whose answer is the recipient, and the owners' text. */
  recipientFieldId: string | null;
  subject: string | null;
  message: string | null;
  /** When the previous signing secret stops being sent, after a rotation. */
  previousSecretExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An integration with its encrypted signing secrets, for the worker only. */
export interface IntegrationWithSecrets extends Integration {
  secretCiphertext: string | null;
  previousSecretCiphertext: string | null;
}

function toIntegration(r: Selectable<IntegrationsTable>): Integration {
  return {
    id: r.id,
    formId: r.form_id,
    kind: r.kind,
    name: r.name,
    enabled: r.enabled,
    url: r.url,
    recipients: r.recipients,
    fieldIds: r.field_ids,
    recipientFieldId: r.recipient_field_id,
    subject: r.subject,
    message: r.message,
    previousSecretExpiresAt: r.previous_secret_expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listIntegrations(trx: Trx, formId: string): Promise<Integration[]> {
  const rows = await trx.selectFrom("integrations").selectAll().where("form_id", "=", formId).where("deleted_at", "is", null).orderBy("created_at").execute();
  return rows.map(toIntegration);
}

export async function getIntegration(trx: Trx, id: string): Promise<Integration | undefined> {
  const row = await trx.selectFrom("integrations").selectAll().where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
  return row ? toIntegration(row) : undefined;
}

export type NewIntegration =
  | { kind: "webhook"; name: string; url: string; fieldIds: string[]; secretCiphertext: string }
  | { kind: "email"; name: string; recipients: string[] }
  | { kind: "confirmation"; name: string; recipientFieldId: string; subject: string; message: string };

export async function createIntegration(trx: Trx, tenantId: string, formId: string, userId: string, input: NewIntegration): Promise<Integration> {
  const row = await trx
    .insertInto("integrations")
    .values({
      tenant_id: tenantId,
      form_id: formId,
      kind: input.kind,
      name: input.name,
      url: input.kind === "webhook" ? input.url : null,
      recipients: input.kind === "email" ? input.recipients : null,
      field_ids: input.kind === "webhook" ? input.fieldIds : [],
      secret_ciphertext: input.kind === "webhook" ? input.secretCiphertext : null,
      recipient_field_id: input.kind === "confirmation" ? input.recipientFieldId : null,
      subject: input.kind === "confirmation" ? input.subject : null,
      message: input.kind === "confirmation" ? input.message : null,
      created_by: userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toIntegration(row);
}

export interface IntegrationPatch {
  name?: string | undefined;
  enabled?: boolean | undefined;
  url?: string | undefined;
  recipients?: string[] | undefined;
  fieldIds?: string[] | undefined;
  recipientFieldId?: string | undefined;
  subject?: string | undefined;
  message?: string | undefined;
}

export async function updateIntegration(trx: Trx, id: string, patch: IntegrationPatch): Promise<Integration | undefined> {
  const row = await trx
    .updateTable("integrations")
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.recipients !== undefined ? { recipients: patch.recipients } : {}),
      ...(patch.fieldIds !== undefined ? { field_ids: patch.fieldIds } : {}),
      ...(patch.recipientFieldId !== undefined ? { recipient_field_id: patch.recipientFieldId } : {}),
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.message !== undefined ? { message: patch.message } : {}),
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returningAll()
    .executeTakeFirst();
  return row ? toIntegration(row) : undefined;
}

/** Soft-deletes an integration; pending deliveries are then skipped. */
export async function deleteIntegration(trx: Trx, id: string): Promise<boolean> {
  const result = await trx
    .updateTable("integrations")
    .set({ deleted_at: sql<Date>`now()`, enabled: false, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

/**
 * Replaces a webhook's signing secret. The old one keeps being sent as a
 * second signature for `overlapSeconds`, so receivers can switch over.
 */
export async function rotateSecret(trx: Trx, id: string, secretCiphertext: string, overlapSeconds: number): Promise<Integration | undefined> {
  const row = await trx
    .updateTable("integrations")
    .set((eb) => ({
      previous_secret_ciphertext: eb.ref("secret_ciphertext"),
      previous_secret_expires_at: sql<Date>`now() + make_interval(secs => ${overlapSeconds})`,
      secret_ciphertext: secretCiphertext,
      updated_at: sql<Date>`now()`,
    }))
    .where("id", "=", id)
    .where("kind", "=", "webhook")
    .where("deleted_at", "is", null)
    .returningAll()
    .executeTakeFirst();
  return row ? toIntegration(row) : undefined;
}

// Deliveries ------------------------------------------------------------------

export interface Delivery {
  id: string;
  integrationId: string;
  formId: string;
  submissionId: string;
  eventId: string;
  status: DeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  ambiguous: boolean;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface DeliveryAttempt {
  attempt: number;
  startedAt: Date;
  durationMs: number;
  statusCode: number | null;
  errorCode: string | null;
  outcome: AttemptOutcome;
}

function toDelivery(r: Selectable<DeliveriesTable>): Delivery {
  return {
    id: r.id,
    integrationId: r.integration_id,
    formId: r.form_id,
    submissionId: r.submission_id,
    eventId: r.event_id,
    status: r.status,
    attempts: r.attempts,
    lastStatusCode: r.last_status_code,
    lastError: r.last_error,
    ambiguous: r.ambiguous,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

/** Newest first, keyset on (created_at, id). */
export async function listDeliveries(
  trx: Trx,
  integrationId: string,
  query: { limit: number; after?: { createdAt: string; id: string } | undefined; status?: DeliveryStatus | undefined },
): Promise<{ deliveries: Array<Delivery & { createdAtKey: string }>; more: boolean }> {
  let q = trx.selectFrom("deliveries").selectAll().select(sql<string>`created_at::text`.as("created_at_key")).where("integration_id", "=", integrationId);
  if (query.after) q = q.where(sql<boolean>`(created_at, id) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`);
  if (query.status) q = q.where("status", "=", query.status);
  const rows = await q.orderBy("created_at", "desc").orderBy("id", "desc").limit(query.limit + 1).execute();
  return { deliveries: rows.slice(0, query.limit).map((r) => ({ ...toDelivery(r), createdAtKey: r.created_at_key })), more: rows.length > query.limit };
}

export async function getDelivery(trx: Trx, id: string): Promise<(Delivery & { attemptLog: DeliveryAttempt[] }) | undefined> {
  const row = await trx.selectFrom("deliveries").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return undefined;
  const attempts = await trx.selectFrom("delivery_attempts").selectAll().where("delivery_id", "=", id).orderBy("attempt").execute();
  return {
    ...toDelivery(row),
    attemptLog: attempts.map((a) => ({
      attempt: a.attempt,
      startedAt: a.started_at,
      durationMs: a.duration_ms,
      statusCode: a.status_code,
      errorCode: a.error_code,
      outcome: a.outcome,
    })),
  };
}

/** Puts a failed delivery back in the queue (its job is replayed separately). */
export async function requeueDelivery(trx: Trx, id: string): Promise<Delivery | undefined> {
  const row = await trx
    .updateTable("deliveries")
    .set({ status: "pending", completed_at: null, next_attempt_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("status", "=", "failed")
    .returningAll()
    .executeTakeFirst();
  return row ? toDelivery(row) : undefined;
}

// Worker ------------------------------------------------------------------------

/** Enabled integrations of a form, with their encrypted secrets. */
export async function enabledIntegrations(trx: Trx, formId: string): Promise<IntegrationWithSecrets[]> {
  const rows = await trx
    .selectFrom("integrations")
    .selectAll()
    .where("form_id", "=", formId)
    .where("enabled", "=", true)
    .where("deleted_at", "is", null)
    .execute();
  return rows.map((r) => ({ ...toIntegration(r), secretCiphertext: r.secret_ciphertext, previousSecretCiphertext: r.previous_secret_ciphertext }));
}

/** Creates the delivery of an event to an integration once; returns its ID either way. */
export async function ensureDelivery(
  trx: Trx,
  input: { tenantId: string; integrationId: string; formId: string; submissionId: string; eventId: string },
): Promise<string> {
  const inserted = await trx
    .insertInto("deliveries")
    .values({ tenant_id: input.tenantId, integration_id: input.integrationId, form_id: input.formId, submission_id: input.submissionId, event_id: input.eventId })
    .onConflict((oc) => oc.constraint("deliveries_once").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return inserted.id;
  const existing = await trx
    .selectFrom("deliveries")
    .select("id")
    .where("integration_id", "=", input.integrationId)
    .where("event_id", "=", input.eventId)
    .executeTakeFirstOrThrow();
  return existing.id;
}

export interface DeliveryContext {
  delivery: Delivery;
  integration: IntegrationWithSecrets & { deleted: boolean; previousSecretExpiresAt: Date | null };
  formName: string;
  submission: { answers: Record<string, unknown>; receivedAt: Date; deleted: boolean };
}

/** Everything one delivery attempt needs, read in the tenant context. */
export async function deliveryContext(trx: Trx, deliveryId: string): Promise<DeliveryContext | undefined> {
  const row = await trx.selectFrom("deliveries").selectAll().where("id", "=", deliveryId).executeTakeFirst();
  if (!row) return undefined;
  const integration = await trx.selectFrom("integrations").selectAll().where("id", "=", row.integration_id).executeTakeFirstOrThrow();
  const form = await trx.selectFrom("forms").select("name").where("id", "=", row.form_id).executeTakeFirstOrThrow();
  const submission = await trx
    .selectFrom("submissions")
    .select(["answers", "received_at", "deleted_at"])
    .where("id", "=", row.submission_id)
    .executeTakeFirstOrThrow();
  return {
    delivery: toDelivery(row),
    integration: {
      ...toIntegration(integration),
      secretCiphertext: integration.secret_ciphertext,
      previousSecretCiphertext: integration.previous_secret_ciphertext,
      deleted: integration.deleted_at !== null,
    },
    formName: form.name,
    submission: { answers: submission.answers, receivedAt: submission.received_at, deleted: submission.deleted_at !== null },
  };
}

export interface ConfirmationLimits {
  /** Confirmations one address may receive in 24 hours, across the tenant. */
  perRecipientPerDay: number;
  /** Confirmations one integration may send in an hour. */
  perIntegrationPerHour: number;
}

/**
 * Claims the right to send a confirmation to `recipientHash`, or says which
 * limit stops it. Serialized per address with a transaction-scoped advisory
 * lock, and the claim (the hash on the delivery) commits with the check, so
 * concurrent workers cannot both slip under a limit. Earlier deliveries that
 * failed or were skipped do not count.
 */
export async function claimConfirmation(
  trx: Trx,
  deliveryId: string,
  integrationId: string,
  recipientHash: Buffer,
  limits: ConfirmationLimits,
): Promise<"ok" | "recipient_limit" | "hourly_limit"> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${recipientHash.toString("hex")}, 0))`.execute(trx);
  const counted = ["pending", "retrying", "succeeded"] as const;
  const recent = await trx
    .selectFrom("deliveries")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("recipient_hash", "=", recipientHash)
    .where("id", "!=", deliveryId)
    .where("status", "in", counted)
    .where("created_at", ">", sql<Date>`now() - interval '24 hours'`)
    .executeTakeFirstOrThrow();
  if (Number(recent.n) >= limits.perRecipientPerDay) return "recipient_limit";
  const hourly = await trx
    .selectFrom("deliveries")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("integration_id", "=", integrationId)
    .where("recipient_hash", "is not", null)
    .where("id", "!=", deliveryId)
    .where("status", "in", counted)
    .where("created_at", ">", sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirstOrThrow();
  if (Number(hourly.n) >= limits.perIntegrationPerHour) return "hourly_limit";
  await trx.updateTable("deliveries").set({ recipient_hash: recipientHash }).where("id", "=", deliveryId).execute();
  return "ok";
}

export interface AttemptRecord {
  attempt: number;
  startedAt: Date;
  durationMs: number;
  statusCode: number | null;
  errorCode: string | null;
  outcome: AttemptOutcome;
  ambiguous?: boolean;
  /** For "retry": when the next attempt is due. */
  nextAttemptAt?: Date | undefined;
}

/** Appends an attempt to the history and moves the delivery to its new state. */
export async function recordAttempt(trx: Trx, tenantId: string, deliveryId: string, a: AttemptRecord): Promise<void> {
  await trx
    .insertInto("delivery_attempts")
    .values({
      tenant_id: tenantId,
      delivery_id: deliveryId,
      attempt: a.attempt,
      started_at: a.startedAt,
      duration_ms: a.durationMs,
      status_code: a.statusCode,
      error_code: a.errorCode,
      outcome: a.outcome,
    })
    .onConflict((oc) => oc.columns(["delivery_id", "attempt"]).doNothing())
    .execute();
  const status: DeliveryStatus = a.outcome === "retry" ? "retrying" : a.outcome;
  await trx
    .updateTable("deliveries")
    .set((eb) => ({
      status,
      attempts: sql<number>`greatest(${eb.ref("attempts")}, ${a.attempt})`,
      last_status_code: a.statusCode,
      last_error: a.outcome === "succeeded" ? null : a.errorCode,
      ambiguous: a.ambiguous ? true : eb.ref("ambiguous"),
      next_attempt_at: a.outcome === "retry" ? (a.nextAttemptAt ?? null) : null,
      completed_at: a.outcome === "retry" ? null : sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    }))
    .where("id", "=", deliveryId)
    .execute();
}
