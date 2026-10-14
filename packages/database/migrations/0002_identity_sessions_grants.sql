-- FND-03: console sessions, per-form grants and the narrow identity lookups
-- that run before any tenant or user context exists.

-- A signed-in user with no tenant selected (GET /api/v1/me) may list its own
-- memberships and the organizations they belong to. Tenant-scoped requests
-- (app.tenant_id set) stay strictly limited to that tenant.

CREATE POLICY memberships_self_view ON app.memberships FOR SELECT
  USING (app.current_tenant_id() IS NULL AND user_id = app.current_app_user_id());

CREATE POLICY tenants_member_view ON app.tenants FOR SELECT
  USING (
    app.current_tenant_id() IS NULL
    AND EXISTS (
      SELECT 1 FROM app.memberships m
       WHERE m.tenant_id = tenants.id
         AND m.user_id = app.current_app_user_id()
         AND m.status = 'active'
    )
  );

-- auth_sessions: server-managed console sessions. Only a SHA-256 hash of the
-- cookie token is stored.

CREATE TABLE app.auth_sessions (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES app.users (id),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_id_idx ON app.auth_sessions (user_id);

ALTER TABLE app.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_self ON app.auth_sessions
  USING (user_id = app.current_app_user_id())
  WITH CHECK (user_id = app.current_app_user_id());

-- Identity lookups before a context exists. These SECURITY DEFINER functions
-- run as the owner role; the owner-only read policies below let them see the
-- rows they need, and each function returns only the minimum. Runtime roles
-- still cannot read these tables directly without a context.

CREATE POLICY identity_lookup ON app.users FOR SELECT TO workeasy_owner USING (true);
CREATE POLICY session_lookup ON app.auth_sessions FOR SELECT TO workeasy_owner USING (true);

CREATE FUNCTION app.find_user_id_by_identity(p_issuer text, p_subject text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$ SELECT id FROM app.users WHERE issuer = p_issuer AND subject = p_subject $$;

CREATE FUNCTION app.resolve_session(p_token_hash bytea)
  RETURNS TABLE (session_id uuid, user_id uuid, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    SELECT s.id, s.user_id, s.expires_at
      FROM app.auth_sessions s
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
  $$;

REVOKE ALL ON FUNCTION app.find_user_id_by_identity(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_user_id_by_identity(text, text) TO workeasy_api;
GRANT EXECUTE ON FUNCTION app.resolve_session(bytea) TO workeasy_api;

-- form_grants: explicit per-form permissions for organization members
-- (docs/01 §4). Owners and admins hold most form permissions through their
-- role; everyone else needs a grant.

CREATE TABLE app.form_grants (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  form_id        uuid NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user')),
  principal_id   uuid NOT NULL,
  permission     text NOT NULL CHECK (permission IN (
    'forms.read', 'forms.edit', 'forms.publish', 'forms.delete', 'forms.manage_access',
    'responses.read', 'responses.export', 'responses.edit', 'responses.delete',
    'workflows.manage', 'analytics.read'
  )),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, form_id, principal_type, principal_id, permission),
  FOREIGN KEY (tenant_id, form_id) REFERENCES app.forms (tenant_id, id),
  -- Principals and grantors must be members of the same organization.
  FOREIGN KEY (tenant_id, principal_id) REFERENCES app.memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.memberships (tenant_id, user_id)
);

CREATE INDEX form_grants_principal_idx ON app.form_grants (tenant_id, principal_id);

ALTER TABLE app.form_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.form_grants
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Privileges -----------------------------------------------------------------
-- Grants are configuration and are replaced wholesale, so the API may delete them.

GRANT SELECT, INSERT, UPDATE ON app.auth_sessions TO workeasy_api;
GRANT SELECT, INSERT, DELETE ON app.form_grants TO workeasy_api;
GRANT SELECT ON app.form_grants TO workeasy_worker;
