# Stage 14 handoff: concurrency, security boundaries, load, recovery and operational budgets

Status: LOCAL_VERIFIED (rollout remains blocked on production-hardware latency and restore purge)
Implementation commits:
- `eeb0efa`: discard a client whose backend dies mid-transaction
- `efad7cb`: per-owner cap on queued interpretations (backpressure)
- `0cd6968`: operational metrics, alerts and the portable control ledger
- `7490980`, `fa0ddd5`: load/fault/isolation/restore conformance suite
- `05fe6b1`: indexes for source evidence and lexical search (migration 010)
- `af4c330`: build fails when a bundle carries a secret or server credential
- `0c691f3`: learned changes accepted in warm snapshots
- `8eda6d1`: failed projection rebuilds are explained, invalid ones not retried
- `5aa6687`: operator commands and the load workload
- `18eacd4`: runbook and measured service levels
- the commit that adds this handoff

Date: 2026-09-24
Environment: Windows 10, i7-4800MQ (8 threads), 12 GB, Node 22.13,
disposable local PostgreSQL 17 via `scripts/memory-postgres-harness.mjs`. No
deployment, remote database, provider call or real-user data in this stage,
apart from a $0.0004 cache refresh of four Stage 13 answers.

## Prerequisite evidence

Stage 13 (`handoffs/13-comparative-evaluation.md`): seed conformance, the
held-out harness, and the fixed recall budget / explicit-turn linkage. The
held-out results were replayed after this stage's retrieval changes: memory
content is identical, one diagnostic line changed in two packs, and the
numbers are unchanged after refreshing those answers.

## Implemented behavior

- **Crash safety.** A PostgreSQL backend terminated while a client is checked
  out no longer raises an uncaught `error` event that can kill the Node
  process. The broken client is destroyed, not returned to the pool.
- **Backpressure.** Past 500 queued or running interpretations per owner, new
  turns are still captured but not queued for learning. The count is
  visible as `uninterpretedTurns24h` and the `uninterpreted_turns` alert.
- **Metrics and alerts.** `collectMemoryMetrics` / `evaluateMemoryAlerts`
  (`backend/memory/src/operations.ts`), exposed by `npm run memory:ops -- metrics`.
  They report counts and ages only: queues, expired leases, dead jobs, stale
  projections, purge backlog, blocked restores, and accepted commands whose
  version vanished.
- **Independent ledger.** `exportControlLedger` / `importControlLedger`, with
  `npm run memory:ops -- ledger-export | restore-replay`. They let a restored
  database replay deletions made after its backup; a diverged ledger is
  refused.
- **Performance.** Migration 010 indexes evidence edges by event, events by
  source document, and both lexical expressions. The "already represented"
  check now uses the indexed edges.
- **Correctness under load.** Warm snapshots accept learned, promoted and
  retired changes. Before this, any owner with a learned memory never got a
  warm snapshot and every rebuild job died.
- **Observability.** Maintenance counts failed rebuilds by reason, and a
  non-retryable rebuild failure goes dead at once.
- **Build guard.** `scripts/check-worker-bundle.mjs` (part of
  `build:cloudflare`) now fails if any bundle embeds a local secret value, or
  if the browser bundle names a server credential or carries a connection
  string. A planted leak was caught.

## Source and schema map

- New: `backend/memory/src/operations.ts`, `backend/memory/src/operational.live.test.ts`,
  `backend/memory/migrations/010-operational-indexes.sql`, `scripts/memory-ops.ts`,
  `scripts/memory-contention-worker.ts`, `scripts/memory-load.live.test.ts`,
  `docs/memory/operations/runbook.md`, `docs/memory/reports/stage-14-slo.{md,json}`.
