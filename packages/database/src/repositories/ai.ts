import { sql, type Selectable, type Transaction } from "kysely";
import type { AiDecision, AiGenerationsTable, AiGenerationStatus, AiOperation, Database } from "../schema.js";

/**
 * AI generations (docs/03 §4). The API creates, reads, cancels and expires
 * them in the tenant context; the worker records progress and the outcome in
 * the same context. Nothing here writes the form's draft.
 */
type Trx = Transaction<Database>;

export interface AiGeneration {
  id: string;
  tenantId: string;
  formId: string;
  requestedBy: string;
  operation: AiOperation;
  baseRevision: number;
  baseDefinition: Record<string, unknown>;
  /** Present only while the generation is queued or running. */
  prompt: string | null;
  promptDigest: string;
  templateVersion: string;
  provider: string | null;
  model: string | null;
  status: AiGenerationStatus;
  proposal: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  failureCode: string | null;
  usage: { inputTokens: number; outputTokens: number };
  createdAt: Date;
  updatedAt: Date;
  deadlineAt: Date;
  finishedAt: Date | null;
  /** How a succeeded proposal was decided (AI-02); null until then. */
  decision: { kind: AiDecision; by: string; at: Date; appliedRevision: number | null } | null;
}

function toGeneration(r: Selectable<AiGenerationsTable>): AiGeneration {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    formId: r.form_id,
    requestedBy: r.requested_by,
    operation: r.operation,
    baseRevision: r.base_revision,
    baseDefinition: r.base_definition,
    prompt: r.prompt,
    promptDigest: r.prompt_digest,
    templateVersion: r.template_version,
    provider: r.provider,
    model: r.model,
    status: r.status,
    proposal: r.proposal,
    summary: r.summary,
    failureCode: r.failure_code,
    usage: { inputTokens: r.input_tokens, outputTokens: r.output_tokens },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deadlineAt: r.deadline_at,
    finishedAt: r.finished_at,
    decision: r.decision ? { kind: r.decision, by: r.decided_by!, at: r.decided_at!, appliedRevision: r.applied_revision } : null,
  };
}

const ACTIVE: AiGenerationStatus[] = ["queued", "running"];

/**
 * Serializes generation requests within a tenant for the rest of the
 * transaction, so the active-generation limits hold under concurrency.
 */
export async function lockTenantGenerations(trx: Trx, tenantId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai_generations:${tenantId}`}, 0))`.execute(trx);
}

/**
 * Fails active generations past their deadline (a worker that died, or a
 * backlog) and releases their reservations; returns how many. `id` limits
 * it to one generation.
 */
