-- ANA-01: basic aggregate analytics (docs/01 §2, docs/06 §6).
--
-- Analytics count respondent sessions, which already exist for every opened
-- form; no separate telemetry is collected and answers are never read:
--   view   = a respondent session was opened (the form page loaded and the
--            form was accepting responses);
--   start  = that session's respondent first changed an answer;
--   accept = that session's response was accepted.
-- Each is counted once per session, on the UTC day the session was opened.

ALTER TABLE app.respondent_sessions ADD COLUMN started_at timestamptz;

CREATE INDEX respondent_sessions_form_day_idx ON app.respondent_sessions (tenant_id, form_id, created_at);

-- The respondent app reports the first change once; only the time is stored.
GRANT UPDATE (started_at) ON app.respondent_sessions TO workeasy_public;

-- The console reads only whether and when a session started, for the counts.
GRANT SELECT (started_at) ON app.respondent_sessions TO workeasy_api;