- Changed: `backend/memory/src/postgres.ts` (runTransaction, capture backlog),
  `config.ts` (`DEFAULT_MEMORY_INTERPRET_BACKLOG`), `retrieval.ts` (represented
  check), `background.ts` (rebuild reasons), `index.ts`;
  `src/lib/memory/projections.ts` (change kinds);
  `scripts/memory-postgres-harness.mjs` (passes the PostgreSQL bin dir for the
  drill); `scripts/check-worker-bundle.mjs`; `package.json` scripts
  `memory:ops`, `memory:postgres:ops`, `memory:postgres:load`.
- `MaintenanceReport.projections.failureReasons` is a new field.
  `CaptureOptions.interpretBacklogLimit` is optional.

## Verification

| Command/check | Environment | Result | Evidence |
|---|---|---|---|
| `npx vitest run` | local | 1062 passed, 99 skipped (live-gated) | terminal |
| `npm run memory:postgres:test` | disposable PostgreSQL | 76/76 | terminal |
| `npm run memory:postgres:ops` | disposable PostgreSQL | 8/8 | terminal |
| `npm run memory:postgres:load` | disposable PostgreSQL | pass; 0 errors, 0 deadline misses, 0 dead jobs, 0 lost commands (final run) | `reports/stage-14-slo.json` |
| `npm run build` | local | pass | terminal |
| `npm run build:cloudflare` (incl. `tsc`, bundle and secret checks) | local | pass; planted leak rejected | terminal |
| Stage 13 held-out replay after the retrieval changes | disposable PostgreSQL + cache | unchanged results | `reports/stage-13-heldout.json` |

Stage 14 conformance tests (`backend/memory/src/operational.live.test.ts`):
1. Four OS processes (via jiti) correct three shared memories 20 times each
   and race one first insert. Every acknowledged correction is exactly the
   stored version at its revision, revisions are gapless, the losers get
   `conflict`, and the race yields one memory.
2. Backends are killed mid-command 40 times. Failures are typed
   (`unavailable`), every acknowledged write exists, retries land exactly
   once, and no process-level error escapes. **This failed before `eeb0efa`.**
3. A slow extractor times out and a malformed one writes nothing; jobs stay
   visible.
4. A flooded owner cannot starve another within a tick; past the backlog cap,
   turns are kept but not queued, and the alert fires.
5. Metrics carry no memory text or owner ids and raise `restore_blocked` and
   `dead_jobs`; readiness follows the guard.
6. Canary sweep: another owner gets nothing from any surface —
   current/valid_at/known_at/maximum retrieval, a spoofed runtime binding,
   the recall tool, list/detail/export, forged forget and edit, metrics, and
   the ledger export. The database refuses a cross-scope evidence edge, and an
   injected `</untrusted-memory>` cannot close the pack wrapper.
7. Twelve forgets race four lookups and a learning tick each. No forgotten
   value comes back afterwards.
8. Real `pg_dump`/`pg_restore` drill. The pre-forget backup, restored, serves
   the forgotten memory with readiness "ok". After importing the shipped
   ledger, readiness is blocked; after replay, the memory is not retrievable,
   exported or listed, while other memories remain. Re-import is a no-op and
   a diverged ledger is refused.

Seed cases:

| Case | Evidence |
|---|---|
| C17 | seed-conformance `C17 [transport]` |
| C18 | seed-conformance `C18 [runtime]` |
| C20 | seed-conformance `C20`; operational test 1 (multi-process) |
| C21 | seed-conformance `C21`; postgres "concurrent deliveries…"; "Capture under contention" |
| C22 | seed-conformance `C22`; operational test 7; "Explicit turns are represented by their command" |
| C23 | seed-conformance `C23`; operational test 8 (real restore) |
| C24 | seed-conformance `C24`; operational test 6 |
| C25 | seed-conformance `C25`; operational test 2; postgres "reports database outage as unavailable" |
| C29 | seed-conformance `C29`; operational test 6 (wrapper injection) |
| C30 | seed-conformance `C30`; operational test 3 |
| C32 | seed-conformance `C32` |
| C33 | seed-conformance `C33`; operational test 4 (backlog cap) |

## Measured service levels

