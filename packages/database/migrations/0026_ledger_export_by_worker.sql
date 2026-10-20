-- OPS-03: on AWS the worker ships the deletion ledger (0023) to S3 every
-- minute, so a restored Aurora/RDS snapshot can be followed by a replay.
-- The worker may read the ledger (identifiers and deletion times only, no
-- content); replaying it stays owner-only.

GRANT EXECUTE ON FUNCTION app.deletion_ledger(timestamptz) TO workeasy_worker;
