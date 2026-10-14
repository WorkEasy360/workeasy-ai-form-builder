-- BLD-01: the editable draft behind every form (docs/04 §3).
--
-- One draft per form. `revision` is the optimistic-concurrency counter used
-- by PUT draft with If-Match (BLD-03). Drafts may be incomplete; full
-- validation happens on validate/publish. Published versions are separate
-- immutable rows (PUB-01).

CREATE TABLE app.form_drafts (
  tenant_id      uuid NOT NULL,
  form_id        uuid NOT NULL,
  revision       integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  definition     jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  -- Workflow configuration (P2). Never copied when a form is duplicated.
  workflow_draft jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(workflow_draft) = 'object'),
  updated_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, form_id),
  FOREIGN KEY (tenant_id, form_id) REFERENCES app.forms (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES app.memberships (tenant_id, user_id),
  -- Matches the engine's 1 MiB definition limit.
  CHECK (octet_length(definition::text) <= 1048576)
);

CREATE TRIGGER form_drafts_set_updated_at BEFORE UPDATE ON app.form_drafts
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.form_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.form_drafts
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON app.form_drafts TO workeasy_api;
GRANT SELECT ON app.form_drafts TO workeasy_worker;
