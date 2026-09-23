# ChatGideon memory PostgreSQL authority

This directory is a Node-only Stage 03 backend. It is intentionally not imported
by `backend/worker/src/server.ts`, `src/lib/memory/index.ts`, or any browser
entry point. The existing app and Worker memory routes remain unchanged until a
later integration stage explicitly enables the new authority.

## Local disposable verification

`npm run memory:postgres:test` searches for local `initdb` and `pg_ctl`, creates
a temporary PostgreSQL cluster with a temporary port, runs the real database
tests, stops the cluster, and removes only that generated temporary directory.
The command sets `GIDEON_MEMORY_POSTGRES_TEST=1` and an owned local test URL for
its child process. It never reads the existing service password and never uses a
remote URL.

An externally managed test database is accepted only when all of these are
explicitly set by the operator:

```powershell
$env:GIDEON_MEMORY_POSTGRES_TEST = '1'
$env:MEMORY_TEST_DATABASE_OWNED = '1'
$env:MEMORY_TEST_DATABASE_URL = 'postgresql://gideon_test:password@127.0.0.1:5432/gideon_memory_test'
npm run memory:postgres:test
```

The test harness rejects non-local URLs and resets only the dedicated
`gideon_memory` schema. Do not point it at a customer or production database.

## Server configuration and migrations

The adapter reads `GIDEON_MEMORY_DATABASE_URL` and bounded pool settings. The
URL is server-only and must not be placed in client variables or Wrangler
`vars`. Status is read-only; migration requires an explicit local command:

```powershell
$env:GIDEON_MEMORY_DATABASE_URL = 'postgresql://gideon_memory:password@127.0.0.1:5432/gideon_memory'
npm run memory:postgres:status
$env:GIDEON_MEMORY_MIGRATE = '1'
npm run memory:postgres:migrate
```

Remote migration additionally requires `GIDEON_MEMORY_ALLOW_REMOTE=1`; this
stage does not authorize production migration. A missing database is reported
as `unavailable`, never as an empty memory corpus.

The schema is isolated under `gideon_memory` and is applied in filename order:

- `migrations/001-memory-authority.sql`: principals, scopes, grants, epochs,
  events, receipts, assertion versions, evidence/dependencies, projections,
  jobs, slot locks, and deletion suppressions.
- `migrations/002-memory-indexes.sql`: scoped reads, scalar-slot uniqueness,
  bounded job claims, and suppression indexes.
- `migrations/003-commands-and-temporal.sql`: deterministic command identity,
  per-scope quota admission, accepted command receipts, and monotonic accepted
  change-feed watermarks.
- `migrations/004-deletion-revocation.sql`: durable deletion plans, source and
  assertion suppression, purge work, grant revocation, and epoch advancement.
- `migrations/005-retrieval-embeddings.sql`: scoped, revision-bound vector
  metadata and exact embeddings without duplicated source text, plus bounded
  full-text search indexes. This migration is local/test-only in Stage 08; it
  has not been run against staging or production.
- `migrations/006-tombstone-canonical-keys.sql`: removes the content-derived
  canonical key from deleted tombstones (post-audit privacy repair).
- `migrations/007-background-learning.sql`: Stage 10 reason-code-only learning
  decisions, per-user learning budgets and learned/promoted change kinds.
  Migrations 006–007 have only been applied to the owned disposable harness.

## Background learning and maintenance (Stage 10)

`runMemoryMaintenance()` does a bounded amount of work per tick in priority
order: physical purge, coalesced warm-view rebuilds, budgeted learning from
committed user turns (at most two jobs per user per tick, interpretation jobs
settle 15 s so same-turn explicit commands land first), then promotion or
retirement of inferred candidates. The Node adapter starts it once per process
when `GIDEON_MEMORY_BACKGROUND_ENABLED=1`; learning additionally needs
`GIDEON_MEMORY_LEARNING_ENABLED=1` and the owner's rollout cohort. The default
extractor is the local rule extractor. The paid model extractor needs both
`GIDEON_MEMORY_EXTRACTOR=model` and `GIDEON_MEMORY_EXTRACTOR_REMOTE_ALLOWED=1`.

To disable: unset `GIDEON_MEMORY_LEARNING_ENABLED` (queued turns are closed as
`learning_disabled`, not learned later) or `GIDEON_MEMORY_BACKGROUND_ENABLED`
(nothing runs; queued jobs wait). Learned memories are ordinary assertions:
forget them like any other; do not drop tables to roll back.

## Explicit command boundary

`backend/memory/src/commands.ts` is the Stage 04 Node-only command adapter.
`executeExplicitCommand()` accepts a public `remember` or `correct` command
only after `bindMemoryCommand()` derives authority from an authenticated server
session. Corrections require an exact assertion ID and revision; callers may
also pin the source revision. `executeScopedException()` creates a separate
temporary assertion with explicit conditions and an expiry, so it does not
rewrite a global preference.

An accepted command commits its event, assertion version/evidence, accepted
receipt, change-feed watermark, projection invalidation job, and command retry
record in one transaction. A repeated command ID returns the stored result;
formatting-equivalent `remember` commands are deterministic no-ops and do not
create a second semantic effect. `readCurrentAssertion()`,
`readAssertionAsOf()` and `readAcceptedChangeOverlay()` distinguish current,
known-at-time, valid-at-time, and accepted-overlay reads. No captured-only
event appears in the accepted overlay.

The command quota is explicit: a full scope returns `budget_exhausted` and
does not evict or falsely acknowledge an accepted assertion. The default limit
is bounded by `DEFAULT_MEMORY_ACCEPTED_ASSERTION_QUOTA`; an operator may set a
smaller synthetic-test limit in the owned local database. Stage 04 does not
implement privacy deletion or grant revocation; those remain Stage 05.

The capture transaction validates the server-bound session and consent, checks
the database grant and policy epoch, inserts the event, durable captured receipt,
and interpretation job in one transaction, and handles same-key/different-
content as a conflict. Claims use `FOR UPDATE SKIP LOCKED`, bounded leases,
attempt counters, and monotonically increasing fences. Model/provider work is
performed by the injected handler outside the database transaction; completion
rechecks the lease fence, policy/deletion epochs, source suppression, and input
scope before committing an assertion.
