-- RES-01: reading responses (docs/04 §7, docs/06 §3).
--
-- Fields are classified ordinary, personal or sensitive (in the form
-- definition). responses.read shows ordinary answers; personal and sensitive
-- answers need responses.read_personal and responses.read_sensitive, which
-- can now be granted per form.

ALTER TABLE app.form_grants DROP CONSTRAINT form_grants_permission_check;
ALTER TABLE app.form_grants ADD CONSTRAINT form_grants_permission_check CHECK (permission IN (
  'forms.read', 'forms.edit', 'forms.publish', 'forms.delete', 'forms.manage_access',
  'responses.read', 'responses.read_personal', 'responses.read_sensitive',
  'responses.export', 'responses.edit', 'responses.delete',
  'workflows.manage', 'analytics.read'
));

-- Response detail shows who responded to an organization-only form. The API
-- reads sessions for that, never their capability hashes.
GRANT SELECT (id, tenant_id, form_id, form_version_id, actor_id, expires_at, revoked_at, accepted_submission_id, created_at)
  ON app.respondent_sessions TO workeasy_api;
