-- Stage 11: shadow classification decisions. A shadow extractor's
-- disagreement with the extractor that actually wrote is recorded as a
-- reason code on the same identifier-only decision log; no text is stored.

ALTER TABLE gideon_memory.learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_action_check;
ALTER TABLE gideon_memory.learning_decisions ADD CONSTRAINT learning_decisions_action_check
  CHECK (action IN ('add', 'corroborate', 'dispute', 'reject', 'skip', 'promote', 'retire', 'shadow'));
