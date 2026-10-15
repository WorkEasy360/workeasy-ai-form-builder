-- RUN-01: who may respond to a form, and version-bound respondent sessions
-- (docs/02 §6, docs/04 §3, docs/05 §3).
--
-- A form without a policy row is open to anyone with the link. An
-- "organization" policy admits only signed-in active members of the form's
-- organization, rechecked whenever the session is used.
--
-- A respondent session pins one version of one form in one tenant: the
-- composite foreign key makes any other combination impossible, so a session
-- can never be pointed at another form's or tenant's version. The browser
-- holds a random capability; only its SHA-256 is stored.

CREATE TABLE app.form_access_policies (
  tenant_id  uuid NOT NULL,
  form_id    uuid NOT NULL,
  mode       text NOT NULL CHECK (mode IN ('public', 'organization')),
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, form_id),
  FOREIGN KEY (tenant_id, form_id) REFERENCES app.forms (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES app.memberships (tenant_id, user_id)
);

CREATE TRIGGER form_access_policies_set_updated_at BEFORE UPDATE ON app.form_access_policies
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.form_access_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_access_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.form_access_policies
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TABLE app.respondent_sessions (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL,
  form_id                uuid NOT NULL,
  form_version_id        uuid NOT NULL,
  -- SHA-256 of the capability the respondent holds; the capability itself is never stored.
  token_hash             bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  -- The signed-in member, for organization-only forms; null for anonymous respondents.
  actor_id               uuid,
  expires_at             timestamptz NOT NULL,
  revoked_at             timestamptz,
  -- Set by intake (RUN-02) when this session's response is stored.
  accepted_submission_id uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (tenant_id, form_id, form_version_id) REFERENCES app.form_versions (tenant_id, form_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES app.memberships (tenant_id, user_id),
  CHECK (expires_at > created_at)
);

CREATE INDEX respondent_sessions_form_idx ON app.respondent_sessions (tenant_id, form_id, created_at DESC);

ALTER TABLE app.respondent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.respondent_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.respondent_sessions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Lookups before a tenant context exists ----------------------------------------
-- As with the slug locator, each returns the minimum and runs as the owner.

CREATE POLICY session_locator ON app.respondent_sessions FOR SELECT TO workeasy_owner USING (true);
CREATE POLICY membership_lookup ON app.memberships FOR SELECT TO workeasy_owner USING (true);

-- The live session behind a capability hash: identifiers and expiry only.
CREATE FUNCTION app.resolve_respondent_session(p_token_hash bytea)
  RETURNS TABLE (session_id uuid, tenant_id uuid, form_id uuid, form_version_id uuid, actor_id uuid, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    SELECT s.id, s.tenant_id, s.form_id, s.form_version_id, s.actor_id, s.expires_at
      FROM app.respondent_sessions s
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
  $$;

-- Whether a user is an active member of a tenant (organization-only forms).
CREATE FUNCTION app.is_active_member(p_tenant_id uuid, p_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM app.memberships m
       WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.status = 'active'
    )
  $$;

REVOKE ALL ON FUNCTION app.resolve_respondent_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.is_active_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_respondent_session(bytea) TO workeasy_public;
GRANT EXECUTE ON FUNCTION app.is_active_member(uuid, uuid) TO workeasy_public;
-- Respondents sign in on the respondent origin; the public routes resolve that cookie.
GRANT EXECUTE ON FUNCTION app.resolve_session(bytea) TO workeasy_public;

-- Privileges -------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON app.form_access_policies TO workeasy_api;
GRANT SELECT ON app.form_access_policies, app.respondent_sessions TO workeasy_worker;
GRANT SELECT (tenant_id, form_id, mode) ON app.form_access_policies TO workeasy_public;
GRANT SELECT, INSERT ON app.respondent_sessions TO workeasy_public;
