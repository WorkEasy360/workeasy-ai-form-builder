-- PAR-04: spam protection without a third-party CAPTCHA.
--
-- When on (the default), intake refuses a submission whose hidden honeypot
-- field was filled in, or that arrives less than two seconds after its
-- session was opened: both are typical of bots and never of people.
-- Refused submissions store nothing.

ALTER TABLE app.form_access_policies ADD COLUMN spam_protection boolean NOT NULL DEFAULT true;

-- Intake (the public role) reads it with the rest of the policy.
GRANT SELECT (spam_protection) ON app.form_access_policies TO workeasy_public;
