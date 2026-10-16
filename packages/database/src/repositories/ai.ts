import { sql, type Selectable, type Transaction } from "kysely";
import type { AiGenerationsTable, AiGenerationStatus, AiOperation, Database } from "../schema.js";

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
 * backlog); returns how many. `id` limits it to one generation.
 */
export async function expireOverdue(trx: Trx, id?: string): Promise<number> {
  let q = trx
    .updateTable("ai_generations")
    .set({ status: "failed", failure_code: "deadline_exceeded", prompt: null, finished_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where("status", "in", ACTIVE)
    .where("deadline_at", "<", sql<Date>`now()`);
  if (id) q = q.where("id", "=", id);
  const result = await q.executeTakeFirst();
  return Number(result.numUpdatedRows);
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

/** Cancels a queued or running generation; returns it, or undefined if it had already ended. */
export async function cancelGeneration(trx: Trx, id: string): Promise<AiGeneration | undefined> {
  const row = await trx
    .updateTable("ai_generations")
    .set({ status: "cancelled", prompt: null, finished_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("status", "in", ACTIVE)
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
}
