-- Stage 14: indexes the load workload showed were missing.
--
-- Source-evidence retrieval asks, for each candidate turn, whether an
-- accepted memory already cites it and whether an explicit command came from
-- the same turn. Without these, both were scans per candidate, and one owner
-- with a few hundred turns took over ten seconds per lookup.

CREATE INDEX IF NOT EXISTS evidence_edges_event_idx
  ON gideon_memory.evidence_edges (scope_id, event_id, relation);

CREATE INDEX IF NOT EXISTS events_source_document_idx
  ON gideon_memory.events (scope_id, (envelope #>> '{sourceSpans,0,document,sourceId}'))
  WHERE envelope #>> '{sourceSpans,0,document,sourceId}' IS NOT NULL;

-- Lexical search computed a text vector for every row of the owner's memory
-- and turns on each lookup. These match the retrieval expressions exactly, so
-- the planner can use them instead.
CREATE INDEX IF NOT EXISTS assertion_versions_lexical_idx
  ON gideon_memory.assertion_versions
  USING gin (to_tsvector('simple', COALESCE(version->'payload', '{}'::jsonb)::text));

CREATE INDEX IF NOT EXISTS events_lexical_idx
  ON gideon_memory.events
  USING gin (to_tsvector('simple', COALESCE(envelope->'payload', '{}'::jsonb)::text || ' ' || COALESCE(envelope->'sourceSpans', '[]'::jsonb)::text));
