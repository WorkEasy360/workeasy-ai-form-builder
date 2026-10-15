-- PUB-01: immutable published versions, the active version pointer, and the
-- audit and outbox records written with every publication (docs/02 §5,
-- docs/04 §3).
--
-- A version is a snapshot of a validated draft. Rows are never updated: the
-- API role may only insert and read them, and a trigger refuses updates from
-- any role. Respondents and submissions pin a version (RUN-01); rollback only
-- moves the form's active pointer to another existing version of the same form.

CREATE TABLE app.form_versions (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  form_id           uuid NOT NULL,
  version_number    integer NOT NULL CHECK (version_number >= 1),
  schema_version    text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 20),
  definition        jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  -- What respondents receive: the definition without internal configuration.
  public_projection jsonb NOT NULL CHECK (jsonb_typeof(public_projection) = 'object'),
  -- SHA-256 of the canonical definition JSON.
  content_hash      bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  -- Workflow configuration snapshot (P2); empty until workflows exist.
  workflow_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(workflow_snapshot) = 'object'),
  -- The draft revision this version was published from.
  draft_revision    integer NOT NULL CHECK (draft_revision >= 1),
  -- SHA-256 of the publish request's Idempotency-Key, so a retry returns this version.
  publish_key_hash  bytea NOT NULL CHECK (octet_length(publish_key_hash) = 32),
  published_by      uuid NOT NULL,
  published_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  -- Target for (tenant, form, version) foreign keys: the active pointer, sessions and submissions.
  UNIQUE (tenant_id, form_id, id),
  UNIQUE (tenant_id, form_id, version_number),
  UNIQUE (tenant_id, form_id, publish_key_hash),
  FOREIGN KEY (tenant_id, form_id) REFERENCES app.forms (tenant_id, id),
  FOREIGN KEY (tenant_id, published_by) REFERENCES app.memberships (tenant_id, user_id),
  -- Matches the engine's 1 MiB definition limit.
  CHECK (octet_length(definition::text) <= 1048576)
);

CREATE FUNCTION app.reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER form_versions_immutable BEFORE UPDATE ON app.form_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_update();

ALTER TABLE app.form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.form_versions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The version new respondents get. The composite key keeps it inside the same
-- form and tenant, so rollback can never point at another form's version.
ALTER TABLE app.forms ADD COLUMN active_version_id uuid;
ALTER TABLE app.forms
  ADD CONSTRAINT forms_active_version_fkey
  FOREIGN KEY (tenant_id, id, active_version_id) REFERENCES app.form_versions (tenant_id, form_id, id);
-- A published or closed form always has a version to serve.
ALTER TABLE app.forms
  ADD CONSTRAINT forms_published_has_version
  CHECK (state NOT IN ('published', 'closed') OR active_version_id IS NOT NULL);

-- Audit (append-only) ----------------------------------------------------------
-- Who did what to which resource. Metadata holds identifiers and counts only,
-- never answers or definition content (docs/06).

CREATE TABLE app.audit_events (
  id            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants (id),
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id      uuid,
  action        text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  resource_type text NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 50),
  resource_id   uuid NOT NULL,
  request_id    text CHECK (char_length(request_id) <= 100),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CHECK ((actor_type = 'user') = (actor_id IS NOT NULL))
);

CREATE INDEX audit_events_tenant_occurred_idx ON app.audit_events (tenant_id, occurred_at DESC);
CREATE INDEX audit_events_resource_idx ON app.audit_events (tenant_id, resource_type, resource_id, occurred_at DESC);

CREATE TRIGGER audit_events_append_only BEFORE UPDATE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_update();

ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.audit_events
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Outbox -------------------------------------------------------------------------
-- Events committed with the change that caused them (docs/04 §5). The payload
-- is the versioned envelope's `data`: references to protected records, never
-- answers. The dispatcher (JOB-01) claims undispatched rows.

CREATE TABLE app.outbox_events (
  id            uuid NOT NULL DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants (id),
  event_type    text NOT NULL CHECK (event_type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+\.v[1-9][0-9]*$'),
  aggregate_id  uuid NOT NULL,
  payload       jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
  trace_id      text CHECK (char_length(trace_id) <= 100),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  PRIMARY KEY (id)
);

CREATE INDEX outbox_events_undispatched_idx ON app.outbox_events (occurred_at, id) WHERE dispatched_at IS NULL;

ALTER TABLE app.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.outbox_events
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Privileges -------------------------------------------------------------------
-- Versions: insert and read, never update or delete. Audit and outbox: the API
-- only appends. Workers read; the dispatcher's write access arrives with JOB-01.

GRANT SELECT, INSERT ON app.form_versions TO workeasy_api;
GRANT INSERT ON app.audit_events, app.outbox_events TO workeasy_api;
GRANT SELECT ON app.form_versions, app.audit_events, app.outbox_events TO workeasy_worker;
