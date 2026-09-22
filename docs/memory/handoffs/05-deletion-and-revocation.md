# Stage 05 handoff: privacy deletion, grant revocation, and resurrection prevention

Status: LOCAL_VERIFIED
Implementation commit or working-tree identifier: commit `a68ee5a` (`feat(memory): add deletion and revocation controls`)
Date: 2026-09-22
Environment: Windows 10.0.19045 x64, Node v22.13.0, npm 11.0.0, PostgreSQL 17.5 disposable local cluster, Vitest 4.1.5; no customer or remote database

## Prerequisite evidence

- Reverified the clean pushed `fix/reliability-and-memory-isolation` branch at
  Stage 04 handoff commit `cf3dd26` before editing.
- Read the common instructions, foundation, progress ledger, Stage 04 handoff,
  acceptance coverage and the complete Stage 05 prompt.
- Confirmed that `PostgresMemoryTransaction.commitAssertion()` remains the only
  canonical assertion writer used by deletion-race tests and stale workers.
- Kept the PostgreSQL authority Node-only. Existing HTTP, realtime, Worker,
  Durable Object, Supabase and legacy JSON authorities remain unchanged.

## Implemented behavior

- Added `createDeletionPlan()` and `executeDeletionPlan()` in
  `backend/memory/src/deletion.ts`. Plans bind the authenticated principal,
  scope, exact assertion ID/revision, policy/deletion epochs and a 30-second
  expiry (bounded to two minutes). Query targets must resolve to exactly one
  candidate; ambiguity creates no plan. An exact authorized forget does not
  require a redundant confirmation flag.
- Added `executeForgetCommand()` for the validated public `forget` command.
  `PublicForgetCommand` now carries an exact `targetRevision` when an exact
  assertion target is supplied; a query is resolved before commit.
- The logical deletion transaction installs non-content event/version
  suppressions, advances the per-scope deletion epoch, marks affected
  assertions deleted, invalidates precise or lineage-ambiguous projections,
  cancels pending/retry input jobs, revokes private snapshot leases, appends
  the control ledger, and creates bounded purge tasks. Its receipt says
  `reuseBlocked: true` while reporting physical purge separately.
- Dependency traversal follows evidence and assertion dependency edges with
  bounded depth/node limits. Projections with missing precise lineage are
  invalidated as whole summaries. Canonical identity tombstones retain only
  enough non-content identity to block later canonical reuse after versions and
  source rows are physically purged.
- `runPurgeBatch()` deletes source events/receipts, assertion versions and
  edges, projections/members, change-feed and command-receipt rows, jobs, and
  entries in the adapter-owned managed cache. It uses bounded attempts and
  exposes failed tasks in `getDeletionStatus()`; suppression/control-ledger
  identifiers remain for resurrection and restore protection.
- `revokeMemoryGrant()` changes only the grant and policy epoch, fences jobs and
  leases in that scope, and returns `underlyingDataDeleted: false`. It does not
  touch independent authorized scopes.
- `issuePrivateSnapshotLease()` and `validatePrivateSnapshotLease()` enforce a
  five-second maximum private lease and invalidate on expiry, grant revocation,
  deletion epoch change or restore blocking. `createMemoryDispatchGuard()`
  supplies a pre-dispatch epoch check and cancellation hook. Content already
  delivered/transmitted externally remains outside the recall guarantee.
- `markRestorePending()` and `reconcileRestoreLedger()` fail readiness closed
  until ordered deletion/revocation ledger rows are replayed. Health reports
  `unavailable`, not an empty corpus, while reconciliation is pending.
- Authorization, exact/current/historical/candidate reads, accepted overlays,
  command retries, job claims and worker completion all retain suppression or
  epoch guards. Third-party document text cannot alter grants or policy epochs.

## Source and schema map

- `backend/memory/migrations/004-deletion-revocation.sql`: plans, operations,
  purge tasks, deletion/revocation control ledger, revocation timestamps,
  recovery guards, snapshot leases and managed-cache entries. It removes only
  the suppression-table foreign keys needed to retain minimal tombstones after
  physical purge; PostgreSQL row indexes are removed with their rows.
- `backend/memory/src/deletion.ts`: Stage 05 command, purge, revocation,
  lease, dispatch-guard and restore protocol.
- `backend/memory/src/postgres.ts`: restore readiness, active-grant checks,
  canonical identity conflict mapping, and existing suppression-gated storage
  operations.
- `backend/memory/src/commands.ts`: suppression checks on stored retries and
  accepted change overlays.
- `backend/memory/src/jobs.ts`: suppression/recovery-aware claims and stale
  completion rejection.
- `backend/memory/src/health.ts`: restore-guard readiness gate.
- `backend/memory/src/index.ts`: Node-only Stage 05 exports.
- `src/lib/memory/contracts.ts`: exact forget revision contract and parser
  validation.
- `backend/memory/src/postgres.live.test.ts`: real PostgreSQL race, purge,
  restore, scope, lease, revocation and untrusted-evidence cases.
- `docs/memory/implementation-map.md` and
  `docs/memory/implementation/00-PROGRESS.md`: ownership and evidence state.

No production feature flag was enabled. The migration was applied only inside
the owned disposable PostgreSQL harness. No remote/customer schema was changed.

## Decisions and deviations

- Logical blocking is authoritative and immediate; physical purge is a
  separately reported bounded workflow. This avoids claiming that a database
  receipt has erased browser caches, provider logs, already-transmitted model
  content or uncontrolled exports.
- Suppression rows and the control ledger keep IDs, revisions, reasons and
  epochs, not deleted text or low-entropy reversible hashes. A canonical
  assertion tombstone retains its canonical identity so physical purge cannot
  make a later formatting-equivalent command resurrect the same memory.
