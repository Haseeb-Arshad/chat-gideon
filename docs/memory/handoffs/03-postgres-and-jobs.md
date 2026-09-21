# Stage 03 handoff: transactional PostgreSQL authority, outbox, and fenced worker

Status: LOCAL_VERIFIED
Implementation commit or working-tree identifier: commit `feat: establish transactional memory authority` on `fix/reliability-and-memory-isolation`; verify the final hash with `git log -1`.
Date: 2026-09-21
Environment: Windows 10.0.19045 x64, Node v22.13.0, npm 11.0.0, PostgreSQL 17.5 disposable local cluster, Vitest 4.1.5; no customer or remote database

## Prerequisite evidence

- Re-read `docs/memory/implementation/00-COMMON-INSTRUCTIONS.md`, the Stage 03 prompt, the foundation storage/concurrency rules, `handoffs/01-baseline-and-receipts.md`, and `handoffs/02-contracts-and-identity.md`.
- Reverified the clean pushed feature branch before implementation. Stage 01 and Stage 02 are `LOCAL_VERIFIED` and remain pushed under the existing `fix/reliability-and-memory-isolation` branch.
- Confirmed the edge-safe contract entry point remains separate from the new Node-only backend. The existing Worker/Durable Object/Supabase memory paths were not rewired.
- A PostgreSQL 17 Windows service exists locally, but its password was not used. The acceptance tests instead create a temporary trust-authenticated PostgreSQL cluster with `initdb`, use a temporary port, then stop and remove that generated cluster.

## Implemented behavior

- Added a canonical PostgreSQL schema under `gideon_memory` for principals,
  scopes, server grants, policy/deletion epochs, committed events, durable
  receipts, assertion records and versions, evidence/dependency edges,
  projections/members, jobs, scalar-slot locks, and deletion suppressions.
- Added composite scope-aware foreign keys and uniqueness constraints for
  event idempotency, event sequence, assertion revisions, scalar slots, job
  states and source references.
- Added a scope-bound Node adapter implementing the Stage 02 storage
  capabilities. It validates the authenticated session and database grant in
  the capture transaction, requires consent, and never treats an unavailable
  database as an empty corpus.
- Capture inserts the event, captured receipt, and interpretation job in one
  transaction. Repeating the same idempotency key returns the durable receipt;
  changing its content returns a typed conflict. An injected failure after the
  event insert rolls back the event, receipt and job together.
- Added bounded job claims with `FOR UPDATE SKIP LOCKED`, attempts, lease
  expiry, exponential bounded retry, dead-letter state and monotonic fencing.
  Completion occurs after the injected provider/model handler returns and
  rechecks the lease fence, scope, policy epoch, deletion epoch and source
  suppression before writing an assertion and accepted receipt.
- Added a read-only health/readiness boundary and explicit migration command
  guards. The local harness is the only default way to run the real acceptance
  suite; the existing application and Worker remain on their legacy stores.

## Source and schema map

- `backend/memory/migrations/001-memory-authority.sql`: ordered canonical
  tables and database constraints.
- `backend/memory/migrations/002-memory-indexes.sql`: scoped, scalar-slot,
  job-claim and suppression indexes.
- `backend/memory/src/config.ts`: bounded server-only configuration and local
  test/migration permission checks.
- `backend/memory/src/migrations.ts`: ordered migration application/status.
- `backend/memory/src/serialization.ts`: stable JSON hashing, subject keys and
  revision identifiers.
- `backend/memory/src/postgres.ts`: PostgreSQL pool, transaction adapter,
  trusted-context provisioning and atomic capture.
- `backend/memory/src/capture.ts`: server-only capture wrapper.
- `backend/memory/src/jobs.ts`: claims, leases, retries, completion and bounded
  batch execution.
- `backend/memory/src/health.ts`: safe health/readiness results without raw
  connection errors.
- `backend/memory/src/postgres.live.test.ts`: disposable real PostgreSQL
  conformance tests.
- `backend/memory/src/index.ts`: Node-only export boundary.
- `scripts/memory-postgres-harness.mjs`: disposable PostgreSQL lifecycle and
  test command.
- `scripts/memory-postgres-admin.ts`: guarded status/migration entry point.
- `backend/memory/README.md`: local configuration, migration and rollback
  instructions.
- `package.json`, `package-lock.json`, `.env.example`: `pg`, `@types/pg`,
  Stage 03 scripts and server-only configuration placeholders.
- `docs/memory/implementation-map.md`, `00-PROGRESS.md`: source ownership and
  status updates.

No new production feature flag is enabled. No app route, Worker route, D1,
Supabase array, Durable Object authority, deployment or remote migration was
changed.

## Decisions and deviations

- The adapter uses `pg` only in the Node-only `backend/memory` module. The
  Cloudflare Worker graph continues to import only the edge-safe contract entry
  point. If a later Cloudflare deployment needs PostgreSQL, it must use the
  platform's supported database connection boundary rather than bundling this
  local server adapter.
