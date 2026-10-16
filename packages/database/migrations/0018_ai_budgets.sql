-- AI-03: tenant opt-in and daily token budgets (docs/03 §4).
--
-- AI is off for an organization until an owner turns it on. Each request
-- reserves its worst-case token use against the organization's daily limit
-- before it is queued; the reservation is an atomic conditional update of
-- the day's row, so concurrent requests cannot together pass the limit.
-- Actual use is added as the provider reports it, and the reservation is
-- released once, when the generation is settled.

CREATE TABLE app.ai_settings (
  tenant_id         uuid NOT NULL REFERENCES app.tenants (id),
  enabled           boolean NOT NULL DEFAULT false,
  daily_token_limit integer NOT NULL DEFAULT 200000 CHECK (daily_token_limit BETWEEN 1000 AND 100000000),
  updated_by        uuid REFERENCES app.users (id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id)
);

CREATE TABLE app.ai_usage_days (
  tenant_id       uuid NOT NULL REFERENCES app.tenants (id),
  day             date NOT NULL,
  reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  used_tokens     bigint NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  PRIMARY KEY (tenant_id, day)
);

-- Tokens a generation still holds against its day; 0 once settled.
ALTER TABLE app.ai_generations ADD COLUMN reserved_tokens integer NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0);

ALTER TABLE app.ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ai_settings
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE app.ai_usage_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_usage_days FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ai_usage_days
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Privileges -------------------------------------------------------------------
-- The API manages settings, reserves budget and settles generations it
-- expires or cancels; the worker adds actual use and settles the rest.
GRANT SELECT, INSERT, UPDATE ON app.ai_settings TO workeasy_api;
GRANT SELECT, INSERT, UPDATE ON app.ai_usage_days TO workeasy_api, workeasy_worker;
GRANT UPDATE (reserved_tokens) ON app.ai_generations TO workeasy_api, workeasy_worker;
GRANT SELECT ON app.ai_settings TO workeasy_worker;
