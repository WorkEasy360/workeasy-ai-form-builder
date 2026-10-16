-- GOV-01: soft deletion, purge, retention and legal holds (docs/04 §7).
--
-- Deleting a response hides it at once (deleted_at). The worker then purges
-- it: answers and consents are cleared, idempotency receipts removed, its
-- files deleted from storage, and finished exports that could contain it
-- deleted too. The row stays as a tombstone holding only identifiers and
-- times, so a restored backup can replay deletions before serving traffic.
-- Responses older than their form's retention period are deleted and purged
-- the same way. A legal hold on a form blocks deletion, retention and purge.
-- Audit entries describe these actions with identifiers and counts, never
-- answers.

ALTER TABLE app.forms ADD COLUMN legal_hold boolean NOT NULL DEFAULT false;
ALTER TABLE app.forms ADD CONSTRAINT forms_retention_days_bounds CHECK (retention_days BETWEEN 1 AND 3650);

ALTER TABLE app.submissions
  ADD COLUMN deleted_by uuid,
  ADD COLUMN deletion_reason text CHECK (deletion_reason IS NULL OR char_length(deletion_reason) BETWEEN 1 AND 500),
  ADD COLUMN purged_at timestamptz,
  ADD COLUMN purge_lease_until timestamptz,
  ADD CONSTRAINT submissions_deleted_by_fkey FOREIGN KEY (tenant_id, deleted_by) REFERENCES app.memberships (tenant_id, user_id),
  ADD CONSTRAINT submissions_purge_after_delete CHECK (purged_at IS NULL OR deleted_at IS NOT NULL),
  -- A purged response keeps no content.
  ADD CONSTRAINT submissions_purged_is_empty CHECK (purged_at IS NULL OR (answers = '{}'::jsonb AND consents = '[]'::jsonb));

CREATE INDEX submissions_purge_queue_idx ON app.submissions (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX submissions_retention_idx ON app.submissions (tenant_id, form_id, received_at) WHERE deleted_at IS NULL;

ALTER TABLE app.file_uploads DROP CONSTRAINT file_uploads_state_check;
ALTER TABLE app.file_uploads ADD CONSTRAINT file_uploads_state_check
  CHECK (state IN ('awaiting_upload', 'pending_scan', 'scanning', 'clean', 'infected', 'rejected', 'expired', 'purged'));
-- A purged upload may still name the (purged) submission that claimed it.
ALTER TABLE app.file_uploads DROP CONSTRAINT file_uploads_check;
ALTER TABLE app.file_uploads ADD CONSTRAINT file_uploads_claim_state CHECK (claimed_submission_id IS NULL OR state IN ('clean', 'purged'));

ALTER TABLE app.exports DROP CONSTRAINT exports_state_check;
ALTER TABLE app.exports ADD CONSTRAINT exports_state_check CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'expired', 'purged'));

-- System actions (retention, purge) are audited by the owner functions below.
CREATE POLICY system_audit ON app.audit_events FOR INSERT TO workeasy_owner WITH CHECK (actor_type = 'system');

-- Purge ------------------------------------------------------------------------

