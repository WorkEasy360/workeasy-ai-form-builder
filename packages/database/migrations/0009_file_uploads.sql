-- FIL-01: respondent uploads, quarantine, scanning and claiming (docs/04 §3, docs/06 §3).
--
-- An upload belongs to one respondent session, and through it to one version
-- of one form in one tenant, and to one file field of that version. Its bytes
-- go straight to the quarantine bucket under an opaque key; the worker scans
-- them and promotes clean files to the clean bucket. A submission can claim a
-- clean upload of its own session exactly once. Unclaimed uploads expire
-- after 24 hours.
--
-- States: awaiting_upload -> pending_scan -> scanning -> clean | infected |
-- rejected; any unclaimed upload -> expired. Every transition happens in one
-- of the functions below, so no runtime role can mark a file clean directly.

CREATE TABLE app.file_uploads (
  id                    uuid NOT NULL,
  tenant_id             uuid NOT NULL,
  form_id               uuid NOT NULL,
  form_version_id       uuid NOT NULL,
  session_id            uuid NOT NULL,
  field_id              text NOT NULL CHECK (field_id ~ '^[A-Za-z][A-Za-z0-9_-]{1,79}$'),
  -- Display name only (sanitized); never used to build the storage key.
  file_name             text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  declared_type         text NOT NULL CHECK (char_length(declared_type) BETWEEN 3 AND 100),
  declared_bytes        integer NOT NULL CHECK (declared_bytes BETWEEN 1 AND 10485760),
  storage_key           text NOT NULL CHECK (storage_key ~ '^[0-9a-f-]{36}$'),
  state                 text NOT NULL DEFAULT 'awaiting_upload'
                        CHECK (state IN ('awaiting_upload', 'pending_scan', 'scanning', 'clean', 'infected', 'rejected', 'expired')),
  -- Set by the scan: the type found in the bytes, and why a file was refused.
  detected_type         text,
  rejection_reason      text CHECK (rejection_reason IN ('malware', 'type_mismatch', 'size_mismatch', 'too_large')),
  bytes                 integer CHECK (bytes BETWEEN 1 AND 10485760),
  scan_attempts         integer NOT NULL DEFAULT 0,
  lease_until           timestamptz,
  claimed_submission_id uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (storage_key),
  FOREIGN KEY (tenant_id, session_id, form_id, form_version_id)
    REFERENCES app.respondent_sessions (tenant_id, id, form_id, form_version_id),
  FOREIGN KEY (tenant_id, claimed_submission_id) REFERENCES app.submissions (tenant_id, id),
  CHECK (claimed_submission_id IS NULL OR state = 'clean')
);

CREATE INDEX file_uploads_session_idx ON app.file_uploads (tenant_id, session_id, field_id);
CREATE INDEX file_uploads_scan_queue_idx ON app.file_uploads (created_at) WHERE state IN ('pending_scan', 'scanning');
CREATE INDEX file_uploads_expiry_idx ON app.file_uploads (expires_at) WHERE claimed_submission_id IS NULL AND state <> 'expired';

CREATE TRIGGER file_uploads_set_updated_at BEFORE UPDATE ON app.file_uploads
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.file_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.file_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.file_uploads
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- The scan queue and expiry sweep span tenants; only the owner functions below use this.
CREATE POLICY upload_queue ON app.file_uploads FOR ALL TO workeasy_owner USING (true) WITH CHECK (true);

