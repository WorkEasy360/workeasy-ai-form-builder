-- RUN-03: response limits and quotas (docs/04 §3 and §5 step 7).
--
-- A form may cap its responses and set when it opens and closes. A tenant
-- may cap responses per calendar month (UTC) through
-- tenants.settings.limits.responsesPerMonth. Intake reserves one response
-- against both counters inside its transaction with app.reserve_response,
-- which locks them in a fixed order (tenant bucket, then form) and checks
-- both before incrementing either, so concurrent last-slot submissions can
-- never overrun a limit and a refusal never leaves a counter half-moved.

ALTER TABLE app.form_access_policies
  ADD COLUMN max_responses integer CHECK (max_responses BETWEEN 1 AND 10000000),
  ADD COLUMN open_at timestamptz,
  ADD COLUMN close_at timestamptz,
  ADD CONSTRAINT form_access_policies_window CHECK (open_at IS NULL OR close_at IS NULL OR close_at > open_at);

-- Accepted responses per form. Rows are created on first use, seeded from the
-- responses already stored, and only ever changed by app.reserve_response.
CREATE TABLE app.form_response_counters (
  tenant_id  uuid NOT NULL,
  form_id    uuid NOT NULL,
  accepted   integer NOT NULL DEFAULT 0 CHECK (accepted >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, form_id),
  FOREIGN KEY (tenant_id, form_id) REFERENCES app.forms (tenant_id, id)
);

CREATE TRIGGER form_response_counters_set_updated_at BEFORE UPDATE ON app.form_response_counters
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.form_response_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_response_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.form_response_counters
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Tenant usage per metric and period (docs/04 §3). limit_value records the
-- limit in force when the bucket was last used; null means unlimited.
CREATE TABLE app.usage_buckets (
  tenant_id    uuid NOT NULL REFERENCES app.tenants (id),
  metric       text NOT NULL CHECK (metric IN ('responses')),
  period_start date NOT NULL,
  consumed     integer NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  reserved     integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  limit_value  integer CHECK (limit_value >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period_start)
);

CREATE TRIGGER usage_buckets_set_updated_at BEFORE UPDATE ON app.usage_buckets
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.usage_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.usage_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.usage_buckets
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The tenant's monthly response limit, or null for none.
CREATE FUNCTION app.tenant_response_limit(p_tenant_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    SELECT CASE
             WHEN jsonb_typeof(t.settings #> '{limits,responsesPerMonth}') = 'number'
             THEN (t.settings #>> '{limits,responsesPerMonth}')::integer
           END
      FROM app.tenants t
     WHERE t.id = p_tenant_id
  $$;

-- Reserves one response for a form in the current tenant: 'ok', 'form_full'
-- or 'tenant_quota'. Runs inside the caller's intake transaction, so the
-- increments commit or roll back with the submission. Runs as the owner so
-- the public role never needs write access to the counters; row security
-- still confines it to the current tenant.
CREATE FUNCTION app.reserve_response(p_form_id uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
  DECLARE
    v_tenant  uuid := app.current_tenant_id();
    v_period  date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
    v_limit   integer := app.tenant_response_limit(v_tenant);
    v_max     integer;
    v_used    integer;
    v_count   integer;
  BEGIN
    IF v_tenant IS NULL THEN
      RAISE EXCEPTION 'reserve_response needs a tenant context' USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 1. Tenant bucket first (fixed lock order), seeded from this month's stored responses.
    INSERT INTO app.usage_buckets (tenant_id, metric, period_start, consumed, limit_value)
    VALUES (v_tenant, 'responses', v_period,
            (SELECT count(*) FROM app.submissions s
              WHERE s.tenant_id = v_tenant AND s.received_at >= v_period::timestamp AT TIME ZONE 'UTC'),
            v_limit)
    ON CONFLICT (tenant_id, metric, period_start) DO NOTHING;
    SELECT consumed INTO v_used FROM app.usage_buckets
     WHERE tenant_id = v_tenant AND metric = 'responses' AND period_start = v_period
       FOR UPDATE;

    -- 2. Then the form counter, seeded from the form's stored responses.
    SELECT p.max_responses INTO v_max FROM app.form_access_policies p WHERE p.form_id = p_form_id;
    INSERT INTO app.form_response_counters (tenant_id, form_id, accepted)
    VALUES (v_tenant, p_form_id, (SELECT count(*) FROM app.submissions s WHERE s.form_id = p_form_id))
    ON CONFLICT (tenant_id, form_id) DO NOTHING;
    SELECT accepted INTO v_count FROM app.form_response_counters
     WHERE tenant_id = v_tenant AND form_id = p_form_id
       FOR UPDATE;

    -- 3. Both checks before either increment.
    IF v_max IS NOT NULL AND v_count >= v_max THEN
      RETURN 'form_full';
    END IF;
    IF v_limit IS NOT NULL AND v_used >= v_limit THEN
      RETURN 'tenant_quota';
    END IF;

    UPDATE app.usage_buckets SET consumed = consumed + 1, limit_value = v_limit
     WHERE tenant_id = v_tenant AND metric = 'responses' AND period_start = v_period;
    UPDATE app.form_response_counters SET accepted = accepted + 1
     WHERE tenant_id = v_tenant AND form_id = p_form_id;
    RETURN 'ok';
  END;
  $$;

-- Read-only view of the limits for the respondent page (no locks, no changes).
CREATE FUNCTION app.response_capacity(p_form_id uuid)
  RETURNS TABLE (form_full boolean, tenant_quota_reached boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    WITH ctx AS (
      SELECT app.current_tenant_id() AS tenant,
             date_trunc('month', now() AT TIME ZONE 'UTC')::date AS period
    ),
    lim AS (SELECT app.tenant_response_limit((SELECT tenant FROM ctx)) AS tenant_limit)
    SELECT
      COALESCE((SELECT p.max_responses <= COALESCE(c.accepted, (SELECT count(*) FROM app.submissions s WHERE s.form_id = p_form_id))
                  FROM app.form_access_policies p
                  LEFT JOIN app.form_response_counters c ON c.form_id = p.form_id
                 WHERE p.form_id = p_form_id), false),
      COALESCE((SELECT lim.tenant_limit <= COALESCE(
                  (SELECT b.consumed FROM app.usage_buckets b, ctx
                    WHERE b.tenant_id = ctx.tenant AND b.metric = 'responses' AND b.period_start = ctx.period),
                  (SELECT count(*) FROM app.submissions s, ctx
                    WHERE s.tenant_id = ctx.tenant AND s.received_at >= ctx.period::timestamp AT TIME ZONE 'UTC'))
                  FROM lim WHERE lim.tenant_limit IS NOT NULL), false)
  $$;

REVOKE ALL ON FUNCTION app.tenant_response_limit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reserve_response(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.response_capacity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserve_response(uuid) TO workeasy_public;
GRANT EXECUTE ON FUNCTION app.response_capacity(uuid) TO workeasy_public, workeasy_api;

-- Privileges -------------------------------------------------------------------
-- The schedule and limit are read by the public role with the mode; counters
-- and buckets are written only through app.reserve_response.

GRANT SELECT (max_responses, open_at, close_at) ON app.form_access_policies TO workeasy_public;
GRANT SELECT ON app.form_response_counters, app.usage_buckets TO workeasy_api, workeasy_worker;
