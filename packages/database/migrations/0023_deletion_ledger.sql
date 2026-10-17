-- REC-01: the deletion ledger, kept outside the database backups.
--
-- Deleted responses and forms stay as tombstones (0012). The backup job
-- exports tombstones newer than its last export to the backup folder every
-- minute, so the ledger is always newer than the latest database backup.
-- After a restore, replaying it deletes again whatever was deleted after
-- the recovery point; the worker then purges content as usual.
-- Both functions run only as the owner role, from the operations CLI.

CREATE FUNCTION app.deletion_ledger(p_since timestamptz)
  RETURNS TABLE (kind text, id uuid, tenant_id uuid, form_id uuid, deleted_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    SELECT 'form', f.id, f.tenant_id, f.id, f.deleted_at
      FROM app.forms f WHERE f.deleted_at > p_since
    UNION ALL
    SELECT 'response', s.id, s.tenant_id, s.form_id, s.deleted_at
      FROM app.submissions s WHERE s.deleted_at > p_since
    ORDER BY 5, 2
  $$;

-- Applies ledger entries: [{kind, id, tenant_id, deleted_at}]. Entries for
-- rows that are already deleted, or that do not exist in the restored data,
-- change nothing, so the ledger can be replayed any number of times. Rows
-- keep their original deletion time; the reason records the replay.
CREATE FUNCTION app.replay_deletions(p_entries jsonb)
  RETURNS TABLE (forms_deleted integer, responses_deleted integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
  DECLARE
    v_forms integer;
    v_responses integer;
  BEGIN
    WITH entries AS (
      SELECT e->>'kind' AS kind, (e->>'id')::uuid AS id, (e->>'tenant_id')::uuid AS tenant_id, (e->>'deleted_at')::timestamptz AS deleted_at
        FROM jsonb_array_elements(p_entries) e
    )
    UPDATE app.forms f SET deleted_at = e.deleted_at
      FROM entries e
     WHERE e.kind = 'form' AND f.id = e.id AND f.tenant_id = e.tenant_id AND f.deleted_at IS NULL;
    GET DIAGNOSTICS v_forms = ROW_COUNT;

    WITH entries AS (
      SELECT e->>'kind' AS kind, (e->>'id')::uuid AS id, (e->>'tenant_id')::uuid AS tenant_id, (e->>'deleted_at')::timestamptz AS deleted_at
        FROM jsonb_array_elements(p_entries) e
    ),
    -- A replayed form deletion deletes its responses too, as deleting a form does.
    targets AS (
      SELECT s.id, e.deleted_at FROM entries e JOIN app.submissions s ON s.id = e.id AND s.tenant_id = e.tenant_id
       WHERE e.kind = 'response'
      UNION ALL
      SELECT s.id, e.deleted_at FROM entries e JOIN app.submissions s ON s.form_id = e.id AND s.tenant_id = e.tenant_id
       WHERE e.kind = 'form'
    )
    UPDATE app.submissions s SET deleted_at = t.deleted_at, deleted_by = NULL, deletion_reason = 'Deleted again after a backup restore'
      FROM (SELECT DISTINCT ON (id) id, deleted_at FROM targets ORDER BY id, deleted_at) t
     WHERE s.id = t.id AND s.deleted_at IS NULL;
    GET DIAGNOSTICS v_responses = ROW_COUNT;

    RETURN QUERY SELECT v_forms, v_responses;
  END
  $$;

-- The owner may otherwise only read forms (0005); replay may only mark a live form deleted.
CREATE POLICY deletion_replay ON app.forms FOR UPDATE TO workeasy_owner
  USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NOT NULL);

REVOKE ALL ON FUNCTION app.deletion_ledger(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.replay_deletions(jsonb) FROM PUBLIC;
