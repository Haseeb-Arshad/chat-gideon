-- Stage 08: versioned exact-vector records over accepted, authorized source
-- material. Embeddings are replaceable derivatives and contain no source text.

CREATE TABLE IF NOT EXISTS gideon_memory.retrieval_embeddings (
  scope_id text NOT NULL,
  assertion_id text NOT NULL,
  assertion_revision bigint NOT NULL CHECK (assertion_revision >= 1),
  source_kind text NOT NULL CHECK (source_kind IN ('assertion', 'episode', 'evidence')),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  source_event_id text NULL,
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 160),
  model_version text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 120),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  embedding jsonb NOT NULL CHECK (
    jsonb_typeof(embedding) = 'array'
    AND jsonb_array_length(embedding) = dimensions
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, assertion_id, assertion_revision, source_kind, source_ref, model_id, model_version),
  FOREIGN KEY (scope_id, assertion_id, assertion_revision)
    REFERENCES gideon_memory.assertion_versions(scope_id, assertion_id, revision)
    ON DELETE CASCADE,
  FOREIGN KEY (source_event_id, scope_id)
    REFERENCES gideon_memory.events(event_id, scope_id)
    ON DELETE CASCADE,
  CHECK (
    (source_kind = 'evidence' AND source_event_id IS NOT NULL)
    OR (source_kind IN ('assertion', 'episode') AND source_event_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS retrieval_embeddings_scope_model_idx
  ON gideon_memory.retrieval_embeddings
    (scope_id, model_id, model_version, dimensions, created_at DESC);

CREATE INDEX IF NOT EXISTS retrieval_embeddings_version_idx
  ON gideon_memory.retrieval_embeddings
    (scope_id, assertion_id, assertion_revision);

CREATE INDEX IF NOT EXISTS retrieval_assertion_payload_fts_idx
  ON gideon_memory.assertion_versions
  USING GIN (to_tsvector('simple', COALESCE(version->'payload', '{}'::jsonb)::text));

CREATE INDEX IF NOT EXISTS retrieval_committed_user_source_fts_idx
  ON gideon_memory.events
  USING GIN (to_tsvector('simple', COALESCE(envelope->'payload', '{}'::jsonb)::text || ' ' || COALESCE(envelope->'sourceSpans', '[]'::jsonb)::text))
  WHERE source_kind IN ('user_statement', 'user_correction');
