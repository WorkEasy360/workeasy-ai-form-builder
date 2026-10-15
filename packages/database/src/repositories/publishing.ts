import { sql, type Transaction } from "kysely";
import type { AuditActorType, Database, FormState } from "../schema.js";

/**
 * Published versions, the active version pointer, audit entries and outbox
 * events (docs/02 §5). Every function takes a tenant-scoped transaction;
 * publishing and activation must run their steps in one transaction so the
 * version, pointer, audit entry and event commit together or not at all.
 */
type Trx = Transaction<Database>;

export interface VersionSummary {
  id: string;
  versionNumber: number;
  schemaVersion: string;
  draftRevision: number;
  contentHash: Buffer;
  publishedAt: Date;
  publishedBy: { id: string; displayName: string | null };
}

export interface FormVersion extends VersionSummary {
  definition: Record<string, unknown>;
  publicProjection: Record<string, unknown>;
}

/**
 * Locks the form row for the rest of the transaction and returns its state
 * and active version. Publishing and activation take this lock first, so
 * version numbers and pointer changes are serialized per form.
 */
export async function lockForm(trx: Trx, formId: string): Promise<{ state: FormState; activeVersionId: string | null } | undefined> {
  const row = await trx
    .selectFrom("forms")
    .select(["state", "active_version_id"])
    .where("id", "=", formId)
    .where("deleted_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
  return row ? { state: row.state, activeVersionId: row.active_version_id } : undefined;
}

function summaryQuery(trx: Trx) {
  return trx
    .selectFrom("form_versions as v")
    .leftJoin("users as u", "u.id", "v.published_by")
    .select([
      "v.id",
      "v.version_number",
      "v.schema_version",
      "v.draft_revision",
      "v.content_hash",
      "v.published_at",
      "v.published_by",
      "u.display_name",
    ]);
}

type SummaryRow = {
  id: string;
  version_number: number;
  schema_version: string;
  draft_revision: number;
  content_hash: Buffer;
  published_at: Date;
  published_by: string;
  display_name: string | null;
};

function toSummary(row: SummaryRow): VersionSummary {
  return {
    id: row.id,
    versionNumber: row.version_number,
    schemaVersion: row.schema_version,
    draftRevision: row.draft_revision,
    contentHash: row.content_hash,
    publishedAt: row.published_at,
    publishedBy: { id: row.published_by, displayName: row.display_name ?? null },
  };
}

/** Versions of a form, newest first. */
export async function listVersions(trx: Trx, formId: string, limit: number): Promise<VersionSummary[]> {
  const rows = await summaryQuery(trx).where("v.form_id", "=", formId).orderBy("v.version_number", "desc").limit(limit).execute();
  return rows.map(toSummary);
}

/** One version of a form, including its definition; undefined if it belongs to another form. */
export async function getVersion(trx: Trx, formId: string, versionId: string): Promise<FormVersion | undefined> {
  const row = await summaryQuery(trx)
    .select(["v.definition", "v.public_projection"])
    .where("v.form_id", "=", formId)
    .where("v.id", "=", versionId)
    .executeTakeFirst();
  return row ? { ...toSummary(row), definition: row.definition, publicProjection: row.public_projection } : undefined;
}

/** The version a retried publish request already created, found by its idempotency key hash. */
export async function versionByPublishKey(trx: Trx, formId: string, keyHash: Buffer): Promise<VersionSummary | undefined> {
  const row = await summaryQuery(trx).where("v.form_id", "=", formId).where("v.publish_key_hash", "=", keyHash).executeTakeFirst();
  return row ? toSummary(row) : undefined;
}

export interface NewVersionInput {
  tenantId: string;
  formId: string;
  schemaVersion: string;
  definition: Record<string, unknown>;
  publicProjection: Record<string, unknown>;
  contentHash: Buffer;
  draftRevision: number;
  publishKeyHash: Buffer;
  publishedBy: string;
  /** The state lockForm returned. */
  currentState: FormState;
}

/**
 * Inserts the next version and makes it active. A form in draft becomes
 * published; a closed form stays closed (reopening is a separate decision).
 * Call after lockForm in the same transaction.
 */
export async function insertActiveVersion(trx: Trx, input: NewVersionInput): Promise<{ version: VersionSummary; state: FormState }> {
  const inserted = await trx
    .insertInto("form_versions")
    .values({
      tenant_id: input.tenantId,
      form_id: input.formId,
      version_number: sql<number>`(SELECT coalesce(max(version_number), 0) + 1 FROM app.form_versions WHERE form_id = ${input.formId})`,
      schema_version: input.schemaVersion,
      definition: input.definition,
      public_projection: input.publicProjection,
      content_hash: input.contentHash,
      draft_revision: input.draftRevision,
      publish_key_hash: input.publishKeyHash,
      published_by: input.publishedBy,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const form = await trx
    .updateTable("forms")
    .set({ active_version_id: inserted.id, state: input.currentState === "draft" ? "published" : input.currentState })
    .where("id", "=", input.formId)
    .returning("state")
    .executeTakeFirstOrThrow();
  const version = await summaryQuery(trx).where("v.id", "=", inserted.id).executeTakeFirstOrThrow();
  return { version: toSummary(version), state: form.state };
}

/** Points the form at one of its existing versions. The composite foreign key rejects another form's version. */
export async function setActiveVersion(trx: Trx, formId: string, versionId: string): Promise<void> {
  await trx.updateTable("forms").set({ active_version_id: versionId }).where("id", "=", formId).execute();
}

export interface AuditInput {
  tenantId: string;
  actor: { type: "user"; id: string } | { type: Exclude<AuditActorType, "user"> };
  action: string;
  resourceType: string;
  resourceId: string;
  requestId?: string | undefined;
  /** Identifiers and counts only; never answers or definition content. */
  metadata?: Record<string, unknown>;
}

export async function appendAudit(trx: Trx, input: AuditInput): Promise<void> {
  await trx
    .insertInto("audit_events")
    .values({
      tenant_id: input.tenantId,
      actor_type: input.actor.type,
      actor_id: input.actor.type === "user" ? input.actor.id : null,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      request_id: input.requestId ?? null,
      metadata: input.metadata ?? {},
    })
    .execute();
}

export interface OutboxInput {
  id: string;
  tenantId: string;
  eventType: string;
  aggregateId: string;
  occurredAt: Date;
  /** The envelope's `data`: references to protected records only. */
  payload: Record<string, unknown>;
  traceId?: string | undefined;
}

export async function appendOutbox(trx: Trx, input: OutboxInput): Promise<void> {
  await trx
    .insertInto("outbox_events")
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      event_type: input.eventType,
      aggregate_id: input.aggregateId,
      payload: input.payload,
      trace_id: input.traceId ?? null,
      occurred_at: input.occurredAt,
    })
    .execute();
}
