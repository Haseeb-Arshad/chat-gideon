-- Stage 10: background learning decisions, per-user learning budgets and the
-- change kinds learning can publish. Decisions store reason codes and
-- identifiers only, never extracted or source text; they cascade away with
-- their source event when a deletion is purged.

ALTER TABLE gideon_memory.change_feed DROP CONSTRAINT IF EXISTS change_feed_change_kind_check;
ALTER TABLE gideon_memory.change_feed ADD CONSTRAINT change_feed_change_kind_check
  CHECK (change_kind IN ('remembered', 'corrected', 'temporary_exception', 'learned', 'promoted', 'retired'));

CREATE TABLE IF NOT EXISTS gideon_memory.learning_decisions (
  decision_id text PRIMARY KEY CHECK (length(decision_id) BETWEEN 1 AND 200),
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  job_id text NULL,
  event_id text NOT NULL,
  candidate_index integer NOT NULL CHECK (candidate_index BETWEEN -1 AND 63),
  extractor_id text NOT NULL CHECK (length(extractor_id) BETWEEN 1 AND 80),
  extractor_version text NOT NULL CHECK (length(extractor_version) BETWEEN 1 AND 80),
  prompt_version text NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 80),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  model text NULL CHECK (model IS NULL OR length(model) <= 160),
  action text NOT NULL CHECK (action IN ('add', 'corroborate', 'dispute', 'reject', 'skip', 'promote', 'retire')),
  reason text NOT NULL CHECK (reason ~ '^[a-z_]{1,64}$'),
  assertion_id text NULL,
  assertion_revision bigint NULL CHECK (assertion_revision IS NULL OR assertion_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, scope_id) REFERENCES gideon_memory.events(event_id, scope_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS learning_decisions_scope_created_idx
  ON gideon_memory.learning_decisions (scope_id, created_at);

CREATE TABLE IF NOT EXISTS gideon_memory.learning_budgets (
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  window_start date NOT NULL,
  jobs_used integer NOT NULL DEFAULT 0 CHECK (jobs_used >= 0),
  units_used bigint NOT NULL DEFAULT 0 CHECK (units_used >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, window_start)
);

CREATE INDEX IF NOT EXISTS jobs_kind_claim_idx
  ON gideon_memory.jobs (kind, state, available_at, created_at);
