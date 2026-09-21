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

The capture transaction validates the server-bound session and consent, checks
the database grant and policy epoch, inserts the event, durable captured receipt,
and interpretation job in one transaction, and handles same-key/different-
content as a conflict. Claims use `FOR UPDATE SKIP LOCKED`, bounded leases,
attempt counters, and monotonically increasing fences. Model/provider work is
performed by the injected handler outside the database transaction; completion
rechecks the lease fence, policy/deletion epochs, source suppression, and input
scope before committing an assertion.
