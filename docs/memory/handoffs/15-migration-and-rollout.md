# Stage 15 handoff: single-writer migration, rollout and rollback

Status: LOCAL_VERIFIED (local rehearsal only; staging and production NOT PERFORMED, not authorized)
Implementation commits:
- `674ae79`: per-owner writer record (migration 011) and legacy cutover/rollback
- `07facf2`: HTTP turns and sockets routed by the recorded writer
- `266e52a`: cutover suite on real PostgreSQL (and a tightened Stage 14 canary check)
- `171b58c`: migration manifest and operator commands
- `9d2ac7a`: deletion-cancelled jobs no longer counted as dead
- `f51b401`: local cutover rehearsal with shadow comparison
- the commit that adds this handoff

Date: 2026-09-25
Environment: Windows 10, Node 22.13, disposable local PostgreSQL 17, synthetic
legacy files in a temporary directory. No deployment, staging or production
data was touched, and no provider was called.

## Prerequisite evidence

Stage 14 (`handoffs/14-operational-hardening.md`): writer-lock-free operation,
metrics and alerts, ledger shipping and the runbook. All of it was reused.
The Stage 14 suites still pass (8/8), with one canary check tightened.

## Outcomes by environment

| Environment | Outcome |
|---|---|
| Local rehearsal | PASS: 12 owners and 307 legacy memories moved with every stop condition at zero; rollback drill passed |
| Staging | NOT PERFORMED: no environment was authorized |
| Production | NOT PERFORMED: no environment was authorized; `GIDEON_MEMORY_STAGE15_CUTOVER` remains the production gate |

## Implemented behavior

- **One writer per owner.** Migration 011 adds
  `gideon_memory.authority_cutovers` with states `legacy → fenced → active →
  rolled_back`. Transitions are compare-and-set on a revision, inside a
  transaction holding the owner's exclusive advisory lock. Every guarded
  write holds the same lock shared, so the writer can never change in the
  middle of a write. Two racing operators: one wins, the other gets
  `CutoverConflictError`.
- **Import** (`importLegacyMemories`). Each legacy record becomes an explicit
  command with a stable id derived from its legacy id, with basis
  `imported_legacy` and the legacy id and creation time on the import event.
  No conversation, approval or effective date is invented. Kinds `plan` and
  `person` map to `fact` so the text is kept exactly. Re-running is
  idempotent, and a record forgotten in the new authority is never written
  again, even from an older copy of the file.
- **Validation.** Every imported row is read back and compared by text hash.
  Malformed rows (empty text, missing or duplicate id, unknown kind, bad
  timestamp, too long, not an object) are quarantined with a reason and left
  in the file. An unparseable file aborts the cutover (`legacy_unreadable`)
  instead of activating with nothing.
- **Fence and activation** (`cutoverScope`): fence, import, verify, then
  re-read the file under the exclusive lock and activate only if its hash is
  unchanged. Otherwise the delta is imported (bounded rounds). A legacy write
  already in progress when the fence starts completes first and is imported.
- **Routing** (`resolveNodeMemoryForTurn`, behind
  `GIDEON_MEMORY_CUTOVER_ENABLED`, default off). With the switch off,
  behavior is exactly as before. With it on:
  - legacy or rolled back: the old tools write the file, read fresh from disk
    under the lock;
  - fenced: every write gets the receipt "paused, nothing saved";
  - active: the PostgreSQL runtime, and the old store becomes a read-only
    projection.

  The writer is rechecked on every call, so a socket opened before a cutover
  or rollback cannot write to the wrong store. Owners with no legacy memory
  move at once.
- **Compatibility view** (`legacyCompatibilityView`): the legacy array
  generated from the new authority's current accepted memories, with
  suppression filters and the legacy ids kept. It is never an independent
  writer.
- **Rollback** (`rollbackScope`): fence, rewrite the file from the current
  projection, mark it the writer. The pre-cutover file is never restored,
  so corrections stay and deletions hold.
- **Operator commands:** `npm run memory:ops -- config-check | cutover-plan |
  cutover | rollback`, plus `npm run memory:postgres:rehearsal`. The
  manifest format and the ready-to-run procedure are in
  `docs/memory/operations/runbook.md`. The example manifest is at
  `docs/memory/reports/stage-15-local-manifest.json`.
- **Metrics fix:** jobs a forget cancels on purpose are reported as
  `revokedByDeletion`, so `dead_jobs` no longer fires on every forget.

## In-flight commands and receipts during cutover

- A write that holds the lock before the fence finishes and is imported.
- A write that arrives after the fence is refused with a failed receipt, and
  nothing is changed.
- Retries of explicit commands keep their stable command ids, so a retry
  after activation lands once in the new authority.
- There is no second reconciliation engine: the cutover itself imports and
  compares.
- Nothing is reported as saved locally but pending centrally. The only
  receipts are "saved" (by the current writer) and "paused, nothing saved".

## Verification

