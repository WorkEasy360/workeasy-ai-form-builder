/**
 * @workeasy/events
 *
 * Versioned event envelopes (docs/05 §4). Events refer to protected records
 * by ID and never carry answers or definition content; consumers fetch what
 * they are allowed to see. A breaking change gets a new `.vN` type, and
 * consumers must ignore fields they do not know.
 *
 * PUB-01 defines the envelope and `form.published.v1`, written to the outbox
 * with each publication. Dispatching arrives with JOB-01.
 */

export interface EventEnvelope<Type extends string, Data extends object> {
  eventId: string;
  eventType: Type;
  /** ISO 8601 timestamp. */
  occurredAt: string;
  tenantId: string;
  aggregateId: string;
  traceId?: string;
  data: Data;
}

export interface FormPublishedData {
  formId: string;
  formVersionId: string;
  versionNumber: number;
}

export type FormPublishedV1 = EventEnvelope<"form.published.v1", FormPublishedData>;

export const FORM_PUBLISHED_V1 = "form.published.v1";

export function formPublishedV1(input: {
  eventId: string;
  occurredAt: Date;
  tenantId: string;
  traceId?: string | undefined;
  data: FormPublishedData;
}): FormPublishedV1 {
  return {
    eventId: input.eventId,
    eventType: FORM_PUBLISHED_V1,
    occurredAt: input.occurredAt.toISOString(),
    tenantId: input.tenantId,
    aggregateId: input.data.formId,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    data: input.data,
  };
}
