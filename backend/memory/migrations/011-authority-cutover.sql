-- Stage 15: which store is the writer for each owner during and after the
-- move from the legacy per-owner JSON file.
--
--   legacy       the JSON file is the only writer (no row means the same)
--   fenced       nobody writes; the cutover is importing and comparing
--   active       PostgreSQL is the only writer; the JSON file is a read-only
--                projection generated from it
--   rolled_back  the JSON file is the writer again, rewritten from the
--                current projection (never from a pre-cutover copy)
--
-- revision is a compare-and-set counter: every transition names the revision
-- it expects, so two operators or hosts cannot both move one owner.

CREATE TABLE IF NOT EXISTS gideon_memory.authority_cutovers (
  scope_id text PRIMARY KEY REFERENCES gideon_memory.scopes(scope_id),
  state text NOT NULL CHECK (state IN ('legacy', 'fenced', 'active', 'rolled_back')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  legacy_revision text NULL CHECK (legacy_revision IS NULL OR legacy_revision ~ '^[0-9a-f]{64}$'),
  import_id text NULL,
  expected_count integer NULL CHECK (expected_count IS NULL OR expected_count >= 0),
  imported_count integer NULL CHECK (imported_count IS NULL OR imported_count >= 0),
  quarantined_count integer NULL CHECK (quarantined_count IS NULL OR quarantined_count >= 0),
  fenced_at timestamptz NULL,
  activated_at timestamptz NULL,
  rolled_back_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
