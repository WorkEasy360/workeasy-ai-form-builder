import { sql, type Transaction } from "kysely";
import type { Database } from "../schema.js";

/**
 * Basic form analytics (ANA-01), aggregated from respondent sessions only:
 * no answers are read and nothing about a respondent is stored or returned.
 * Every count is grouped by the UTC day the session was opened.
 */
type Trx = Transaction<Database>;

export interface AnalyticsDay {
  /** YYYY-MM-DD, UTC. */
  day: string;
  views: number;
  starts: number;
  accepts: number;
}

/** Records the first change in a session; later calls change nothing. */
export async function markStarted(trx: Trx, sessionId: string): Promise<void> {
  await trx
    .updateTable("respondent_sessions")
    .set({ started_at: sql<Date>`now()` })
    .where("id", "=", sessionId)
    .where("started_at", "is", null)
    .execute();
}

/** Daily views, starts and accepts for a form between two UTC dates, inclusive; days without sessions are omitted. */
export async function formDays(trx: Trx, formId: string, from: string, to: string): Promise<AnalyticsDay[]> {
  const day = sql<string>`((created_at AT TIME ZONE 'UTC')::date)::text`;
  const rows = await trx
    .selectFrom("respondent_sessions")
    .select([
      day.as("day"),
      sql<number>`count(*)::int`.as("views"),
      sql<number>`(count(*) filter (where started_at is not null or accepted_submission_id is not null))::int`.as("starts"),
      sql<number>`(count(*) filter (where accepted_submission_id is not null))::int`.as("accepts"),
    ])
    .where("form_id", "=", formId)
    .where("created_at", ">=", sql<Date>`(${from}::date)::timestamp AT TIME ZONE 'UTC'`)
    .where("created_at", "<", sql<Date>`((${to}::date + 1))::timestamp AT TIME ZONE 'UTC'`)
    .groupBy(day)
    .orderBy(day)
    .execute();
  return rows;
}
