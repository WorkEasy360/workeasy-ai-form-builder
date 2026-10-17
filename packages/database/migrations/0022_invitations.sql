-- PAR-05: organization members and invitation links.
--
-- Owners and admins create a single-use link for a role; only a SHA-256 hash
-- of its token is stored. Links expire and can be revoked. The email address
-- is a label for the inviter only.

CREATE TABLE app.invitations (
  id          uuid NOT NULL DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants (id),
  email       text CHECK (char_length(email) <= 254),
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'creator', 'analyst', 'approver')),
  token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_by  uuid NOT NULL REFERENCES app.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_by uuid REFERENCES app.users (id),
  accepted_at timestamptz,
  revoked_at  timestamptz,
  PRIMARY KEY (id),
  CONSTRAINT invitations_outcome CHECK ((accepted_at IS NULL) = (accepted_by IS NULL) AND NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX invitations_tenant_idx ON app.invitations (tenant_id, created_at DESC);

ALTER TABLE app.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.invitations
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Before joining, the invitee has no tenant context. Like resolve_public_form,
-- this read-only lookup only says which organization an open link belongs
-- to; accepting then happens in that organization's context.
CREATE POLICY invitation_lookup ON app.invitations FOR SELECT TO workeasy_owner USING (true);

CREATE FUNCTION app.resolve_invitation(p_token_hash bytea)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$
    SELECT i.tenant_id FROM app.invitations i
     WHERE i.token_hash = p_token_hash
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  $$;

REVOKE ALL ON FUNCTION app.resolve_invitation(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_invitation(bytea) TO workeasy_api;

GRANT SELECT, INSERT ON app.invitations TO workeasy_api;
GRANT UPDATE (accepted_by, accepted_at, revoked_at) ON app.invitations TO workeasy_api;
