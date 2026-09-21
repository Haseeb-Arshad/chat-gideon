CREATE SCHEMA IF NOT EXISTS gideon_memory;

CREATE TABLE IF NOT EXISTS gideon_memory.principals (
  principal_id text PRIMARY KEY,
  principal_kind text NOT NULL CHECK (principal_kind IN ('anonymous', 'user', 'service')),
  trust text NOT NULL CHECK (trust IN ('authenticated', 'ephemeral')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gideon_memory.scopes (
  scope_id text PRIMARY KEY,
  scope_kind text NOT NULL CHECK (scope_kind IN ('account', 'project', 'conversation', 'task', 'global')),
  parent_scope_id text NULL REFERENCES gideon_memory.scopes(scope_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gideon_memory.grants (
  grant_id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES gideon_memory.principals(principal_id),
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  actions jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array'),
  issued_by text NOT NULL CHECK (issued_by = 'server_policy'),
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gideon_memory.policy_epochs (
  scope_id text PRIMARY KEY REFERENCES gideon_memory.scopes(scope_id),
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gideon_memory.events (
  event_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  principal_id text NOT NULL REFERENCES gideon_memory.principals(principal_id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  subject_kind text NOT NULL CHECK (subject_kind IN ('known', 'unresolved')),
  subject_id text NULL,
  subject_label text NULL,
  source_kind text NOT NULL,
  source_authority_kind text NOT NULL,
  committed_phase text NOT NULL CHECK (committed_phase IN ('committed', 'corrected', 'retracted')),
  event_sequence bigint NOT NULL CHECK (event_sequence >= 0),
  received_at timestamptz NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, scope_id),
  UNIQUE (scope_id, idempotency_key),
  UNIQUE (scope_id, event_sequence),
  CHECK (
    (subject_kind = 'known' AND subject_id IS NOT NULL AND subject_label IS NULL)
    OR (subject_kind = 'unresolved' AND subject_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS gideon_memory.receipts (
  receipt_id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES gideon_memory.events(event_id),
  state text NOT NULL CHECK (state IN ('captured', 'accepted', 'indexed', 'pending', 'failed')),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id)
);

CREATE TABLE IF NOT EXISTS gideon_memory.assertions (
  assertion_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('known', 'unresolved')),
  subject_key text NOT NULL,
  slot_id text NULL,
  slot_cardinality text NULL CHECK (slot_cardinality IN ('scalar', 'set', 'event')),
  current_revision bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  current_status text NOT NULL CHECK (current_status IN ('candidate', 'accepted', 'disputed', 'superseded', 'retracted', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id, assertion_id),
  CHECK ((slot_id IS NULL AND slot_cardinality IS NULL) OR (slot_id IS NOT NULL AND slot_cardinality IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS gideon_memory.assertion_versions (
  assertion_id text NOT NULL REFERENCES gideon_memory.assertions(assertion_id),
  revision bigint NOT NULL CHECK (revision >= 1),
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  version_hash text NOT NULL CHECK (version_hash ~ '^[0-9a-f]{64}$'),
  version jsonb NOT NULL CHECK (jsonb_typeof(version) = 'object'),
  status text NOT NULL CHECK (status IN ('candidate', 'accepted', 'disputed', 'superseded', 'retracted', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assertion_id, revision),
  UNIQUE (scope_id, assertion_id, revision),
  FOREIGN KEY (scope_id, assertion_id) REFERENCES gideon_memory.assertions(scope_id, assertion_id)
);

CREATE TABLE IF NOT EXISTS gideon_memory.evidence_edges (
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  assertion_id text NOT NULL,
  assertion_revision bigint NOT NULL,
  event_id text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('supports', 'contradicts', 'derived_from')),
  source_span jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, assertion_id, assertion_revision, event_id, relation),
  FOREIGN KEY (scope_id, assertion_id, assertion_revision)
    REFERENCES gideon_memory.assertion_versions(scope_id, assertion_id, revision),
  FOREIGN KEY (event_id, scope_id) REFERENCES gideon_memory.events(event_id, scope_id)
);

CREATE TABLE IF NOT EXISTS gideon_memory.dependency_edges (
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  assertion_id text NOT NULL,
  assertion_revision bigint NOT NULL,
  dependency_type text NOT NULL CHECK (dependency_type IN ('event', 'assertion', 'projection', 'source')),
  dependency_id text NOT NULL,
  dependency_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, assertion_id, assertion_revision, dependency_type, dependency_id, dependency_revision),
  FOREIGN KEY (scope_id, assertion_id, assertion_revision)
    REFERENCES gideon_memory.assertion_versions(scope_id, assertion_id, revision)
);

CREATE TABLE IF NOT EXISTS gideon_memory.projections (
  projection_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  input_versions jsonb NOT NULL CHECK (jsonb_typeof(input_versions) = 'array'),
  covered_sequence_from bigint NOT NULL CHECK (covered_sequence_from >= 0),
  covered_sequence_to bigint NOT NULL CHECK (covered_sequence_to >= covered_sequence_from),
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  generation text NOT NULL,
  freshness text NOT NULL CHECK (freshness IN ('fresh', 'stale', 'expired')),
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (projection_id, scope_id)
);

CREATE TABLE IF NOT EXISTS gideon_memory.projection_members (
  projection_id text NOT NULL REFERENCES gideon_memory.projections(projection_id) ON DELETE CASCADE,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  assertion_id text NOT NULL,
  assertion_revision bigint NOT NULL,
  visible_rank integer NULL CHECK (visible_rank IS NULL OR visible_rank >= 0),
  PRIMARY KEY (projection_id, assertion_id, assertion_revision),
  FOREIGN KEY (scope_id, assertion_id, assertion_revision)
    REFERENCES gideon_memory.assertion_versions(scope_id, assertion_id, revision),
  FOREIGN KEY (projection_id, scope_id)
    REFERENCES gideon_memory.projections(projection_id, scope_id)
);

CREATE TABLE IF NOT EXISTS gideon_memory.jobs (
  job_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  principal_id text NOT NULL REFERENCES gideon_memory.principals(principal_id),
  input_event_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('interpret_event', 'rebuild_projection')),
  state text NOT NULL CHECK (state IN ('pending', 'running', 'retry', 'completed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 1000),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL,
  lease_until timestamptz NULL,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  worker_id text NULL,
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  last_failure_code text NULL,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (input_event_id, kind),
  FOREIGN KEY (input_event_id, scope_id)
    REFERENCES gideon_memory.events(event_id, scope_id)
);

CREATE TABLE IF NOT EXISTS gideon_memory.slot_locks (
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  slot_id text NOT NULL,
  cardinality text NOT NULL CHECK (cardinality IN ('scalar', 'set', 'event')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, slot_id)
);

CREATE TABLE IF NOT EXISTS gideon_memory.deletion_suppressions (
  suppression_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  event_id text NULL,
  assertion_id text NULL,
  assertion_revision bigint NULL,
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  deletion_epoch bigint NOT NULL CHECK (deletion_epoch >= 0),
  reason text NOT NULL CHECK (reason IN ('user_forget', 'grant_revoked', 'retention_expired', 'recovery_replay')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (event_id IS NOT NULL AND assertion_id IS NULL AND assertion_revision IS NULL)
    OR (event_id IS NULL AND assertion_id IS NOT NULL AND assertion_revision IS NOT NULL AND assertion_revision >= 1)
  ),
  FOREIGN KEY (event_id, scope_id) REFERENCES gideon_memory.events(event_id, scope_id),
  FOREIGN KEY (scope_id, assertion_id, assertion_revision)
    REFERENCES gideon_memory.assertion_versions(scope_id, assertion_id, revision)
);
