-- PUB-02: the public role's narrow path to published forms (docs/04 §4).
--
-- A slug only locates a form; it never grants access. The public API first
-- resolves the slug through a SECURITY DEFINER locator that returns nothing
-- but the tenant and form IDs, then opens a tenant context and reads, under
-- row security, only the columns respondents need: the form's lifecycle state
-- and its active version's public projection. Drafts, names, grants, members,
-- full definitions and audit data stay out of reach of this role.

CREATE POLICY public_locator ON app.forms FOR SELECT TO workeasy_owner USING (true);

CREATE FUNCTION app.resolve_public_form(p_slug text)
  RETURNS TABLE (tenant_id uuid, form_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    SELECT f.tenant_id, f.id
      FROM app.forms f
     WHERE f.slug = p_slug
       AND f.deleted_at IS NULL
       AND f.active_version_id IS NOT NULL
  $$;

REVOKE ALL ON FUNCTION app.resolve_public_form(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_public_form(text) TO workeasy_public;

-- Column-level reads only; row security still limits them to the resolved tenant.
GRANT SELECT (id, tenant_id, slug, state, active_version_id, deleted_at) ON app.forms TO workeasy_public;
GRANT SELECT (id, tenant_id, form_id, version_number, public_projection) ON app.form_versions TO workeasy_public;
