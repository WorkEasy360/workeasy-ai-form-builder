-- GOV-01: the purge and retention functions (migration 0012) run as the owner
-- without a tenant context, across tenants, like the upload and export
-- queues. Row security is forced, so they need explicit owner policies on
-- the tables they work on. Runtime roles are unaffected: these policies name
-- only the owner, and only the SECURITY DEFINER functions run as it.

CREATE POLICY purge_queue ON app.submissions FOR ALL TO workeasy_owner USING (true) WITH CHECK (true);
CREATE POLICY purge_receipts ON app.submission_requests FOR ALL TO workeasy_owner USING (true) WITH CHECK (true);
