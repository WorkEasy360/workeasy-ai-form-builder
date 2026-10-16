-- AUT-01: email and signed webhooks (docs/05 §6).
--
-- An integration sends a form's accepted responses to a destination. Each
-- accepted response creates one delivery per enabled integration (unique per
-- integration and event), delivered by a durable job; every attempt is kept
-- as delivery history. Webhook payloads hold only the fields the integration
-- was configured with; emails carry a link, never answers. Webhook signing
-- secrets are stored encrypted with an application key, never in plain text.

CREATE TABLE app.integrations (
  id                     uuid NOT NULL DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL REFERENCES app.tenants (id),
  form_id                uuid NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('webhook', 'email')),
  name                   text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  enabled                boolean NOT NULL DEFAULT true,
  url                    text CHECK (char_length(url) <= 2000),
  recipients             text[] CHECK (cardinality(recipients) BETWEEN 1 AND 10),
  field_ids              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(field_ids) <= 100),
  secret_ciphertext      text,
  previous_secret_ciphertext text,
  previous_secret_expires_at timestamptz,
  created_by             uuid NOT NULL REFERENCES app.users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, form_id) REFERENCES app.forms (tenant_id, id),
  CONSTRAINT integrations_shape CHECK (
    CASE kind
      WHEN 'webhook' THEN url IS NOT NULL AND secret_ciphertext IS NOT NULL AND recipients IS NULL
      ELSE url IS NULL AND secret_ciphertext IS NULL AND recipients IS NOT NULL AND field_ids = '{}'
    END),
  CONSTRAINT integrations_previous_secret CHECK ((previous_secret_ciphertext IS NULL) = (previous_secret_expires_at IS NULL))
);

CREATE INDEX integrations_form_idx ON app.integrations (tenant_id, form_id) WHERE deleted_at IS NULL;

CREATE TABLE app.deliveries (
  id              uuid NOT NULL DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES app.tenants (id),
  integration_id  uuid NOT NULL,
  form_id         uuid NOT NULL,
  submission_id   uuid NOT NULL,
  -- The outbox event; destinations deduplicate on it.
  event_id        uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'succeeded', 'failed', 'skipped')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_status_code integer,
  last_error      text CHECK (last_error ~ '^[a-z][a-z0-9_]*$' AND char_length(last_error) <= 100),
  -- A timed-out attempt may still have reached the destination.
  ambiguous       boolean NOT NULL DEFAULT false,
  next_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  CONSTRAINT deliveries_once UNIQUE (integration_id, event_id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES app.integrations (tenant_id, id),
  CONSTRAINT deliveries_completed CHECK ((status IN ('succeeded', 'failed', 'skipped')) = (completed_at IS NOT NULL))
);

CREATE INDEX deliveries_integration_idx ON app.deliveries (tenant_id, integration_id, created_at DESC, id DESC);

CREATE TABLE app.delivery_attempts (
  id           uuid NOT NULL DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES app.tenants (id),
  delivery_id  uuid NOT NULL,
  attempt      integer NOT NULL CHECK (attempt >= 1),
  started_at   timestamptz NOT NULL,
  duration_ms  integer NOT NULL CHECK (duration_ms >= 0),
  status_code  integer,
  error_code   text CHECK (error_code ~ '^[a-z][a-z0-9_]*$' AND char_length(error_code) <= 100),
  outcome      text NOT NULL CHECK (outcome IN ('succeeded', 'retry', 'failed', 'skipped')),
  PRIMARY KEY (id),
  UNIQUE (delivery_id, attempt),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES app.deliveries (tenant_id, id)
);

ALTER TABLE app.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.integrations
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.deliveries
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.delivery_attempts
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Privileges -------------------------------------------------------------------
-- The API manages integrations, reads delivery history and requeues failed
-- deliveries. The worker fans events out into deliveries (enqueueing their
-- jobs) and records every attempt.
GRANT SELECT, INSERT, UPDATE ON app.integrations TO workeasy_api;
GRANT SELECT ON app.deliveries, app.delivery_attempts TO workeasy_api;
GRANT UPDATE (status, next_attempt_at, updated_at, completed_at) ON app.deliveries TO workeasy_api;
GRANT SELECT ON app.integrations TO workeasy_worker;
GRANT SELECT, INSERT, UPDATE ON app.deliveries TO workeasy_worker;
GRANT SELECT, INSERT ON app.delivery_attempts TO workeasy_worker;
GRANT INSERT ON app.jobs TO workeasy_worker;
