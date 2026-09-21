# Stage 04 handoff: explicit commands, correction semantics, and temporal history

Status: LOCAL_VERIFIED
Implementation commit or working-tree identifier: commit `40de650` (`feat(memory): add explicit commands and temporal versions`) on `fix/reliability-and-memory-isolation`
Date: 2026-09-21
Environment: Windows 10.0.19045 x64, Node v22.13.0, npm 11.0.0, PostgreSQL 17.5 disposable local cluster, Vitest 4.1.5; no customer or remote database

## Prerequisite evidence

- Reverified the clean pushed `fix/reliability-and-memory-isolation` branch at
  the Stage 03 commit `c734ea0bf5844d0d480b12ccf5cf6674cf3bba2b` before editing.
- Read the common instructions, foundation, progress ledger, Stage 03 handoff,
  acceptance coverage map, and the complete Stage 04 prompt.
- Confirmed Stage 03's PostgreSQL authority and transaction-scoped
  `commitAssertion()` are the only canonical writer used by this stage.
- The existing application, Worker, Durable Object, Supabase and legacy JSON
  paths remain unchanged and no production-facing flag was enabled.

## Implemented behavior

- Added a server-only explicit command service for `remember` and `correct`.
  It validates the public command, binds authority from the authenticated
  `MemorySession`, requires a PostgreSQL-backed store, and rejects ephemeral
  or non-PostgreSQL durable writes with a typed failure.
- `remember` creates a committed user event and an accepted assertion version.
  Event, evidence, command receipt, accepted change-feed watermark and
  projection invalidation job are committed in one transaction.
- Formatting-equivalent `remember` commands use a deterministic canonical key.
  A duplicate returns the existing revision without a second semantic effect,
  change notification or projection job. Contradictory text, polarity,
  subject, slot cardinality, conditions or temporal identity does not merge by
  semantic similarity.
- `correct` requires an exact assertion ID and target revision. It checks the
  current revision, optional source authority revision and target kind before
  committing the next version. The new version keeps a `supersedes` reference
  and the prior version/evidence remain immutable audit history.
- Correction and real-world transition are distinct. A correction becomes the
  valid-at result for the target's unbounded interval; a transition starts at
  its explicit effective date, so valid-at queries before that date return the
  prior version. `receivedAt` and `interpretedAt` are stored independently of
  user-supplied valid time and precision.
- `executeScopedException()` creates a separate preference/constraint
  assertion with explicit conditions and an expiry. It never rewrites the
  global assertion, and current reads exclude an expired version when given a
  deterministic clock.
- Added current, `known_at`, and `valid_at` reads plus an accepted-change
  overlay. The overlay is sourced only from committed accepted change-feed
  rows, so a captured-only event cannot masquerade as an accepted assertion.
  Exact, current, candidate and historical reads apply existing suppression
  records as hard gates.
- Added ambiguity-safe target resolution. Zero candidates returns `not_found`;
  multiple candidates return `ambiguous` with bounded exact candidates rather
  than selecting a destructive top result.
- Added bounded per-scope quota admission. A full durable quota returns
  `budget_exhausted` and does not evict durable accepted records or issue a
  success receipt. The default accepted-assertion limit is 1,000; tests may
  lower it only in the owned disposable database.
- Added command-id retry records. If a response is lost after commit, retrying
  the same command returns the original accepted result. An injected failure
  before commit rolls back the event, assertion, evidence, feed, job and
  command receipt together.

## Source and schema map

- `backend/memory/src/commands.ts`: explicit command writer, temporal reads,
  overlay and ambiguity-safe target resolver.
- `backend/memory/migrations/003-commands-and-temporal.sql`: canonical keys,
  quota limits, change counters/feed and command receipts.
- `backend/memory/src/postgres.ts`: action-specific authorization, canonical
  key persistence, suppression-gated reads, version/source helpers, event
  sequence allocation and projection-job insertion.
- `backend/memory/src/config.ts`: bounded default durable assertion quota.
- `backend/memory/src/index.ts`: exports the Node-only command service.
- `src/lib/memory/contracts.ts`: valid-time command fields, exact correction
  revision/source fields, assertion supersession metadata and canonical commit
  key.
- `backend/memory/src/postgres.live.test.ts`: real PostgreSQL acceptance and
  rollback/concurrency evidence.
- `backend/memory/README.md`: explicit command, quota and migration boundary.
- `docs/memory/implementation-map.md` and
  `docs/memory/implementation/00-PROGRESS.md`: ownership and status records.

No application route, Worker import, Durable Object authority, legacy writer,
remote migration, feature flag or customer data was changed.

## Decisions and deviations

- The public command contract remains edge-safe. Server receipt time,
  interpreted time, subject, scope, source authority, consent and event IDs
  are derived in trusted Node code; the command body cannot supply them.
- `temporary_exception` is represented by an explicit `remember` relation and
  the exported `executeScopedException()` adapter. A separate destructive
  `forget` writer is deliberately left to Stage 05.
