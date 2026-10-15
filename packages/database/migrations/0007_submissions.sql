-- RUN-02: the intake transaction (docs/04 §5).
--
-- A submission belongs to exactly one respondent session, and through it to
-- one version of one form in one tenant: the composite foreign key below
-- means a submission can never claim another session's form or version.
-- Each session accepts at most one submission. Idempotency records keep the
-- receipt returned for a request key, so a retry gets the same answer and
-- never creates a second response or event.

-- Target for the submission's (tenant, session, form, version) foreign key.
ALTER TABLE app.respondent_sessions ADD CONSTRAINT respondent_sessions_binding_key UNIQUE (tenant_id, id, form_id, form_version_id);

CREATE TABLE app.submissions (
  id              uuid NOT NULL,
  tenant_id       uuid NOT NULL,
  form_id         uuid NOT NULL,
  form_version_id uuid NOT NULL,
  session_id      uuid NOT NULL,
  -- Canonical answers from the engine: visible, reachable, valid, keyed by field ID.
  answers         jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object' AND octet_length(answers::text) <= 262144),
  -- Consent fields the respondent agreed to; the pinned version holds their wording.
  consents        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(consents) = 'array'),
  revision        integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  intake_state    text NOT NULL DEFAULT 'accepted' CHECK (intake_state IN ('accepted')),
  receipt_id      uuid NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  -- One response per session, however many requests arrive.
  UNIQUE (tenant_id, session_id),
  UNIQUE (receipt_id),
  FOREIGN KEY (tenant_id, session_id, form_id, form_version_id)
    REFERENCES app.respondent_sessions (tenant_id, id, form_id, form_version_id),
  FOREIGN KEY (tenant_id, form_id, form_version_id) REFERENCES app.form_versions (tenant_id, form_id, id)
);

-- Keyset pagination for the response list (RES-01).
CREATE INDEX submissions_form_received_idx ON app.submissions (tenant_id, form_id, received_at DESC, id DESC);

ALTER TABLE app.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.submissions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.respondent_sessions
  ADD CONSTRAINT respondent_sessions_accepted_submission_fkey
  FOREIGN KEY (tenant_id, accepted_submission_id) REFERENCES app.submissions (tenant_id, id);

CREATE TABLE app.submission_requests (
  tenant_id      uuid NOT NULL,
  session_id     uuid NOT NULL,
  -- SHA-256 of the client's Idempotency-Key.
  key_hash       bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  -- SHA-256 of the canonical request (version and answers); the same key with other content is a conflict.
  request_hash   bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  submission_id  uuid NOT NULL,
  response_code  integer NOT NULL CHECK (response_code BETWEEN 200 AND 299),
  -- The receipt returned; no answers.
  receipt        jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 8192),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id, key_hash),
  FOREIGN KEY (tenant_id, session_id) REFERENCES app.respondent_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, submission_id) REFERENCES app.submissions (tenant_id, id)
);

CREATE INDEX submission_requests_submission_idx ON app.submission_requests (tenant_id, submission_id);
-- Idempotency records are kept 30 days (docs/04 §5); the purge job arrives with GOV-01.
CREATE INDEX submission_requests_created_idx ON app.submission_requests (created_at);

ALTER TABLE app.submission_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.submission_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.submission_requests
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Locks the form row for the rest of the caller's transaction (FOR SHARE), so
-- closing a form and accepting a response serialize: a response is stored
-- only if the form was open at that moment. Runs as the owner because row
-- locks need an UPDATE privilege the public role must not have; it returns
-- only the lifecycle fields and refuses forms outside the current tenant.
CREATE FUNCTION app.lock_form_for_intake(p_form_id uuid)
  RETURNS TABLE (state text, active_version_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    SELECT f.state, f.active_version_id
      FROM app.forms f
     WHERE f.id = p_form_id
       AND f.tenant_id = app.current_tenant_id()
       AND f.deleted_at IS NULL
       FOR SHARE
  $$;

REVOKE ALL ON FUNCTION app.lock_form_for_intake(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_form_for_intake(uuid) TO workeasy_public;

-- Privileges -------------------------------------------------------------------
-- The public role appends submissions and idempotency records, reads its own
-- receipts back, and marks its session accepted (the column grant also allows
-- the session row lock). It cannot read submitted answers.

GRANT INSERT ON app.submissions TO workeasy_public;
GRANT SELECT, INSERT ON app.submission_requests TO workeasy_public;
GRANT UPDATE (accepted_submission_id) ON app.respondent_sessions TO workeasy_public;
GRANT INSERT ON app.outbox_events TO workeasy_public;
GRANT SELECT ON app.submissions, app.submission_requests TO workeasy_api, workeasy_worker;
