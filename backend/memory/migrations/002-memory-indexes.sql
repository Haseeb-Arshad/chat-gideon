CREATE INDEX IF NOT EXISTS events_scope_received_idx
  ON gideon_memory.events (scope_id, received_at DESC);

CREATE INDEX IF NOT EXISTS assertions_scope_subject_idx
  ON gideon_memory.assertions (scope_id, subject_key, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS assertions_scalar_slot_idx
  ON gideon_memory.assertions (scope_id, subject_key, slot_id)
  WHERE slot_cardinality = 'scalar' AND slot_id IS NOT NULL AND current_status <> 'deleted';

CREATE INDEX IF NOT EXISTS assertion_versions_scope_status_idx
  ON gideon_memory.assertion_versions (scope_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON gideon_memory.jobs (state, available_at, lease_until, created_at);

CREATE INDEX IF NOT EXISTS jobs_scope_state_idx
  ON gideon_memory.jobs (scope_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS suppressions_event_idx
  ON gideon_memory.deletion_suppressions (scope_id, event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS suppressions_assertion_idx
  ON gideon_memory.deletion_suppressions (scope_id, assertion_id, assertion_revision)
  WHERE assertion_id IS NOT NULL;
