-- FND-02: tenancy foundation (docs/04-data-model.md).
--
-- Runs as workeasy_owner, which owns every object. Runtime roles
-- (workeasy_api, workeasy_worker, workeasy_public) never own tables and have
-- no BYPASSRLS, so the FORCEd policies below always apply to them.
--
-- Tenant context is transaction-local:
--   SELECT set_config('app.tenant_id', '<uuid>', true);
-- Missing context yields no tenant rows.

GRANT USAGE ON SCHEMA app TO workeasy_api, workeasy_worker, workeasy_public;

-- Context accessors ----------------------------------------------------------

CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.current_app_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- tenants --------------------------------------------------------------------

CREATE TABLE app.tenants (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  external_org_id text UNIQUE CHECK (char_length(external_org_id) BETWEEN 1 AND 200),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  home_region     text NOT NULL CHECK (char_length(home_region) BETWEEN 1 AND 64),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

-- users (global identities; issuer + subject is the identity key, not email) --

CREATE TABLE app.users (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  issuer       text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 500),
  subject      text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  display_name text CHECK (char_length(display_name) <= 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Row security for users is defined after memberships, which it references.

-- memberships ----------------------------------------------------------------

CREATE TABLE app.memberships (
  tenant_id  uuid NOT NULL REFERENCES app.tenants (id),
  user_id    uuid NOT NULL REFERENCES app.users (id),
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'creator', 'analyst', 'approver')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX memberships_user_id_idx ON app.memberships (user_id);

CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.memberships
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- users row security: a user is visible to itself (app.user_id) and to tenants
-- it belongs to. The memberships subquery is itself tenant-filtered by RLS.
-- Only the user's own context may create or change its identity row.

ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON app.users FOR SELECT
  USING (
    id = app.current_app_user_id()
    OR EXISTS (SELECT 1 FROM app.memberships m WHERE m.user_id = users.id)
  );
CREATE POLICY users_insert_self ON app.users FOR INSERT
  WITH CHECK (id = app.current_app_user_id());
CREATE POLICY users_update_self ON app.users FOR UPDATE
  USING (id = app.current_app_user_id())
  WITH CHECK (id = app.current_app_user_id());

-- forms (lifecycle columns only; versions, access policies and grants arrive
-- with their own backlog items) ----------------------------------------------

CREATE TABLE app.forms (
  id             uuid NOT NULL DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants (id),
  slug           text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  owner_id       uuid NOT NULL,
  state          text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'closed', 'archived')),
  retention_days integer NOT NULL DEFAULT 365 CHECK (retention_days > 0),
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  -- Target for composite (tenant_id, form_id) foreign keys from child tables.
  UNIQUE (tenant_id, id),
  -- Public locator: globally unique, never an authorization credential.
  UNIQUE (slug),
  -- The owner must be a member of the same tenant.
  FOREIGN KEY (tenant_id, owner_id) REFERENCES app.memberships (tenant_id, user_id)
);

CREATE INDEX forms_tenant_state_updated_idx ON app.forms (tenant_id, state, updated_at DESC);

CREATE TRIGGER forms_set_updated_at BEFORE UPDATE ON app.forms
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.forms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.forms
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Privileges -----------------------------------------------------------------
-- No DELETE anywhere: memberships are revoked by status and forms are soft
-- deleted; physical purge is a governed worker operation (GOV-01).

GRANT SELECT, INSERT, UPDATE ON app.tenants, app.users, app.memberships, app.forms TO workeasy_api;
GRANT SELECT ON app.tenants, app.users, app.memberships, app.forms TO workeasy_worker;
-- workeasy_public gets only the narrow slug locator in RUN-01.
