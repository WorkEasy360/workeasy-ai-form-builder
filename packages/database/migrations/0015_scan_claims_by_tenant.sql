-- Scan claims limited to one tenant, like dispatch_outbox and claim_jobs
-- (migration 0014). The worker still claims across all tenants (NULL);
-- integration tests running in parallel each scan only their own tenant, so
-- one file's scan loop cannot take another file's uploads mid-test.

DROP FUNCTION app.claim_scan_jobs(integer, integer);

CREATE FUNCTION app.claim_scan_jobs(p_limit integer, p_lease_seconds integer, p_tenant_id uuid DEFAULT NULL)
  RETURNS TABLE (upload_id uuid, tenant_id uuid, form_id uuid, form_version_id uuid, field_id text, storage_key text,
                 declared_type text, declared_bytes integer, attempt integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    WITH next AS (
      SELECT u.id FROM app.file_uploads u
       WHERE (u.state = 'pending_scan' OR (u.state = 'scanning' AND u.lease_until < now()))
         AND u.expires_at > now()
         AND (p_tenant_id IS NULL OR u.tenant_id = p_tenant_id)
       ORDER BY u.created_at
       LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    )
    UPDATE app.file_uploads u
       SET state = 'scanning', lease_until = now() + make_interval(secs => p_lease_seconds), scan_attempts = u.scan_attempts + 1
      FROM next WHERE u.id = next.id
    RETURNING u.id, u.tenant_id, u.form_id, u.form_version_id, u.field_id, u.storage_key, u.declared_type, u.declared_bytes, u.scan_attempts
  $$;

REVOKE ALL ON FUNCTION app.claim_scan_jobs(integer, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_scan_jobs(integer, integer, uuid) TO workeasy_worker;