See `docs/memory/reports/stage-14-slo.md`. Final run on this machine:
- recall lookup p95 170–444 ms by corpus size, and 332 ms when every memory
  matches;
- capture p95 65 ms; edit p95 165 ms;
- learning drain 53 jobs/s; pack at most 2,880 bytes (~680 tokens).

Before this stage's fixes, the same workload had 256 lookups hit the 1.5 s
deadline (source evidence took 13 s for one owner) and 126 dead snapshot
jobs. **Lookup p99 ranged from 0.46 s to 1.50 s across runs** (one run had 1
miss in 432), so the p99 target is not met reliably here.

## Boundary review (Cloudflare ↔ canonical service)

- The Worker bundle resolves memory to a stub. It contains no pg driver,
  PostgreSQL store or schema name (checked on every Cloudflare build), and it
  has no network path or credential to the memory database.
- Node identity is the signed owner cookie (`GIDEON_IDENTITY_SECRET`). Memory
  sessions are built server side, and the recall binding is rechecked (a
  spoofed scope in the binding returns `unavailable`, test 6).
- Session and grant revocation advance the policy epoch. Snapshot leases are
  capped at 5 s and rechecked at dispatch (Stage 05).
- No worker credentials exist for memory, because the Worker never talks to
  it. Browser bundles are checked for server credential names, connection
  strings and local secret values.

## Model/index migration safeguards

- The semantic index (Stage 08) records provider model id and version,
  indexes only authorized current revisions, and is not configured in
  production.
- Migrations are additive and idempotent. The runbook requires building
  migration 010's indexes `CONCURRENTLY` on a live database.
- Corrections and deletions live in assertions, suppressions and the ledger,
  not in any index. Rebuilding or dropping indexes cannot revert them, and
  replay after restore reapplies deletions.

## Remaining gaps (why rollout stays blocked)

1. **Tail latency** on this hardware is not reliably under the 1 s p99
   target. It must be measured on production hardware.
2. **The warm snapshot path is effectively unused.** The 5 s lease expires
   before most lookups, so "after rebuild" lookups are as slow as cold ones.
   Decide in Stage 15: refresh ahead of use, or recall `authoritative` and
   skip the warm attempt.
3. **Restored copies keep physical residue.** Replay blocks forgotten
   content logically, but the restored database still holds those rows (the
   drill measured 2 events and 1 version). Purge tasks need the original
   deletion operation, which the old backup lacks.
4. **Ledger shipping is a procedure, not automation.** The export exists; a
   scheduler and independent storage are not provisioned.
5. **Not measured:** first substantive audio (needs the realtime provider and
   a client), and multi-host throughput.
6. **Learning is skipped for turns that also carried an explicit command**
   (Stage 13). A second memorable statement in such a turn is only stored if
   the model calls `remember` for it.

## Operational behavior and rollback

The runbook covers startup, shutdown, fallback, outages, quotas, stalled jobs,
ledger shipping and restore. To revert:
- `git revert` the fix commits. Migration 010 only adds indexes and can stay.
  Dropping them restores the slow queries.
- Reverting `eeb0efa` reintroduces the crash risk.
- Reverting `0c691f3` reintroduces the dead snapshot jobs.

Disabling memory is the `GIDEON_MEMORY_*_ENABLED` switches; nothing is
deleted.

## Next stage contract

- `collectMemoryMetrics(pool)`, `evaluateMemoryAlerts(metrics)`,
  `exportControlLedger(store, { after })`, `importControlLedger(store, doc)`
  from `backend/memory/src/index.ts`.
- `npm run memory:ops`, `npm run memory:postgres:ops`,
  `npm run memory:postgres:load`.
- Stage 15 (migration and rollout) must include `ANALYZE` after bulk import,
  `CONCURRENTLY` for migration 010 on live data, ledger shipping before
  relying on backups, and the warm-path decision.

Next prompt: `docs/memory/implementation/15-migration-and-rollout.md`.