- Version rows remain immutable. A transition's effective boundary is applied
  by the valid-time reader rather than mutating the prior row's JSON. This
  preserves the original source interval and keeps the system interpretation
  time separate.
- The change feed stores the accepted version as the overlay payload because
  Stage 07 needs an immediate, scope-bound correction overlay. It is not an
  independent authority; it is written in the same transaction as the
  canonical assertion and can be rebuilt later.
- The quota is admission-only. No hot-context or legacy 400-record selection
  code is called by the PostgreSQL command path. The C26 test seeds 400
  accepted synthetic durable assertions and accepts a 401st explicit write;
  it does not claim a production legacy migration.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npm run memory:postgres:test` | Disposable PostgreSQL 17.5 cluster | PASS, 1 file / 9 tests | `backend/memory/src/postgres.live.test.ts` |
| Explicit remember, canonical slot, duplicate and accepted overlay | Real PostgreSQL | PASS | Stage 04 first live test; one accepted change, one formatting duplicate, one projection job |
| Correction, transition, known-at and valid-at reads | Real PostgreSQL | PASS | Stage 04 temporal live test; revisions 1/2 and effective date assertions |
| Scoped exception and expiry | Real PostgreSQL | PASS | Stage 04 exception live test |
| Ambiguous response retry, injected rollback and concurrent edits | Real PostgreSQL | PASS | Stage 04 retry/concurrency live test |
| Quota rejection and 400-to-401 durable admission | Real PostgreSQL | PASS | Stage 04 quota/capacity live test |
| `npx vitest run src/lib/memory/contracts.test.ts` | Local Vitest | PASS, 1 file / 16 tests | Contract runtime validator tests |
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` | Local Vitest | PASS, 82 files / 927 tests | Offline repository suite |
| `npx tsc --noEmit` | Local TypeScript | PASS | Exit code 0 |
| `git diff --check` | Local Git | PASS | No whitespace errors |

Seed coverage exercised in the real database suite: C04, C05, C06, C07,
C19, C20, C21, C26, C33 and C36. The test data is synthetic and local. C26
proves the new command path is independent of hot-cache eviction; it does not
prove a legacy-data migration or a production quota configuration.

## Operational behavior

- `executeExplicitCommand()` and all read/overlay helpers require a
  server-bound authenticated session and the matching database grant/policy
  epoch. The PostgreSQL adapter remains Node-only.
- Command writes use the existing transaction and scope policy row lock to
  serialize event sequence/watermark allocation. Assertion slot locks and
  expected revisions prevent last-arrival-wins scalar edits.
- Command IDs are retry keys. A changed payload under an already committed
  command ID returns a conflict. A lost response after commit is safe to retry.
- Projection invalidation is a bounded `rebuild_projection` outbox job. No
  model/provider call runs inside the commit transaction.
- Migration application remains behind the existing explicit local/remote
  guards. This stage only ran the disposable harness, which applies all
  migrations to a generated local cluster and removes that cluster afterward.
- Safe rollback is to stop importing the Node-only command exports and leave
  the additive Stage 04 schema unused, or revert the Stage 04 commit in a
  controlled branch. Do not drop `gideon_memory` on a shared database; the
  existing README's owned-local-only rule remains in force. No accepted data
  is rewritten or physically deleted by rollback.

## Remaining gaps

- No staging or production database migration, deployment, app/Worker/voice
  integration, provider call, retrieval-quality measurement, or live-user
  proof was run.
- Privacy deletion, grant revocation, physical purge, restore protection and
  resurrection prevention are not implemented here; Stage 05 owns them.
- Automatic inference, background extraction, profiles, semantic retrieval,
  conversation-state composition, Jev and UI/tool adapters remain later work.
- The valid-time reader is deterministic and bounded but is not yet a full
  projection/composition engine. Temporary exceptions are stored and read
  correctly in isolation; task-level override selection belongs to later
  composition stages.

## Next stage contract

Stage 05 may rely on:

- `executeExplicitCommand()`, `executeScopedException()`,
  `readCurrentAssertion()`, `readAssertionAsOf()`,
  `readAcceptedChangeOverlay()` and `resolveExplicitTarget()` from
  `backend/memory/src/commands.ts`.
- `AssertionVersion.supersedes`, immutable prior versions, exact revision
  checks, `PostgresMemoryTransaction.isVersionSuppressed()`, and the
  `deletion_suppressions` table as the existing suppression boundary.
- Migration 003's command receipts and change feed as dependent records that
  deletion must invalidate or suppress; accepted overlays must never bypass
  deletion epochs.
- The command receipt's `accepted` state means the canonical version and
  change watermark committed. A captured event or pending interpretation is
  not an accepted command overlay.

Next prompt: `docs/memory/implementation/05-deletion-and-revocation.md`.
Do not begin it in this stage.
