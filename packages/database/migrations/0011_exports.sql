-- RES-02: CSV exports of responses (docs/04 §7, docs/05 §2, docs/06 §2).
--
-- An export records what was asked for when it was requested: the filters,
-- a cutoff (so the file matches the listing the requester saw) and the field
-- classes the requester could read. The worker builds the file in the
-- exports bucket after checking the requester's access again; downloads
-- check it a third time. Losing access at any point stops the export or its
-- download. Files expire 24 hours after they are ready.

CREATE TABLE app.exports (
  id               uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  form_id          uuid NOT NULL,
  requested_by     uuid NOT NULL,
  -- Version, received window and answer filter, as in the response list.
  filter_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filter_snapshot) = 'object' AND octet_length(filter_snapshot::text) <= 4096),
  cutoff           timestamptz NOT NULL,
  -- Field classes the requester could read when asking; the file holds no others.
  readable_classes text[] NOT NULL CHECK (readable_classes <@ ARRAY['ordinary', 'personal', 'sensitive']),
  -- Canonical values without spreadsheet escaping, for machines (docs/04 §7).
  raw              boolean NOT NULL DEFAULT false,
  state            text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
  failure_code     text CHECK (failure_code IN ('access_revoked', 'form_unavailable', 'error')),
  row_count        integer CHECK (row_count >= 0),
  bytes            integer CHECK (bytes >= 0),
  attempts         integer NOT NULL DEFAULT 0,
  lease_until      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  expires_at       timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, form_id) REFERENCES app.forms (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app.memberships (tenant_id, user_id),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);

CREATE INDEX exports_requester_idx ON app.exports (tenant_id, form_id, requested_by, created_at DESC);
CREATE INDEX exports_queue_idx ON app.exports (created_at) WHERE state IN ('queued', 'running');
CREATE INDEX exports_expiry_idx ON app.exports (expires_at) WHERE state = 'succeeded';

CREATE TRIGGER exports_set_updated_at BEFORE UPDATE ON app.exports
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.exports
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- The export queue spans tenants; only the owner functions below use this.
CREATE POLICY export_queue ON app.exports FOR ALL TO workeasy_owner USING (true) WITH CHECK (true);

-- Leases up to p_limit waiting exports (or ones whose lease ran out), oldest
-- first. The attempt number is the lease token for finish_export.
CREATE FUNCTION app.claim_export_jobs(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (export_id uuid, tenant_id uuid, form_id uuid, requested_by uuid, filter_snapshot jsonb, cutoff timestamptz,
                 readable_classes text[], raw boolean, attempt integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    WITH next AS (
      SELECT e.id FROM app.exports e
       WHERE e.state = 'queued' OR (e.state = 'running' AND e.lease_until < now())
       ORDER BY e.created_at
       LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    )
    UPDATE app.exports e
       SET state = 'running', lease_until = now() + make_interval(secs => p_lease_seconds), attempts = e.attempts + 1
      FROM next WHERE e.id = next.id
    RETURNING e.id, e.tenant_id, e.form_id, e.requested_by, e.filter_snapshot, e.cutoff, e.readable_classes, e.raw, e.attempts
  $$;

-- Records the outcome if the caller still holds the lease: 'succeeded' with
-- the row count and size, 'failed' with a code, or 'retry' to queue it again.
CREATE FUNCTION app.finish_export(p_export_id uuid, p_attempt integer, p_outcome text, p_rows integer, p_bytes integer, p_failure text) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    UPDATE app.exports
       SET state = CASE p_outcome WHEN 'retry' THEN 'queued' ELSE p_outcome END,
           row_count = CASE WHEN p_outcome = 'succeeded' THEN p_rows END,
           bytes = CASE WHEN p_outcome = 'succeeded' THEN p_bytes END,
           failure_code = CASE WHEN p_outcome = 'failed' THEN p_failure END,
           completed_at = CASE WHEN p_outcome IN ('succeeded', 'failed') THEN now() END,
           expires_at = CASE WHEN p_outcome = 'succeeded' THEN now() + interval '24 hours' END,
           lease_until = NULL
     WHERE id = p_export_id AND state = 'running' AND attempts = p_attempt
       AND p_outcome IN ('succeeded', 'failed', 'retry')
    RETURNING true
  $$;

-- Marks finished exports past their expiry as expired; returns their IDs so
-- the worker can delete the files (the object key is the export ID).
CREATE FUNCTION app.expire_exports(p_limit integer) RETURNS TABLE (export_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    WITH due AS (
      SELECT e.id FROM app.exports e
       WHERE e.state = 'succeeded' AND e.expires_at <= now()
       ORDER BY e.expires_at
       LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    )
    UPDATE app.exports e SET state = 'expired' FROM due WHERE e.id = due.id
    RETURNING e.id
  $$;

REVOKE ALL ON FUNCTION app.claim_export_jobs(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.finish_export(uuid, integer, text, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.expire_exports(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_export_jobs(integer, integer), app.finish_export(uuid, integer, text, integer, integer, text),
  app.expire_exports(integer) TO workeasy_worker;

-- The API requests and reads exports; the worker reads them and records
-- results only through the functions above.
GRANT SELECT, INSERT ON app.exports TO workeasy_api;
GRANT SELECT ON app.exports TO workeasy_worker;
