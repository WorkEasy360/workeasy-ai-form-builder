-- OPS-02: intake now reserves the response last, just before commit, so the
-- hot counter rows stay locked as briefly as possible. By then the
-- transaction has inserted its own submission, and reserve_response would
-- count it when seeding a counter row on first use (one too many). Intake
-- therefore creates missing counter rows first, with this function, before
-- inserting anything. ON CONFLICT DO NOTHING takes no lock on an existing
-- row, so this adds no contention. reserve_response keeps its own seeding
-- as a fallback for callers that do not prepare.

CREATE FUNCTION app.prepare_response_counters(p_form_id uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
  DECLARE
    v_tenant uuid := app.current_tenant_id();
    v_period date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  BEGIN
    IF v_tenant IS NULL THEN
      RAISE EXCEPTION 'prepare_response_counters needs a tenant context' USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO app.usage_buckets (tenant_id, metric, period_start, consumed, limit_value)
    VALUES (v_tenant, 'responses', v_period,
            (SELECT count(*) FROM app.submissions s
              WHERE s.tenant_id = v_tenant AND s.received_at >= v_period::timestamp AT TIME ZONE 'UTC'),
            app.tenant_response_limit(v_tenant))
    ON CONFLICT (tenant_id, metric, period_start) DO NOTHING;
    INSERT INTO app.form_response_counters (tenant_id, form_id, accepted)
    VALUES (v_tenant, p_form_id, (SELECT count(*) FROM app.submissions s WHERE s.form_id = p_form_id))
    ON CONFLICT (tenant_id, form_id) DO NOTHING;
  END;
  $$;

REVOKE ALL ON FUNCTION app.prepare_response_counters(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prepare_response_counters(uuid) TO workeasy_public;