- The adapter-owned managed-cache table is the only cache surface this stage
  can physically purge. `backup.retentionLimitDays` remains `null` and
  `externallyControlledCopies` is `not_controlled`; restore must replay the
  independent control ledger before readiness.
- Grant revocation is deliberately policy-epoch-only. It is not represented as
  a deletion suppression and does not erase data in another scope.
- A five-second private lease/revalidation bound was chosen and enforced rather
  than silently accepting a longer disconnected cache. Stage 07 may integrate
  leases into warm snapshots, but it must preserve this bound or publish a new
  measured contract.
- The public `forget` parser is extended now, but Stage 05 does not wire the
  existing HTTP/Worker tool routes. That integration belongs to later stages.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npm run memory:postgres:test` | Fresh owned PostgreSQL 17.5 disposable cluster | PASS, 1 file / 14 tests | `backend/memory/src/postgres.live.test.ts` |
| Stage 05 C22/C23 deletion race and restore guard | Real PostgreSQL | PASS | `Stage 05 C22/C23 blocks reuse before purge, rejects the in-flight worker, and gates stale restore replay` |
| Stage 05 C24 scope isolation | Real PostgreSQL | PASS | `Stage 05 C24 keeps similarly named private scopes out of candidate and deletion resolution` |
| Stage 05 C25 lease and dispatch cancellation | Real PostgreSQL | PASS | `Stage 05 C25 expires private snapshot leases at the five-second bound and cancels dispatch on epoch change` |
| Grant revocation independence | Real PostgreSQL | PASS | `Stage 05 grant revocation advances only its scope epoch and preserves an independent authorized scope` |
| Stage 05 C29 untrusted document authority boundary | Real PostgreSQL | PASS | `Stage 05 C29 stores an untrusted authority claim as attributed evidence without changing grants` |
| `npx vitest run src/lib/memory/contracts.test.ts` | Local Vitest | PASS, 1 file / 16 tests | Contract parser/validator suite |
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` | Local Vitest | PASS, 82 files / 927 tests | Offline repository suite |
| `npx tsc --noEmit` | Local TypeScript | PASS | Exit code 0 |
| `npm run build:cloudflare` | Local Cloudflare build | PASS | Vite Cloudflare client/server build and typecheck |
| `npm run build` | Local application/realtime build | PASS | Vite application, Nitro and realtime outputs |
| `git diff --check` | Local Git | PASS | No whitespace errors |

The real suite inspects canonical assertion/version rows, source events and
receipts, projections/members, change feed, command receipts, jobs, the
adapter-owned cache and retained suppression/tombstone state. The PostgreSQL
test cluster is removed by the existing harness after the run.

## Operational behavior

- Use `createDeletionPlan()` then `executeDeletionPlan()` from trusted Node
  code, or `executeForgetCommand()` for a validated exact/query command. The
  plan expiry and current policy/deletion epochs are checked again under the
  scope policy row lock before suppression commits.
- Use `runPurgeBatch()` with a bounded limit and injected clock. It retries
  bounded failures, leaves failed task codes visible in status, and preserves
  the logical block even when physical cleanup is delayed.
- Use `revokeMemoryGrant()` for app-grant loss; callers must use a fresh session
  after the returned policy epoch changes. Existing in-flight jobs/dispatches
  must recheck their epoch before committing or sending controllable output.
- Use `markRestorePending()` during an old-backup restore and
  `reconcileRestoreLedger()` in ledger order before reopening reads/writes.
  `checkMemoryReadiness()` remains unavailable while a guard is blocked.
- Safe rollback is to stop importing `backend/memory/src/deletion.ts` and leave
  the additive Stage 05 schema unused; do not drop `gideon_memory`, delete
  suppression rows, or restore a writable old backup. Removing suppression or
  ledger rows would reopen resurrection paths. A controlled database rollback
  must preserve those rows and epochs.
- No real-user deletion drill, production migration, deployment, provider call,
  voice path, browser-cache purge or external export revocation was attempted.

## Remaining gaps

- No staging or production proof exists. The local PostgreSQL harness is not a
  customer-data or deployment gate.
- Existing HTTP, realtime voice, card, inspector and export routes do not yet
  call these Stage 05 APIs. Their integration and user-facing controls belong
  to later prompts.
- The stage can purge only the managed-cache surface it owns. Browser caches,
  provider logs, already transmitted content and uncontrolled exported clones
  have no revocation adapter here and are explicitly not promised revocable.
- Dependency traversal is bounded. A lineage graph beyond the configured
  limit is handled conservatively by invalidating known/whole projections, but
  a later operational stage still needs bounded backlog monitoring and backup
  retention policy measurements.
- No external backup service was configured. Restore replay is proven against
  the local control ledger, not an actual backup-provider restore.

## Next stage contract

Stage 06 may rely on:

- `executeForgetCommand()`, `createDeletionPlan()`,
  `executeDeletionPlan()`, `getDeletionStatus()` and `runPurgeBatch()` from
  `backend/memory/src/deletion.ts` for exact deletion and purge status.
- `revokeMemoryGrant()`, `issuePrivateSnapshotLease()`,
  `validatePrivateSnapshotLease()`, `createMemoryDispatchGuard()`,
  `markRestorePending()` and `reconcileRestoreLedger()` for policy/lease and
  restore gates.
- Suppression-gated `PostgresMemoryTransaction` reads and commits, the
  deletion/policy epochs, retained non-content tombstones, and the existing
  `commitAssertion()` canonical writer.
- Migration 004's `recovery_guards` readiness state. Future projections,
  retrieval hydration, inspector and exports must check suppression and current
  epochs before returning or dispatching content.

Next prompt: `docs/memory/implementation/06-conversation-state.md`.
Do not begin it in this stage.
