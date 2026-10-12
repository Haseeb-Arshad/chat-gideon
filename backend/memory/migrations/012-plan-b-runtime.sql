-- Private, replaceable derivatives. Never grant the public Data API access.
CREATE TABLE gideon_memory.turn_traces (
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  turn_id text NOT NULL,
  event_id text NOT NULL,
  policy_epoch bigint NOT NULL,
  deletion_epoch bigint NOT NULL,
  question text NOT NULL CHECK (length(question) <= 4000),
  reply text NOT NULL CHECK (length(reply) <= 12000),
  context jsonb NOT NULL,
  checks jsonb NOT NULL,
  topic text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, turn_id),
  FOREIGN KEY (event_id, scope_id) REFERENCES gideon_memory.events(event_id, scope_id) ON DELETE CASCADE
);
CREATE INDEX turn_traces_scope_time_idx ON gideon_memory.turn_traces (scope_id, created_at DESC);
CREATE INDEX turn_traces_event_idx ON gideon_memory.turn_traces (event_id);
CREATE TABLE gideon_memory.knowledge_gaps (
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  question_hash text NOT NULL,
  question text NOT NULL CHECK (length(question) <= 4000),
  times_asked integer NOT NULL DEFAULT 1,
  last_asked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, question_hash)
);
CREATE TABLE gideon_memory.skill_overlays (
  overlay_id text PRIMARY KEY,
  scope_id text NOT NULL REFERENCES gideon_memory.scopes(scope_id),
  topic text NOT NULL,
  instructions jsonb NOT NULL CHECK (jsonb_typeof(instructions) = 'array'),
  source_turn_ids jsonb NOT NULL CHECK (jsonb_typeof(source_turn_ids) = 'array'),
  policy_epoch bigint NOT NULL,
  deletion_epoch bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('candidate', 'verified', 'retired')),
  evidence jsonb NOT NULL,
  verification jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_overlays_scope_state_idx ON gideon_memory.skill_overlays (scope_id, state, topic);
CREATE TABLE gideon_memory.maintenance_dispatch (
  scope_id text PRIMARY KEY REFERENCES gideon_memory.scopes(scope_id),
  dispatched_at timestamptz NOT NULL DEFAULT 'epoch',
  lease_until timestamptz NOT NULL DEFAULT 'epoch',
  completed_at timestamptz NULL,
  refined_at timestamptz NULL,
  last_failure text NULL
);
-- Metadata only: prevents unembeddable text from starving the bounded backfill.
CREATE TABLE gideon_memory.embedding_exclusions (
  scope_id text NOT NULL,
  assertion_id text NOT NULL,
  assertion_revision bigint NOT NULL,
  model_id text NOT NULL,
  model_version text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('secret', 'oversized')),
  PRIMARY KEY(scope_id, assertion_id, assertion_revision, model_id, model_version),
  FOREIGN KEY(scope_id, assertion_id, assertion_revision) REFERENCES gideon_memory.assertion_versions(scope_id, assertion_id, revision) ON DELETE CASCADE
);
-- A forget/revocation invalidates all derived answer text and learned rules in
-- that scope immediately. Source-specific FK cascade also covers retention.
CREATE FUNCTION gideon_memory.clear_plan_b_derivatives() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.policy_epoch <> OLD.policy_epoch OR NEW.deletion_epoch <> OLD.deletion_epoch THEN
    DELETE FROM gideon_memory.turn_traces WHERE scope_id = NEW.scope_id;
    DELETE FROM gideon_memory.knowledge_gaps WHERE scope_id = NEW.scope_id;
    DELETE FROM gideon_memory.skill_overlays WHERE scope_id = NEW.scope_id;
    DELETE FROM gideon_memory.embedding_exclusions WHERE scope_id = NEW.scope_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clear_plan_b_derivatives AFTER UPDATE OF policy_epoch, deletion_epoch
ON gideon_memory.policy_epochs FOR EACH ROW EXECUTE FUNCTION gideon_memory.clear_plan_b_derivatives();
REVOKE ALL ON FUNCTION gideon_memory.clear_plan_b_derivatives() FROM PUBLIC;
REVOKE ALL ON gideon_memory.turn_traces, gideon_memory.knowledge_gaps, gideon_memory.skill_overlays, gideon_memory.maintenance_dispatch FROM PUBLIC;
ALTER TABLE gideon_memory.turn_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE gideon_memory.knowledge_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE gideon_memory.skill_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE gideon_memory.maintenance_dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gideon_memory.embedding_exclusions FROM PUBLIC;
ALTER TABLE gideon_memory.embedding_exclusions ENABLE ROW LEVEL SECURITY;
-- Supabase default grants can include API roles even in a custom schema.
-- Explicitly remove inherited creation grants; tolerate plain PostgreSQL.
DO $$
DECLARE api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON gideon_memory.turn_traces, gideon_memory.knowledge_gaps, gideon_memory.skill_overlays, gideon_memory.maintenance_dispatch, gideon_memory.embedding_exclusions FROM %I',api_role);
    EXECUTE format('REVOKE ALL ON FUNCTION gideon_memory.clear_plan_b_derivatives() FROM %I',api_role);
  END LOOP;
END;
$$;
