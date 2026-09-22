-- Stage 05: logical privacy blocking, grant revocation, purge work and
-- restore reconciliation. These records intentionally retain identifiers and
-- watermarks only; deleted payloads are never copied into the control plane.

ALTER TABLE gideon_memory.grants
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL;

-- A deleted assertion remains a non-content tombstone until its purge work is
-- complete. Keeping canonical_key unique across deleted rows prevents a later
-- remember command from reusing the same semantic identity.
DROP INDEX IF EXISTS gideon_memory.assertions_scope_canonical_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS assertions_scope_canonical_key_unique
  ON gideon_memory.assertions (scope_id, canonical_key)
  WHERE canonical_key IS NOT NULL;

-- Purge is allowed to remove the referenced rows while the minimal suppression
-- ledger keeps the identifier. The ledger is deliberately not a content store.
ALTER TABLE gideon_memory.deletion_suppressions
  DROP CONSTRAINT IF EXISTS deletion_suppressions_event_id_scope_id_fkey,
  DROP CONSTRAINT IF EXISTS deletion_suppressions_scope_id_assertion_id_assertion_revision_fkey;

DO $$
DECLARE
  constraint_name text;
BEGIN
  -- PostgreSQL truncates long generated constraint names. Drop every legacy
  -- foreign key on this minimal tombstone table without relying on that name.
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'gideon_memory.deletion_suppressions'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE gideon_memory.deletion_suppressions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS gideon_memory.deletion_plans (
  plan_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  actor_principal_id text NOT NULL REFERENCES gideon_memory.principals(principal_id),
  target_assertion_id text NOT NULL,
  target_revision bigint NOT NULL CHECK (target_revision >= 1),
  planned_policy_epoch bigint NOT NULL CHECK (planned_policy_epoch >= 0),
  planned_deletion_epoch bigint NOT NULL CHECK (planned_deletion_epoch >= 0),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('planned', 'committed', 'expired', 'rejected')),
  deletion_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS deletion_plans_scope_status_idx
  ON gideon_memory.deletion_plans (scope_id, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS deletion_suppressions_event_unique
  ON gideon_memory.deletion_suppressions (scope_id, event_id)
  WHERE event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS deletion_suppressions_assertion_unique
  ON gideon_memory.deletion_suppressions (scope_id, assertion_id, assertion_revision)
  WHERE assertion_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gideon_memory.deletion_operations (
  deletion_id text PRIMARY KEY,
  plan_id text NOT NULL UNIQUE REFERENCES gideon_memory.deletion_plans(plan_id),
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  actor_principal_id text NOT NULL REFERENCES gideon_memory.principals(principal_id),
  target_assertion_id text NOT NULL,
  target_revision bigint NOT NULL CHECK (target_revision >= 1),
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  status text NOT NULL CHECK (status IN ('logical_blocked', 'purge_pending', 'purged', 'failed')),
  reuse_blocked boolean NOT NULL DEFAULT true,
  logical_blocked_at timestamptz NOT NULL,
  purge_started_at timestamptz NULL,
  purge_completed_at timestamptz NULL,
  backup_retention_limit_days integer NULL CHECK (backup_retention_limit_days IS NULL OR backup_retention_limit_days >= 0),
  external_copy_status text NOT NULL DEFAULT 'not_controlled'
    CHECK (external_copy_status IN ('not_controlled', 'bounded_by_adapter')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deletion_operations_scope_status_idx
  ON gideon_memory.deletion_operations (scope_id, status, logical_blocked_at DESC);

CREATE TABLE IF NOT EXISTS gideon_memory.purge_tasks (
  purge_task_id text PRIMARY KEY,
  deletion_id text NOT NULL REFERENCES gideon_memory.deletion_operations(deletion_id),
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  kind text NOT NULL CHECK (kind IN ('source_event', 'assertion_version', 'projection', 'change_feed', 'command_receipt', 'job', 'managed_cache')),
  target_id text NOT NULL,
  target_revision bigint NOT NULL DEFAULT 0 CHECK (target_revision >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'retry', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 100),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at timestamptz NOT NULL,
  lease_until timestamptz NULL,
  last_failure text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deletion_id, kind, target_id, target_revision)
);

CREATE INDEX IF NOT EXISTS purge_tasks_claim_idx
  ON gideon_memory.purge_tasks (status, available_at, created_at);

CREATE INDEX IF NOT EXISTS purge_tasks_deletion_idx
  ON gideon_memory.purge_tasks (deletion_id, status, kind);

CREATE TABLE IF NOT EXISTS gideon_memory.control_ledger (
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  ledger_sequence bigint NOT NULL CHECK (ledger_sequence >= 1),
  operation_id text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('deletion', 'grant_revocation')),
  deletion_id text NULL,
  revocation_id text NULL,
  event_id text NULL,
  assertion_id text NULL,
  assertion_revision bigint NULL CHECK (assertion_revision IS NULL OR assertion_revision >= 1),
  grant_id text NULL,
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, ledger_sequence),
  CHECK (
    (operation_kind = 'deletion'
      AND deletion_id IS NOT NULL
      AND revocation_id IS NULL
      AND grant_id IS NULL
      AND ((event_id IS NOT NULL AND assertion_id IS NULL AND assertion_revision IS NULL)
        OR (event_id IS NULL AND assertion_id IS NOT NULL AND assertion_revision IS NOT NULL)))
    OR
    (operation_kind = 'grant_revocation'
      AND deletion_id IS NULL
      AND revocation_id IS NOT NULL
      AND grant_id IS NOT NULL
      AND event_id IS NULL
      AND assertion_id IS NULL
      AND assertion_revision IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS control_ledger_operation_target_idx
  ON gideon_memory.control_ledger (scope_id, operation_id, event_id, assertion_id, assertion_revision, grant_id);

CREATE TABLE IF NOT EXISTS gideon_memory.grant_revocations (
  revocation_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  actor_principal_id text NOT NULL REFERENCES gideon_memory.principals(principal_id),
  grant_id text NOT NULL,
  previous_policy_epoch bigint NOT NULL CHECK (previous_policy_epoch >= 0),
  new_policy_epoch bigint NOT NULL CHECK (new_policy_epoch > previous_policy_epoch),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id, grant_id, new_policy_epoch)
);

CREATE TABLE IF NOT EXISTS gideon_memory.recovery_guards (
  scope_id text PRIMARY KEY REFERENCES gideon_memory.scopes(scope_id),
  status text NOT NULL CHECK (status IN ('ready', 'blocked')),
  required_ledger_sequence bigint NOT NULL DEFAULT 0 CHECK (required_ledger_sequence >= 0),
  reconciled_ledger_sequence bigint NOT NULL DEFAULT 0 CHECK (reconciled_ledger_sequence >= 0),
  reason text NULL,
  blocked_at timestamptz NULL,
  reconciled_at timestamptz NULL,
  CHECK (reconciled_ledger_sequence <= required_ledger_sequence OR status = 'ready')
);

CREATE TABLE IF NOT EXISTS gideon_memory.snapshot_leases (
  lease_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  principal_id text NOT NULL REFERENCES gideon_memory.principals(principal_id),
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  invalidated_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS snapshot_leases_scope_status_idx
  ON gideon_memory.snapshot_leases (scope_id, status, expires_at);

-- This table is intentionally adapter-owned. It gives the purge worker a
-- concrete managed-cache target without pretending to control browser caches,
-- provider logs, or arbitrary exported copies.
CREATE TABLE IF NOT EXISTS gideon_memory.managed_cache_entries (
  entry_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  principal_id text NOT NULL REFERENCES gideon_memory.principals(principal_id),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  data_watermark bigint NOT NULL DEFAULT 0 CHECK (data_watermark >= 0),
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS managed_cache_entries_scope_idx
  ON gideon_memory.managed_cache_entries (scope_id, principal_id, expires_at);