-- Respondent side (public role, in the session's tenant context) -------------------

-- The bytes arrived: awaiting_upload -> pending_scan, recording the stored size.
CREATE FUNCTION app.mark_upload_received(p_upload_id uuid, p_session_id uuid, p_bytes integer) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    UPDATE app.file_uploads
       SET state = 'pending_scan', bytes = p_bytes
     WHERE id = p_upload_id AND session_id = p_session_id
       AND tenant_id = app.current_tenant_id()
       AND state = 'awaiting_upload' AND expires_at > now()
    RETURNING true
  $$;

-- The declared size did not match what was stored.
CREATE FUNCTION app.reject_upload(p_upload_id uuid, p_session_id uuid, p_reason text) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    UPDATE app.file_uploads
       SET state = 'rejected', rejection_reason = p_reason
     WHERE id = p_upload_id AND session_id = p_session_id
       AND tenant_id = app.current_tenant_id()
       AND state = 'awaiting_upload'
    RETURNING true
  $$;

-- Claims clean, unclaimed uploads of this session for a submission, each for
-- the field it was uploaded to. All or nothing: if any upload is missing, of
-- another session or field, not clean, expired or already claimed, it raises
-- UPLOAD_NOT_CLAIMABLE and the whole intake transaction rolls back.
CREATE FUNCTION app.claim_uploads(p_session_id uuid, p_submission_id uuid, p_upload_ids uuid[], p_field_ids text[]) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
  DECLARE
    v_claimed integer;
  BEGIN
    IF cardinality(p_upload_ids) <> cardinality(p_field_ids) THEN
      RAISE EXCEPTION 'UPLOAD_NOT_CLAIMABLE' USING ERRCODE = 'P0001';
    END IF;
    UPDATE app.file_uploads u
       SET claimed_submission_id = p_submission_id
      FROM unnest(p_upload_ids, p_field_ids) AS wanted(id, field_id)
     WHERE u.id = wanted.id AND u.field_id = wanted.field_id
       AND u.session_id = p_session_id
       AND u.tenant_id = app.current_tenant_id()
       AND u.state = 'clean' AND u.claimed_submission_id IS NULL;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed <> cardinality(p_upload_ids) THEN
      RAISE EXCEPTION 'UPLOAD_NOT_CLAIMABLE' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_claimed;
  END;
  $$;

-- Worker side (no tenant context; the queue spans tenants) ---------------------------

-- Leases up to p_limit uploads waiting for a scan (or whose earlier lease ran
-- out), oldest first, skipping rows another worker holds. The returned
-- attempt number is the lease token for finish_scan.
CREATE FUNCTION app.claim_scan_jobs(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (upload_id uuid, tenant_id uuid, form_id uuid, form_version_id uuid, field_id text, storage_key text,
                 declared_type text, declared_bytes integer, attempt integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    WITH next AS (
      SELECT u.id FROM app.file_uploads u
       WHERE (u.state = 'pending_scan' OR (u.state = 'scanning' AND u.lease_until < now()))
         AND u.expires_at > now()
       ORDER BY u.created_at
       LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    )
    UPDATE app.file_uploads u
       SET state = 'scanning', lease_until = now() + make_interval(secs => p_lease_seconds), scan_attempts = u.scan_attempts + 1
      FROM next WHERE u.id = next.id
    RETURNING u.id, u.tenant_id, u.form_id, u.form_version_id, u.field_id, u.storage_key, u.declared_type, u.declared_bytes, u.scan_attempts
  $$;

-- Records a scan outcome if the caller still holds the lease ('clean',
-- 'infected', 'rejected' with a reason, or 'retry' to put it back in the queue).
CREATE FUNCTION app.finish_scan(p_upload_id uuid, p_attempt integer, p_outcome text, p_detected_type text, p_reason text) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    UPDATE app.file_uploads
       SET state = CASE p_outcome WHEN 'retry' THEN 'pending_scan' ELSE p_outcome END,
           detected_type = COALESCE(p_detected_type, detected_type),
           rejection_reason = CASE WHEN p_outcome IN ('infected', 'rejected') THEN p_reason END,
           lease_until = NULL
     WHERE id = p_upload_id AND state = 'scanning' AND scan_attempts = p_attempt
       AND p_outcome IN ('clean', 'infected', 'rejected', 'retry')
    RETURNING true
  $$;

-- Marks unclaimed uploads past their expiry as expired and returns their
-- keys, so the worker can delete the objects (docs/06 §3: 24 hours).
CREATE FUNCTION app.expire_uploads(p_limit integer)
  RETURNS TABLE (upload_id uuid, storage_key text, previous_state text)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    WITH due AS (
      SELECT u.id, u.state FROM app.file_uploads u
       WHERE u.claimed_submission_id IS NULL AND u.state <> 'expired' AND u.expires_at <= now()
       ORDER BY u.expires_at
       LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    )
    UPDATE app.file_uploads u SET state = 'expired', lease_until = NULL
      FROM due WHERE u.id = due.id
    RETURNING u.id, u.storage_key, due.state
  $$;

REVOKE ALL ON FUNCTION app.mark_upload_received(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reject_upload(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_uploads(uuid, uuid, uuid[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_scan_jobs(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.finish_scan(uuid, integer, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.expire_uploads(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mark_upload_received(uuid, uuid, integer), app.reject_upload(uuid, uuid, text),
  app.claim_uploads(uuid, uuid, uuid[], text[]) TO workeasy_public;
GRANT EXECUTE ON FUNCTION app.claim_scan_jobs(integer, integer), app.finish_scan(uuid, integer, text, text, text),
  app.expire_uploads(integer) TO workeasy_worker;

-- Privileges -------------------------------------------------------------------
-- The public role creates upload records and reads its own; it never changes
-- them directly. The API (console) reads them for authorized downloads.

GRANT SELECT, INSERT ON app.file_uploads TO workeasy_public;
GRANT SELECT ON app.file_uploads TO workeasy_api, workeasy_worker;
