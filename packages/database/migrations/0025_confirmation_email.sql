-- PAR-06: confirmation email to the respondent (Zoho parity).
--
-- A form can email each respondent at the address they gave in one of its
-- email questions. It is an integration of kind 'confirmation', delivered
-- like the others (durable job, retries, attempt history). The message is
-- plain text written by the form's owners; respondents control only the
-- recipient, never the content. To stop the feature being used to flood an
-- inbox, the worker sends at most a few confirmations per address per day
-- across the organization, and caps each form's hourly volume. It counts
-- by recipient_hash, a SHA-256 of the normalized address, so deliveries
-- keep no further copy of the address.

ALTER TABLE app.integrations DROP CONSTRAINT integrations_kind_check;
ALTER TABLE app.integrations ADD CONSTRAINT integrations_kind_check CHECK (kind IN ('webhook', 'email', 'confirmation'));

ALTER TABLE app.integrations
  ADD COLUMN recipient_field_id text CHECK (recipient_field_id ~ '^[A-Za-z][A-Za-z0-9_-]{1,79}$'),
  ADD COLUMN subject text CHECK (char_length(subject) BETWEEN 1 AND 150),
  ADD COLUMN message text CHECK (char_length(message) BETWEEN 1 AND 4000);

ALTER TABLE app.integrations DROP CONSTRAINT integrations_shape;
ALTER TABLE app.integrations ADD CONSTRAINT integrations_shape CHECK (
  CASE kind
    WHEN 'webhook' THEN url IS NOT NULL AND secret_ciphertext IS NOT NULL AND recipients IS NULL
      AND recipient_field_id IS NULL AND subject IS NULL AND message IS NULL
    WHEN 'email' THEN url IS NULL AND secret_ciphertext IS NULL AND recipients IS NOT NULL AND field_ids = '{}'
      AND recipient_field_id IS NULL AND subject IS NULL AND message IS NULL
    ELSE url IS NULL AND secret_ciphertext IS NULL AND recipients IS NULL AND field_ids = '{}'
      AND recipient_field_id IS NOT NULL AND subject IS NOT NULL AND message IS NOT NULL
  END);

ALTER TABLE app.deliveries ADD COLUMN recipient_hash bytea CHECK (octet_length(recipient_hash) = 32);
CREATE INDEX deliveries_recipient_idx ON app.deliveries (tenant_id, recipient_hash, created_at) WHERE recipient_hash IS NOT NULL;
