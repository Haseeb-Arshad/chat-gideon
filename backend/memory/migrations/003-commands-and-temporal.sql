ALTER TABLE gideon_memory.assertions
  ADD COLUMN IF NOT EXISTS canonical_key text NULL;

CREATE INDEX IF NOT EXISTS assertions_scope_canonical_key_idx
  ON gideon_memory.assertions (scope_id, canonical_key)
  WHERE canonical_key IS NOT NULL AND current_status <> 'deleted';

CREATE UNIQUE INDEX IF NOT EXISTS assertions_scope_canonical_key_unique
  ON gideon_memory.assertions (scope_id, canonical_key)
  WHERE canonical_key IS NOT NULL AND current_status <> 'deleted';

CREATE TABLE IF NOT EXISTS gideon_memory.quota_limits (
  scope_id text PRIMARY KEY REFERENCES gideon_memory.scopes(scope_id),
  max_accepted_assertions integer NOT NULL CHECK (max_accepted_assertions BETWEEN 1 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gideon_memory.change_counters (
  scope_id text PRIMARY KEY REFERENCES gideon_memory.scopes(scope_id),
  next_watermark bigint NOT NULL DEFAULT 0 CHECK (next_watermark >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gideon_memory.change_feed (
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  watermark bigint NOT NULL CHECK (watermark >= 1),
  command_id text NOT NULL CHECK (length(command_id) BETWEEN 1 AND 160),
  event_id text NOT NULL,
  assertion_id text NOT NULL,
  assertion_revision bigint NOT NULL CHECK (assertion_revision >= 1),
  change_kind text NOT NULL CHECK (change_kind IN ('remembered', 'corrected', 'temporary_exception')),
  change jsonb NOT NULL CHECK (jsonb_typeof(change) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, watermark),
  UNIQUE (scope_id, command_id),
  FOREIGN KEY (event_id, scope_id) REFERENCES gideon_memory.events(event_id, scope_id),
  FOREIGN KEY (scope_id, assertion_id, assertion_revision)
    REFERENCES gideon_memory.assertion_versions(scope_id, assertion_id, revision)
);

CREATE INDEX IF NOT EXISTS change_feed_scope_watermark_idx
  ON gideon_memory.change_feed (scope_id, watermark);

CREATE TABLE IF NOT EXISTS gideon_memory.command_receipts (
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  command_id text NOT NULL CHECK (length(command_id) BETWEEN 1 AND 160),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('remember', 'correct')),
  event_id text NOT NULL,
  assertion_id text NOT NULL,
  assertion_revision bigint NOT NULL CHECK (assertion_revision >= 1),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'duplicate')),
  change_watermark bigint NULL CHECK (change_watermark IS NULL OR change_watermark >= 1),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, command_id),
  UNIQUE (scope_id, event_id),
  FOREIGN KEY (event_id, scope_id) REFERENCES gideon_memory.events(event_id, scope_id),
  FOREIGN KEY (scope_id, assertion_id, assertion_revision)
    REFERENCES gideon_memory.assertion_versions(scope_id, assertion_id, revision)
);

CREATE INDEX IF NOT EXISTS command_receipts_scope_event_idx
  ON gideon_memory.command_receipts (scope_id, event_id);
