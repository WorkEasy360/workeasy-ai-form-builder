-- AI-02: accepting or rejecting an AI proposal (docs/03 §4).
--
-- A succeeded generation's proposal is decided once: applied to the draft
-- (as a normal optimistic draft save against the revision it was built on)
-- or rejected. The decision, who made it and, when applied, the draft
-- revision it produced are recorded here; the proposal itself is kept for
-- the record. Applying never publishes.

ALTER TABLE app.ai_generations
  ADD COLUMN decision         text CHECK (decision IN ('applied', 'rejected')),
  ADD COLUMN decided_by       uuid REFERENCES app.users (id),
  ADD COLUMN decided_at       timestamptz,
  ADD COLUMN applied_revision integer CHECK (applied_revision >= 2),
  ADD CONSTRAINT ai_generations_decision CHECK (
    (decision IS NULL AND decided_by IS NULL AND decided_at IS NULL AND applied_revision IS NULL)
    OR (decision IS NOT NULL AND status = 'succeeded' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND (decision = 'applied') = (applied_revision IS NOT NULL)));

GRANT UPDATE (decision, decided_by, decided_at, applied_revision) ON app.ai_generations TO workeasy_api;
