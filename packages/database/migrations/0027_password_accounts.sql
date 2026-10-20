-- Email and password sign-in, alongside OpenID Connect. A password account is
-- an ordinary user whose identity is (issuer 'urn:workeasy:password',
-- subject = the normalized email); only a scrypt hash of the password is kept.

CREATE TABLE app.password_credentials (
  user_id       uuid PRIMARY KEY REFERENCES app.users (id),
  email         text NOT NULL UNIQUE CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 20 AND 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER password_credentials_set_updated_at BEFORE UPDATE ON app.password_credentials
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE app.password_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.password_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY credentials_self ON app.password_credentials
  USING (user_id = app.current_app_user_id())
  WITH CHECK (user_id = app.current_app_user_id());
CREATE POLICY credentials_lookup ON app.password_credentials FOR SELECT TO workeasy_owner USING (true);

-- Sign-in looks the account up before any context exists; like
-- find_user_id_by_identity (0002) this runs as the owner and returns the minimum.
CREATE FUNCTION app.find_password_credential(p_email text)
  RETURNS TABLE (user_id uuid, password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = app, pg_temp
  AS $$ SELECT c.user_id, c.password_hash FROM app.password_credentials c WHERE c.email = p_email $$;

REVOKE ALL ON FUNCTION app.find_password_credential(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_password_credential(text) TO workeasy_api;
GRANT SELECT, INSERT, UPDATE ON app.password_credentials TO workeasy_api;
