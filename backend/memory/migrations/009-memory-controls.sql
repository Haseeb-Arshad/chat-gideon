-- Stage 12: user memory controls.
--
-- memory_settings holds per-scope, server-enforced choices. It is versioned
-- so a stale settings tab cannot silently overwrite a newer choice.
--   learning_enabled   false stops background learning from new and queued
--                      turns; it does not delete anything.
--   temporary_until    while in the future, turns are not captured, nothing
--                      is saved or recalled; it deletes nothing that exists.
--   evidence_retention_days  raw conversation turns that never became a
--                      memory are deleted after this many days; NULL keeps
--                      them until the user deletes them.

CREATE TABLE IF NOT EXISTS gideon_memory.memory_settings (
  scope_id text PRIMARY KEY REFERENCES gideon_memory.scopes(scope_id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  learning_enabled boolean NOT NULL DEFAULT true,
  temporary_until timestamptz NULL,
  evidence_retention_days integer NULL CHECK (evidence_retention_days IS NULL OR evidence_retention_days IN (30, 90, 365)),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Retention deletes source events that no memory cites, so its deletion plan
-- and operation have no assertion target. Forget operations keep requiring one.
ALTER TABLE gideon_memory.deletion_plans
  ALTER COLUMN target_assertion_id DROP NOT NULL,
  ALTER COLUMN target_revision DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS operation_kind text NOT NULL DEFAULT 'forget';
ALTER TABLE gideon_memory.deletion_plans DROP CONSTRAINT IF EXISTS deletion_plans_kind_target_check;
ALTER TABLE gideon_memory.deletion_plans ADD CONSTRAINT deletion_plans_kind_target_check CHECK (
  (operation_kind = 'forget' AND target_assertion_id IS NOT NULL AND target_revision IS NOT NULL)
  OR (operation_kind = 'retention' AND target_assertion_id IS NULL AND target_revision IS NULL)
);

ALTER TABLE gideon_memory.deletion_operations
  ALTER COLUMN target_assertion_id DROP NOT NULL,
  ALTER COLUMN target_revision DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS operation_kind text NOT NULL DEFAULT 'forget';
ALTER TABLE gideon_memory.deletion_operations DROP CONSTRAINT IF EXISTS deletion_operations_kind_target_check;
ALTER TABLE gideon_memory.deletion_operations ADD CONSTRAINT deletion_operations_kind_target_check CHECK (
  (operation_kind = 'forget' AND target_assertion_id IS NOT NULL AND target_revision IS NOT NULL)
  OR (operation_kind = 'retention' AND target_assertion_id IS NULL AND target_revision IS NULL)
);

CREATE INDEX IF NOT EXISTS events_scope_kind_received_idx
  ON gideon_memory.events (scope_id, source_kind, received_at);