-- Leases deleted, unpurged responses of forms without a legal hold, oldest
-- deletion first, skipping rows another worker holds.
CREATE FUNCTION app.claim_purges(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (submission_id uuid, tenant_id uuid, form_id uuid, received_at timestamptz)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    WITH next AS (
      SELECT s.id FROM app.submissions s
        JOIN app.forms f ON f.id = s.form_id
       WHERE s.deleted_at IS NOT NULL AND s.purged_at IS NULL
         AND (s.purge_lease_until IS NULL OR s.purge_lease_until < now())
         AND NOT f.legal_hold
       ORDER BY s.deleted_at
       LIMIT p_limit
         FOR UPDATE OF s SKIP LOCKED
    )
    UPDATE app.submissions s SET purge_lease_until = now() + make_interval(secs => p_lease_seconds)
      FROM next WHERE s.id = next.id
    RETURNING s.id, s.tenant_id, s.form_id, s.received_at
  $$;

-- After the worker has deleted the stored objects: clears the response's
-- content, removes its receipts, marks its uploads and the exports that could
-- contain it as purged, and audits the purge (counts only). Refuses held forms.
CREATE FUNCTION app.complete_purge(p_submission_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
  DECLARE
    v_sub   app.submissions%ROWTYPE;
    v_files integer;
    v_exports integer;
  BEGIN
    SELECT s.* INTO v_sub FROM app.submissions s JOIN app.forms f ON f.id = s.form_id
     WHERE s.id = p_submission_id AND s.deleted_at IS NOT NULL AND s.purged_at IS NULL AND NOT f.legal_hold
       FOR UPDATE OF s;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    UPDATE app.file_uploads SET state = 'purged', file_name = 'purged', detected_type = NULL
     WHERE claimed_submission_id = p_submission_id;
    GET DIAGNOSTICS v_files = ROW_COUNT;
    UPDATE app.exports SET state = 'purged', expires_at = NULL
     WHERE form_id = v_sub.form_id AND state = 'succeeded' AND cutoff >= v_sub.received_at;
    GET DIAGNOSTICS v_exports = ROW_COUNT;
    DELETE FROM app.submission_requests WHERE submission_id = p_submission_id;
    UPDATE app.submissions
       SET answers = '{}'::jsonb, consents = '[]'::jsonb, purged_at = now(), purge_lease_until = NULL
     WHERE id = p_submission_id;
    INSERT INTO app.audit_events (tenant_id, actor_type, action, resource_type, resource_id, metadata)
    VALUES (v_sub.tenant_id, 'system', 'response.purged', 'submission', p_submission_id,
            jsonb_build_object('formId', v_sub.form_id, 'files', v_files, 'exports', v_exports));
    RETURN true;
  END;
  $$;

-- Retention --------------------------------------------------------------------

-- Deletes (softly) up to p_limit responses older than their form's retention
-- period, on forms without a legal hold, and audits each form's batch. The
-- purge then removes their content like any other deletion.
CREATE FUNCTION app.apply_retention(p_limit integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
  DECLARE
    v_count integer;
  BEGIN
    WITH due AS (
      SELECT s.id, s.tenant_id, s.form_id FROM app.submissions s
        JOIN app.forms f ON f.id = s.form_id
       WHERE s.deleted_at IS NULL AND NOT f.legal_hold
         AND s.received_at < now() - make_interval(days => f.retention_days)
       ORDER BY s.received_at
       LIMIT p_limit
         FOR UPDATE OF s SKIP LOCKED
    ), deleted AS (
      UPDATE app.submissions s SET deleted_at = now(), deletion_reason = 'Retention period ended'
        FROM due WHERE s.id = due.id
      RETURNING s.tenant_id, s.form_id
    ), audited AS (
      INSERT INTO app.audit_events (tenant_id, actor_type, action, resource_type, resource_id, metadata)
      SELECT tenant_id, 'system', 'responses.retention_deleted', 'form', form_id, jsonb_build_object('count', count(*))
        FROM deleted GROUP BY tenant_id, form_id
      RETURNING 1
    )
    SELECT count(*) INTO v_count FROM deleted;
    RETURN v_count;
  END;
  $$;

REVOKE ALL ON FUNCTION app.claim_purges(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_purge(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_retention(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_purges(integer, integer), app.complete_purge(uuid), app.apply_retention(integer) TO workeasy_worker;

-- Privileges -------------------------------------------------------------------
-- The API marks responses deleted (never undeletes or purges them) and reads
-- the audit log for owners and admins.
GRANT UPDATE (deleted_at, deleted_by, deletion_reason) ON app.submissions TO workeasy_api;
GRANT SELECT ON app.audit_events TO workeasy_api;