- The migration is a dedicated schema rather than a new database or paid
  service. This keeps local rollback limited to the isolated `gideon_memory`
  schema and prevents accidental customer-data writes.
- The provider/model operation is an injected handler seam. Stage 03 proves
  transaction and fencing behavior without claiming a provider call or
  enabling background learning; later stages own extraction and provider
  policy.
- The scalar-slot lock inserts the lock row with `ON CONFLICT DO NOTHING`
  before `SELECT ... FOR UPDATE`, so the first insert is serialized as well as
  subsequent updates. A partial unique index is a second database guard.
- The live suite uses synthetic event/assertion payloads and no raw user text.
  Its passing result proves local PostgreSQL semantics, not staging,
  production, provider, retrieval-quality or voice behavior.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npm run memory:postgres:test` | Disposable PostgreSQL 17.5 cluster, Node/Vitest | PASS, 1 file / 4 tests | `backend/memory/src/postgres.live.test.ts`; harness output |
| Atomic capture and injected rollback | Real PostgreSQL | PASS | First live test: one event/job/receipt; crash leaves zero event |
| Same-key idempotency and changed-content conflict | Real PostgreSQL | PASS | First live test |
| Cross-worker bounded claim and scalar first-insert contention | Real PostgreSQL | PASS | Second live test: two distinct claims, one scalar winner, one dead conflict |
| Retry/backoff and dead-letter transition | Real PostgreSQL | PASS | Second live test |
| Cross-scope candidate isolation | Real PostgreSQL | PASS | Second live test |
| Expired lease/fence replacement | Real PostgreSQL | PASS | Third live test: stale completion rejected, replacement accepted |
| Health unavailable result | Invalid local port | PASS | Fourth live test: `status=unavailable` |
| `npx tsc --noEmit` | Local TypeScript | PASS | Exit code 0 |
| `git diff --check` | Local Git | PASS | No whitespace errors |

Seed-case coverage:

- C20: executable real PostgreSQL claim/slot contention test in the second
  live test; no acknowledged effect is silently overwritten.
- C21: executable atomic capture/idempotency and retry tests in the first and
  second live tests; duplicate delivery creates one event/job/effect.
- C25: executable unavailable health check plus no-empty-corpus capture
  behavior in the adapter; no remote memory fallback is claimed.
- C26 and C33 remain represented by Stage 01 evidence and future quota/command
  stages. The Stage 03 suite does not relabel them as passes.

## Operational behavior

- Startup requires a valid PostgreSQL URL in the server environment. Pool size,
  connection timeout, idle timeout and statement timeout are bounded by config.
- `npm run memory:postgres:status` is read-only. `memory:postgres:migrate`
  requires `GIDEON_MEMORY_MIGRATE=1` and rejects remote URLs unless a separate
  explicit override is present. No migration command was run against the
  existing PostgreSQL service or a remote database.
- The disposable harness owns its temporary cluster, uses trust authentication
  only inside that temporary directory, stops it in `finally`, and deletes only
  that exact generated directory. It does not modify the installed Windows
  PostgreSQL service.
- Captured jobs are at-least-once. A worker crash after claim leaves a running
  lease that can be reclaimed after expiry; the old fence cannot commit. A
  retry is bounded by five attempts and a 30-minute maximum exponential delay;
  exhausted work becomes `dead` with only a safe failure code stored.
- Graceful batch shutdown stops starting new handlers and returns a retryable
  shutdown result for claimed jobs. In-flight handler results are still fenced
  at completion.
- Rollback of this isolated stage is: disable the Stage 03 scripts/adapter and
  revert the Stage 03 commit. The disposable schema can be dropped only from
  an explicitly owned local test database. No existing legacy memory rows are
  migrated or deleted.

## Remaining gaps

- No staging or production database, migration, Worker Hyperdrive binding,
  app cutover, provider call, background extraction, retrieval, deletion API,
  or voice integration was run. Those are later stages and remain unproven.
- The existing application continues to use legacy Node JSON, Worker D1/DO or
  Supabase compatibility stores. Stage 03 is an isolated canonical backend,
  not a release cutover.
- A production-grade migration/restore rehearsal and multi-host operational
  load test remain later operational gates. The local PostgreSQL suite proves
  the defined transaction/lease scenarios only.

## Next stage contract

Stage 04 may rely on:

- `PostgresMemoryStore.forSession(session)` for a trusted scope-bound
  `MemoryStorageCapabilities` implementation.
- `captureCommittedEvent(store, session, event)` for a durable captured receipt
  and idempotent event/outbox transaction.
- `claimJobs`, `completeJob`, `failJob` and `runJobBatch` for fenced background
  execution. Provider/model handlers must remain outside database transactions.
- `PostgresMemoryTransaction.commitAssertion()` and `withSlotLock()` for exact
  revision and scalar-slot commits, with source/dependency checks.
- `backend/memory/migrations/001-memory-authority.sql` and `002-memory-indexes.sql`
  as the canonical persistence layout; do not create a second writer.

Next prompt: `docs/memory/implementation/04-commands-and-temporal-versions.md`.
Do not begin it in this stage.