export async function expireOverdue(trx: Trx, id?: string): Promise<number> {
  let q = trx
    .updateTable("ai_generations")
    .set({ status: "failed", failure_code: "deadline_exceeded", prompt: null, finished_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where("status", "in", ACTIVE)
    .where("deadline_at", "<", sql<Date>`now()`);
  if (id) q = q.where("id", "=", id);
  const expired = await q.returning("id").execute();
  for (const row of expired) await settleGeneration(trx, row.id);
  return expired.length;
}

// Opt-in and budgets (AI-03) -----------------------------------------------------

export interface AiSettings {
  enabled: boolean;
  dailyTokenLimit: number;
}

export const DEFAULT_AI_SETTINGS: AiSettings = { enabled: false, dailyTokenLimit: 200_000 };

/** The organization's AI settings; AI is off until someone turns it on. */
export async function getSettings(trx: Trx): Promise<AiSettings> {
  const row = await trx.selectFrom("ai_settings").select(["enabled", "daily_token_limit"]).executeTakeFirst();
  return row ? { enabled: row.enabled, dailyTokenLimit: row.daily_token_limit } : DEFAULT_AI_SETTINGS;
}

export async function saveSettings(trx: Trx, tenantId: string, settings: AiSettings, userId: string): Promise<AiSettings> {
  const values = { enabled: settings.enabled, daily_token_limit: settings.dailyTokenLimit, updated_by: userId, updated_at: sql<Date>`now()` };
  const row = await trx
    .insertInto("ai_settings")
    .values({ tenant_id: tenantId, ...values })
    .onConflict((oc) => oc.column("tenant_id").doUpdateSet(values))
    .returning(["enabled", "daily_token_limit"])
    .executeTakeFirstOrThrow();
  return { enabled: row.enabled, dailyTokenLimit: row.daily_token_limit };
}

/** Budget days are UTC dates; a generation counts against the day it was requested. */
const TODAY = sql<string>`(now() AT TIME ZONE 'UTC')::date`;

export async function usageToday(trx: Trx): Promise<{ used: number; reserved: number }> {
  const row = await trx.selectFrom("ai_usage_days").select(["used_tokens", "reserved_tokens"]).where("day", "=", TODAY).executeTakeFirst();
  return { used: Number(row?.used_tokens ?? 0), reserved: Number(row?.reserved_tokens ?? 0) };
}

/**
 * Reserves tokens against today's limit; returns false if they do not fit.
 * One conditional upsert: concurrent reservations queue on the day's row
 * and each sees the others' tokens, so together they never pass the limit.
 */
export async function reserveTokens(trx: Trx, tenantId: string, tokens: number, limit: number): Promise<boolean> {
  const { rows } = await sql<{ ok: number }>`
    INSERT INTO app.ai_usage_days AS d (tenant_id, day, reserved_tokens)
    SELECT ${tenantId}::uuid, ${TODAY}, ${tokens}::bigint WHERE ${tokens}::bigint <= ${limit}::bigint
    ON CONFLICT (tenant_id, day) DO UPDATE SET reserved_tokens = d.reserved_tokens + EXCLUDED.reserved_tokens
      WHERE d.used_tokens + d.reserved_tokens + EXCLUDED.reserved_tokens <= ${limit}::bigint
    RETURNING 1 AS ok`.execute(trx);
  return rows.length === 1;
}

/** Adds tokens the provider reported to the generation's budget day. */
async function chargeDay(trx: Trx, id: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  await sql`
    UPDATE app.ai_usage_days d SET used_tokens = d.used_tokens + ${tokens}::bigint
      FROM app.ai_generations g
     WHERE g.id = ${id}::uuid AND d.tenant_id = g.tenant_id AND d.day = (g.created_at AT TIME ZONE 'UTC')::date`.execute(trx);
}

/**
 * Releases what a finished generation still holds against its day, once.
 * Its actual use was charged as it was reported.
 */
export async function settleGeneration(trx: Trx, id: string): Promise<void> {
  const { rows } = await sql<{ reserved: number; tenant_id: string; day: string }>`
    UPDATE app.ai_generations g SET reserved_tokens = 0
      FROM (SELECT id, reserved_tokens FROM app.ai_generations
             WHERE id = ${id}::uuid AND reserved_tokens > 0 AND status NOT IN ('queued', 'running') FOR UPDATE) old
     WHERE g.id = old.id
    RETURNING old.reserved_tokens AS reserved, g.tenant_id, (g.created_at AT TIME ZONE 'UTC')::date::text AS day`.execute(trx);
  const released = rows[0];
  if (!released) return;
  await sql`
    UPDATE app.ai_usage_days SET reserved_tokens = greatest(reserved_tokens - ${released.reserved}::bigint, 0)
     WHERE tenant_id = ${released.tenant_id}::uuid AND day = ${released.day}::date`.execute(trx);
}

/** Active generations in the tenant, and those of one user. */
export async function countActive(trx: Trx, userId: string): Promise<{ tenant: number; user: number }> {
  const row = await trx
    .selectFrom("ai_generations")
    .select([sql<number>`count(*)::int`.as("tenant"), sql<number>`(count(*) filter (where requested_by = ${userId}))::int`.as("user")])
    .where("status", "in", ACTIVE)
    .executeTakeFirstOrThrow();
  return row;
}

export interface NewGeneration {
  tenantId: string;
  formId: string;
  requestedBy: string;
  operation: AiOperation;
  baseRevision: number;
  baseDefinition: Record<string, unknown>;
  prompt: string;
  promptDigest: string;
  templateVersion: string;
  deadlineSeconds: number;
  /** Already reserved against today's budget (reserveTokens). */
  reservedTokens: number;
}

export async function createGeneration(trx: Trx, input: NewGeneration): Promise<AiGeneration> {
  const row = await trx
    .insertInto("ai_generations")
    .values({
      tenant_id: input.tenantId,
      form_id: input.formId,
      requested_by: input.requestedBy,
      operation: input.operation,
      base_revision: input.baseRevision,
      base_definition: input.baseDefinition,
      prompt: input.prompt,
      prompt_digest: input.promptDigest,
      template_version: input.templateVersion,
      reserved_tokens: input.reservedTokens,
      deadline_at: sql<Date>`now() + make_interval(secs => ${input.deadlineSeconds})`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toGeneration(row);
}

export async function getGeneration(trx: Trx, id: string): Promise<AiGeneration | undefined> {
  const row = await trx.selectFrom("ai_generations").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? toGeneration(row) : undefined;
}

/**
 * Cancels a queued or running generation; returns it, or undefined if it had
 * already ended. A queued one is settled now; a running one is settled by
 * its worker, which may still report use.
 */
export async function cancelGeneration(trx: Trx, id: string): Promise<AiGeneration | undefined> {
  const before = await trx.selectFrom("ai_generations").select("status").where("id", "=", id).forUpdate().executeTakeFirst();
  const row = await trx
    .updateTable("ai_generations")
    .set({ status: "cancelled", prompt: null, finished_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("status", "in", ACTIVE)
    .returningAll()
    .executeTakeFirst();
  if (!row) return undefined;
  if (before?.status === "queued") {
    await settleGeneration(trx, id);
    return toGeneration({ ...row, reserved_tokens: 0 });
  }
  return toGeneration(row);
}

/** Locks a generation for the rest of the transaction (deciding a proposal). */
export async function lockGeneration(trx: Trx, id: string): Promise<AiGeneration | undefined> {
  const row = await trx.selectFrom("ai_generations").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  return row ? toGeneration(row) : undefined;
}

/**
 * Records the decision on a succeeded, undecided proposal; returns the
 * generation, or undefined if it was not open for a decision.
 */
export async function decideGeneration(
  trx: Trx,
  id: string,
  decision: { kind: "applied"; revision: number } | { kind: "rejected" },
  userId: string,
): Promise<AiGeneration | undefined> {
  const row = await trx
    .updateTable("ai_generations")
    .set({
      decision: decision.kind,
      decided_by: userId,
      decided_at: sql<Date>`now()`,
      applied_revision: decision.kind === "applied" ? decision.revision : null,
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", id)
    .where("status", "=", "succeeded")
    .where("decision", "is", null)
    .returningAll()
    .executeTakeFirst();
  return row ? toGeneration(row) : undefined;
}

// Worker ------------------------------------------------------------------------

/** Marks a queued generation running; returns it if it is still active and in time. */
export async function startGeneration(trx: Trx, id: string, provider: { name: string; model: string }): Promise<AiGeneration | undefined> {
  const row = await trx
    .updateTable("ai_generations")
    .set({ status: "running", provider: provider.name, model: provider.model, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("status", "in", ACTIVE)
    .where("deadline_at", ">", sql<Date>`now()`)
    .returningAll()
    .executeTakeFirst();
  return row ? toGeneration(row) : undefined;
}

export type GenerationOutcome =
  | { status: "succeeded"; proposal: Record<string, unknown>; summary: Record<string, unknown> }
  | { status: "failed"; failureCode: string; summary?: Record<string, unknown> };

/**
 * Records the outcome if the generation is still running (a cancellation in
 * the meantime wins); adds the usage either way. Returns whether it applied.
 */
export async function finishGeneration(
  trx: Trx,
  id: string,
  outcome: GenerationOutcome,
  usage: { inputTokens: number; outputTokens: number },
): Promise<boolean> {
  const tokens = {
    input_tokens: sql<number>`input_tokens + ${usage.inputTokens}`,
    output_tokens: sql<number>`output_tokens + ${usage.outputTokens}`,
    updated_at: sql<Date>`now()`,
  };
  const result = await trx
    .updateTable("ai_generations")
    .set({
      ...tokens,
      status: outcome.status,
      proposal: outcome.status === "succeeded" ? outcome.proposal : null,
      summary: outcome.summary ?? null,
      failure_code: outcome.status === "failed" ? outcome.failureCode : null,
      prompt: null,
      finished_at: sql<Date>`now()`,
    })
    .where("id", "=", id)
    .where("status", "=", "running")
    .executeTakeFirst();
  await chargeDay(trx, id, usage.inputTokens + usage.outputTokens);
  if (Number(result.numUpdatedRows) === 1) return true;
  // Cancelled or expired meanwhile: the outcome is dropped, the spend is still recorded.
  await trx.updateTable("ai_generations").set(tokens).where("id", "=", id).execute();
  return false;
}

/** Adds the usage of an attempt that will be retried. */
export async function addUsage(trx: Trx, id: string, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
  await trx
    .updateTable("ai_generations")
    .set({
      input_tokens: sql<number>`input_tokens + ${usage.inputTokens}`,
      output_tokens: sql<number>`output_tokens + ${usage.outputTokens}`,
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", id)
    .execute();
  await chargeDay(trx, id, usage.inputTokens + usage.outputTokens);
}
