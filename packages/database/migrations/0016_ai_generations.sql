-- AI-01: bounded AI generation jobs (docs/03 §4).
--
-- A generation records who asked for what against which draft revision, and
-- what came back: a validated proposal, or a sanitized failure code. The
-- draft itself is never changed here; applying a proposal is a separate,
-- revalidated human action (AI-02). The prompt is kept only while the job
-- runs and cleared when it ends; its digest stays for reconciliation. The
-- durable job (migration 0014) that runs it has the generation ID as its
-- dedupe key.

CREATE TABLE app.ai_generations (
  id               uuid NOT NULL DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES app.tenants (id),
  form_id          uuid NOT NULL,
  requested_by     uuid NOT NULL REFERENCES app.users (id),
  operation        text NOT NULL CHECK (operation IN ('create', 'edit')),
  base_revision    integer NOT NULL CHECK (base_revision >= 1),
  -- The draft the proposal is built on, as it was when requested.
  base_definition  jsonb NOT NULL,
  prompt           text CHECK (char_length(prompt) BETWEEN 1 AND 8000),
  prompt_digest    text NOT NULL CHECK (prompt_digest ~ '^[0-9a-f]{64}$'),
  template_version text NOT NULL CHECK (char_length(template_version) <= 40),
  provider         text CHECK (char_length(provider) <= 40),
  model            text CHECK (char_length(model) <= 100),
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- A validated definition; set only on success.
  proposal         jsonb,
  -- Counts, warnings and (on failure) issue codes and paths; never model text.
  summary          jsonb CHECK (summary IS NULL OR (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 16384)),
  failure_code     text CHECK (failure_code ~ '^[a-z][a-z0-9_]*$' AND char_length(failure_code) <= 100),
  input_tokens     integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens    integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- The whole job must finish by then (docs/03: 120 seconds).
  deadline_at      timestamptz NOT NULL,
  finished_at      timestamptz,
  PRIMARY KEY (id),
  FOREIGN KEY (tenant_id, form_id) REFERENCES app.forms (tenant_id, id),
  CONSTRAINT ai_generations_outcome CHECK (
    CASE status
      WHEN 'succeeded' THEN proposal IS NOT NULL AND failure_code IS NULL AND finished_at IS NOT NULL AND prompt IS NULL
      WHEN 'failed' THEN proposal IS NULL AND failure_code IS NOT NULL AND finished_at IS NOT NULL AND prompt IS NULL
      WHEN 'cancelled' THEN proposal IS NULL AND finished_at IS NOT NULL AND prompt IS NULL
      ELSE proposal IS NULL AND finished_at IS NULL AND prompt IS NOT NULL
    END)
);

CREATE INDEX ai_generations_active_idx ON app.ai_generations (tenant_id, requested_by) WHERE status IN ('queued', 'running');
CREATE INDEX ai_generations_form_idx ON app.ai_generations (tenant_id, form_id, created_at DESC);

ALTER TABLE app.ai_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ai_generations
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Privileges -------------------------------------------------------------------
-- The API creates generations, reads them, cancels them and expires ones past
-- their deadline (a worker that died leaves them running). The worker runs
-- them in the tenant's context: it records progress and the outcome.
GRANT SELECT, INSERT ON app.ai_generations TO workeasy_api;
GRANT UPDATE (status, prompt, failure_code, finished_at, updated_at) ON app.ai_generations TO workeasy_api;
GRANT SELECT ON app.ai_generations TO workeasy_worker;
GRANT UPDATE (status, prompt, provider, model, proposal, summary, failure_code, input_tokens, output_tokens, finished_at, updated_at)
  ON app.ai_generations TO workeasy_worker;
-- The API enqueues the generation's job in the same transaction (granted in
-- migration 0014).