| Command/check | Environment | Result | Evidence |
|---|---|---|---|
| `node scripts/memory-postgres-harness.mjs backend/memory/src/cutover.live.test.ts` | disposable PostgreSQL | 7/7 (4 consecutive runs after the fence test was made deterministic) | terminal |
| `npm run memory:postgres:rehearsal` | disposable PostgreSQL + separate shadow database | pass; all stop conditions 0 | `reports/stage-15-rehearsal.json` |
| `npm run memory:postgres:ops` | disposable PostgreSQL | 8/8 | terminal |
| `npm run memory:postgres:test` | disposable PostgreSQL | 76/76 | terminal |
| `npx vitest run` | local | 1062 passed | terminal |
| `npm run build`, `npm run build:cloudflare` | local | pass; Worker bundle free of PostgreSQL code; no secrets | terminal |

Rehearsal (`reports/stage-15-rehearsal.json`):
- **Owners:** 12, with 0–60 memories each.
- **Dry-run manifest:** wrote nothing. It listed 2 quarantined rows by
  reason, and 1 unrecognized file that was not assigned to anyone.
- **Shadow import** into a separate database: recall coverage was 63/63 for
  both the legacy ranking and the new authority. Lookup p50/p95 was 24/45 ms
  new versus 0.3/0.6 ms for the in-memory legacy ranking. The live database
  was untouched.
- **Cutover:** one owner's file changed after planning and was refused until
  re-planned. All 12 were then activated with expected counts matched.
- **Stop conditions:** 0 false receipts, 0 cross-owner disclosures (a canary
  per owner), 0 lost writes, 0 resurrections, 0 count mismatches, 0 dead
  jobs, no critical alerts.
- **Rollback drill** on 2 owners after a forget and a correction: the
  forgotten text was absent from the rewritten file and the correction was
  kept. A full migration retry afterwards re-activated them without
  resurrecting anything.

Seed cases:

| Case | Evidence |
|---|---|
| C19 | cutover suite "rolls back after a correction and a forget…" (the correction survives rollback and re-cutover); seed-conformance `C19` |
| C20 | cutover suite "two devices updating one imported fact…"; Stage 14 multi-process contention |
| C21 | cutover suite "cuts one owner over…" (duplicate import changes nothing); rehearsal migration retry |
| C22 | cutover suite rollback test (forgotten record never re-imported, even from the old file); rehearsal drill |
| C23 | Stage 14 restore drill (ledger replay); unchanged by this stage |
| C24 | rehearsal per-owner canary; cutover suite routing with separate signed owners; Stage 14 canary sweep |
| C25 | routing fails closed when the writer cannot be read (paused runtime); Stage 14 outage tests |
| C26 | cutover suite "refuses every write while fenced…" and routing test: the legacy array is a projection after activation and never an independent writer |

## Decisions and deviations

- Only the Node host's per-owner JSON files are migrated. The Cloudflare
  Worker's account memory (Durable Objects/Supabase) is a separate
  authority and is not part of this cutover.
- Legacy `plan` and `person` kinds import as `fact`, keeping the text
  exact, rather than inventing a decision topic.
- The cutover reads the legacy file raw. The legacy store rejects a whole
  file for one bad row, which would have made quarantine impossible.

## Operational behavior and rollback

- **Default off:** with `GIDEON_MEMORY_CUTOVER_ENABLED` unset, nothing
  changes.
- **Per-owner rollback:** `GIDEON_MEMORY_CUTOVER=1 npm run memory:ops --
  rollback <dir> <owner>`.
- **Global:** restart with the switch off. Owners already moved then behave
  as before Stage 15; the flags decide whether they read the new authority.
- **Data:** legacy files are never deleted by the migration; the runbook
  requires keeping them through the rollback window. Migration 011 is
  additive.
- **Revert:** revert `07facf2` and `674ae79`, leaving the table. Do not
  restore a pre-cutover legacy file after deletions.

## Remaining gaps

- **Staging and production cutover were not performed**, because no
  environment is authorized. That means no deployed-hostname, account,
  routing, socket or cross-device evidence exists outside local tests.
- The Stage 14 blockers still stand: p99 on production hardware, the
  warm-path decision, physical residue in restored copies, and automated
  ledger shipping.
- The shadow comparison ran on synthetic data. A shadow run on real traffic
  needs an authorized environment.

## Next stage contract

- From `backend/memory/src/index.ts`: `cutoverScope`, `rollbackScope`,
  `importLegacyMemories`, `legacyCompatibilityView`, `readAuthority`,
  `withWriterLock`, `closeWriterLocks`.
- From `src/server/node-memory-integration.ts`: `resolveNodeMemoryForTurn`,
  `FencedLegacyStore`, `legacySourceFor`.
- From `src/server/memory-migration.ts`: `planLegacyMigration`,
  `executeLegacyMigration`, `rollbackLegacyOwner`, `memoryConfigCheck`.

Next prompt: `docs/memory/implementation/16-independent-framework.md`.
