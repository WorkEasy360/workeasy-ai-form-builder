-- JOB-01: outbox dispatch and durable jobs (docs/04 §6, ADR-008).
--
-- The dispatcher claims committed outbox events, inserts one job per
-- subscribed job type and marks the events dispatched, all in one
-- transaction. A job's (tenant, type, dedupe key) is unique, and event-derived
-- jobs use the event ID as the key, so dispatching an event twice never makes
-- a second job. Workers claim jobs under a lease and a fresh lease token, do
-- the work outside any transaction, then complete with compare-and-set on the
-- token: a worker whose lease ran out and was reclaimed cannot overwrite the
-- newer attempt. Abandoned leases are reclaimed; failures retry with backoff
-- until max_attempts, then the job is dead-lettered for an operator to replay.
-- Execution is at least once, so handlers pass the dedupe key to destinations.

CREATE TABLE app.jobs (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES app.tenants (id),
  type            text NOT NULL CHECK (type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*$' AND char_length(type) <= 100),
  -- The outbox event it came from; NULL for jobs enqueued directly.
  source_event_id uuid,
  -- Stable across retries and replays; destinations deduplicate on it.
  dedupe_key      text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  -- References to protected records only, like outbox payloads.
  payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  trace_id        text CHECK (char_length(trace_id) <= 100),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempt         integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts    integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 1000),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  lease_token     uuid,
  -- A sanitized code, never an error message (messages can carry answers).
  last_error      text CHECK (last_error ~ '^[a-z][a-z0-9_]*$' AND char_length(last_error) <= 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  PRIMARY KEY (id),
  CONSTRAINT jobs_dedupe UNIQUE (tenant_id, type, dedupe_key),
  CONSTRAINT jobs_lease CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT jobs_finished CHECK ((status IN ('succeeded', 'dead')) = (finished_at IS NOT NULL))
);

CREATE INDEX jobs_ready_idx ON app.jobs (next_attempt_at, id) WHERE status = 'queued';
CREATE INDEX jobs_leased_idx ON app.jobs (lease_until) WHERE status = 'running';
CREATE INDEX jobs_tenant_recent_idx ON app.jobs (tenant_id, created_at DESC, id DESC);

ALTER TABLE app.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The functions below run as the owner across tenants, like the other queues.
CREATE POLICY job_queue ON app.jobs FOR ALL TO workeasy_owner USING (true) WITH CHECK (true);
CREATE POLICY dispatch_queue ON app.outbox_events FOR ALL TO workeasy_owner USING (true) WITH CHECK (true);

-- Functions ------------------------------------------------------------------
-- p_routes maps event types to the job types subscribed to them, e.g.
-- {"submission.accepted.v1": ["notifications.email"]}; it comes from the
-- worker's handler registry. Events nobody subscribes to are marked
-- dispatched with no jobs. p_tenant_id limits a run to one tenant.

CREATE FUNCTION app.dispatch_outbox(p_routes jsonb, p_limit integer, p_tenant_id uuid DEFAULT NULL)
  RETURNS TABLE (events integer, jobs integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    WITH ev AS (
      SELECT o.* FROM app.outbox_events o
       WHERE o.dispatched_at IS NULL AND (p_tenant_id IS NULL OR o.tenant_id = p_tenant_id)
       ORDER BY o.occurred_at, o.id
       LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    ),
    ins AS (
      INSERT INTO app.jobs (tenant_id, type, source_event_id, dedupe_key, payload, trace_id)
      SELECT ev.tenant_id, t.type, ev.id, ev.id::text,
             jsonb_strip_nulls(jsonb_build_object(
               'eventId', ev.id, 'eventType', ev.event_type, 'occurredAt', ev.occurred_at,
               'tenantId', ev.tenant_id, 'aggregateId', ev.aggregate_id, 'traceId', ev.trace_id, 'data', ev.payload)),
             ev.trace_id
        FROM ev
        CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(p_routes -> ev.event_type, '[]'::jsonb)) AS t(type)
      ON CONFLICT ON CONSTRAINT jobs_dedupe DO NOTHING
      RETURNING 1
    ),
    upd AS (
      UPDATE app.outbox_events o SET dispatched_at = now() FROM ev WHERE o.id = ev.id RETURNING 1
    )
    SELECT (SELECT count(*) FROM upd)::integer, (SELECT count(*) FROM ins)::integer
  $$;

-- Claims due jobs of the given types: queued ones whose time has come, and
-- running ones whose lease ran out (their worker is presumed dead). Each claim
-- counts an attempt and gets a new lease token. Abandoned jobs that already
-- used their last attempt are dead-lettered instead.
CREATE FUNCTION app.claim_jobs(p_types text[], p_limit integer, p_lease_seconds integer, p_tenant_id uuid DEFAULT NULL)
  RETURNS SETOF app.jobs
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
  BEGIN
    UPDATE app.jobs j
       SET status = 'dead', lease_token = NULL, lease_until = NULL, last_error = 'lease_expired',
           finished_at = now(), updated_at = now()
     WHERE j.status = 'running' AND j.lease_until < now() AND j.attempt >= j.max_attempts
       AND j.type = ANY (p_types) AND (p_tenant_id IS NULL OR j.tenant_id = p_tenant_id);

    RETURN QUERY
    WITH next AS (
      SELECT j.id FROM app.jobs j
       WHERE j.type = ANY (p_types) AND (p_tenant_id IS NULL OR j.tenant_id = p_tenant_id)
         AND ((j.status = 'queued' AND j.next_attempt_at <= now()) OR (j.status = 'running' AND j.lease_until < now()))
       ORDER BY j.next_attempt_at, j.id
       LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    )
    UPDATE app.jobs j
       SET status = 'running', attempt = j.attempt + 1, lease_token = gen_random_uuid(),
           lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
      FROM next WHERE j.id = next.id
    RETURNING j.*;
  END
  $$;

-- Records an attempt's outcome if the caller still holds the lease; returns
-- the job's new status, or NULL when the lease was lost to a newer attempt.
-- 'retry' requeues at p_retry_at while attempts remain; 'failed' (permanent)
-- and a retry past the last attempt dead-letter the job.
CREATE FUNCTION app.complete_job(p_job_id uuid, p_lease_token uuid, p_outcome text, p_error text, p_retry_at timestamptz)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
  DECLARE
    v_status text;
  BEGIN
    IF p_outcome NOT IN ('succeeded', 'retry', 'failed') THEN
      RAISE EXCEPTION 'unknown job outcome %', p_outcome USING ERRCODE = '22023';
    END IF;
    UPDATE app.jobs j
       SET status = CASE
             WHEN p_outcome = 'succeeded' THEN 'succeeded'
             WHEN p_outcome = 'retry' AND j.attempt < j.max_attempts THEN 'queued'
             ELSE 'dead' END,
           next_attempt_at = CASE WHEN p_outcome = 'retry' AND j.attempt < j.max_attempts THEN p_retry_at ELSE j.next_attempt_at END,
           last_error = CASE WHEN p_outcome = 'succeeded' THEN NULL ELSE p_error END,
           finished_at = CASE WHEN p_outcome = 'retry' AND j.attempt < j.max_attempts THEN NULL ELSE now() END,
           lease_token = NULL, lease_until = NULL, updated_at = now()
     WHERE j.id = p_job_id AND j.status = 'running' AND j.lease_token = p_lease_token
    RETURNING j.status INTO v_status;
    RETURN v_status;
  END
  $$;

REVOKE ALL ON FUNCTION app.dispatch_outbox(jsonb, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_jobs(text[], integer, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_job(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dispatch_outbox(jsonb, integer, uuid), app.claim_jobs(text[], integer, integer, uuid),
  app.complete_job(uuid, uuid, text, text, timestamptz) TO workeasy_worker;

-- Privileges -------------------------------------------------------------------
-- The API enqueues jobs directly (AI generation, for instance), lists them for
-- owners and admins, and replays dead ones; it never claims or completes them.
-- Workers read jobs in their tenant context and change them only through the
-- functions above.
GRANT SELECT, INSERT ON app.jobs TO workeasy_api;
GRANT UPDATE (status, max_attempts, next_attempt_at, last_error, finished_at, updated_at) ON app.jobs TO workeasy_api;
GRANT SELECT ON app.jobs TO workeasy_worker;
