# Stage 07 handoff: profiles, warm snapshots, and immediate correction overlays

Status: LOCAL_VERIFIED
Implementation commit or working-tree identifier: `dab0225` (`feat(memory): implement stage 07 projections`)
Date: 2026-09-23
Environment: Windows local checkout, Node `v22.13.0`, disposable PostgreSQL 17 for the live authority suite

## Prerequisite evidence

- Re-read the common instructions, foundation, progress ledger, Stage 06 prompt and Stage 06 handoff before editing.
- Stage 06 handoff: `docs/memory/handoffs/06-conversation-state.md`, implementation commit `7ca0858`, documentation commit `ee96120`.
- The Stage 06 entry gate was reverified on branch `fix/reliability-and-memory-isolation`; the checkout contained no unrelated Stage 01 report change after the full-suite run.
- Reused existing canonical `assertions`, `assertion_versions`, `events`, `change_feed`, `policy_epochs`, `projections`, `projection_members`, `snapshot_leases` and `managed_cache_entries` tables. No Stage 07 migration was needed.

## Implemented behavior

- `buildWarmSnapshot()` produces a bounded inspectable view over accepted current assertion versions. Every profile bullet carries an exact assertion revision, scope, promotion basis, reason, conditions, valid-until time and source event references. Stable defaults and active-topic bullets are separate.
- Profile promotion is deliberately conservative: only `explicit_user_statement` and `user_correction` attribution can create preference/decision bullets. Inferred preferences, assistant-generated summaries and duplicate summaries do not become independent evidence. Topic conditions remain topic-local.
- The snapshot contains stable and active profiles, active episode-checkpoint heads, current non-expired constraints/temporary exceptions, bounded lexical terms/frequencies, recent accepted changes, exact covered assertion references and coverage/freshness metadata.
- The inspector exposes projection id/generation, age, event/change coverage, policy/deletion epochs, assertion-version and source-event dependencies, missing inputs, conflicts and bullet-promotion reasons. Snapshot parsing checks schema, collection, coverage, epoch and serialized-size bounds before a cached payload is trusted.
- `applyAcceptedCorrectionOverlays()` consumes only authorized accepted change-feed entries newer than the snapshot watermark. It removes the superseded assertion from profiles, constraints and episode heads before inserting the corrected revision, updates dependencies/coverage, and ignores out-of-order older overlays.
- `prepareWarmSnapshot()` reads accepted, non-suppressed inputs and current watermarks in a bounded transaction, then performs deterministic composition outside that transaction. `publishPreparedWarmSnapshot()` starts a new authorized transaction, locks/rechecks policy and deletion epochs, current watermarks, current assertion revisions and existing projection generation, and returns a typed stale result instead of publishing stale work.
- The Node adapter persists the projection metadata, exact member revisions and serialized private warm payload through the existing PostgreSQL projection/member/cache tables. `rebuildWarmSnapshot()` composes and publishes through those two phases; `readWarmSnapshot()` validates identity, scope, epochs, expiry, schema and optional Stage 05 private lease.
- `encodeProjectionChangeCursor()` and `readProjectionChangeFeed()` implement a bounded HMAC-signed cursor bound to principal, scope, policy epoch, deletion epoch and change watermark. Invalid, cross-scope, epoch-stale, compacted and ahead cursors return `reset_required` with no reinterpretation under another identity.
- The edge-safe `WarmSnapshotCache` binds entries to principal/scope/epochs, rejects older writes, expires leases at the five-second maximum, supports renewal and invalidation listeners, and does not overwrite a usable entry with an unavailable/empty authority result. `SnapshotTelemetryBuffer` keeps bounded retrieved/included/cited/independently-useful counters outside canonical state.
- Stage 05 deletion/revocation remains the invalidation authority. Its epoch changes and purge operations remove dependent projection/member/cache rows; Stage 07 does not create a competing deletion path.

## Source and schema map

| Concern | Paths | Contract |
|---|---|---|
| Edge-safe projection model and composition | `src/lib/memory/projections.ts` | No Node, PostgreSQL, provider, identity or secret imports; bounded profile/snapshot/overlay/cache/telemetry primitives |
| Edge export | `src/lib/memory/index.ts` | Re-exports projection contracts for later edge-safe consumers; no route is wired in this stage |
| Node PostgreSQL projection adapter | `backend/memory/src/projections.ts`, `backend/memory/src/index.ts` | Server-bound `MemorySession` backed by `PostgresMemoryStore`; read/prepare/publish paths require authorized `recall` access |
| Real PostgreSQL conformance | `backend/memory/src/postgres.live.test.ts` | Stage 07 case covers publication, feed pagination/reset, correction overlay, stale publication and deletion purge; total live suite is 16 tests |
| Deterministic projection/cache tests | `src/lib/memory/projections.test.ts` | Eleven tests cover explicit-only promotion, active/stable separation, expiry, overlays, input/snapshot bounds, maximum-input composition, cache identity/order/lease, outage behavior and telemetry |
| Existing canonical schema | `backend/memory/migrations/001-memory-authority.sql`, `003-commands-and-temporal.sql`, `004-deletion-revocation.sql` | Reuses existing projection/change-feed/epoch/private-cache/deletion tables; no new migration or flag |
| Progress/map documentation | `docs/memory/implementation/00-PROGRESS.md`, `docs/memory/implementation-map.md` | Stage 07 marked `LOCAL_VERIFIED`; later retrieval remains unstarted |

No HTTP, realtime voice, Worker, browser, model-context or ordinary retrieval path imports the new adapter. No production feature flag was enabled.

## Decisions and deviations

- The projection is a replaceable read view, never an authority. Exact source and assertion-version references remain attached so later retrieval can explain why a bullet is present and can rebuild it from canonical rows.
- Stable profile and active-topic profile are separate arrays. A condition labelled topic/project/workstream is active only when it matches the supplied active topic; a temporary exception is represented in the constraints index and is removed after `validUntil`, not decayed because it was rarely recalled.
- Pure composition was moved outside the PostgreSQL read transaction. Publication is the only write transaction and rechecks the inputs that can invalidate the computation. This keeps lock duration bounded while preserving stale-worker rejection.
- The existing Stage 03–05 tables were intentionally reused. Adding another projection or cache schema would create a second authority and weaken the deletion/revocation guarantees already implemented.
- A five-second maximum applies to both the edge private cache lease and the PostgreSQL warm payload expiry. An expired or unavailable warm view is a cold/unavailable read, never a newly written empty memory corpus.
- HMAC cursors require a caller-provided secret of at least 16 characters. The cursor carries identity and epoch bindings; reset is explicit when retained history or authorization context no longer matches.
- No foundation amendment was needed. The stage does not claim a push transport: the edge cache exposes invalidation listeners and the server adapter exposes epoch/change-feed checks for a later integration stage.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npx vitest run src/lib/memory/projections.test.ts src/lib/conversation-state.test.ts src/lib/memory/contracts.test.ts --maxWorkers=2` | Local deterministic tests | PASS, 3 files / 36 tests | Stage 07 projection/cache tests plus Stage 06 and contract regressions |
| `MEMORY_TEST_VERBOSE=1 npm run memory:postgres:test` | Fresh disposable PostgreSQL 17 | PASS, 1 file / 16 tests | Real Stage 03–07 transaction, correction, cursor, stale-publication, deletion/purge and scope-isolation suite; five sequential warm refreshes over one assertion version (median 13.41 ms, max 14.81 ms) |
| `node --expose-gc node_modules/vitest/vitest.mjs run src/lib/memory/projections.test.ts -t "measures bounded maximum-input composition separately from database refresh" --silent=false --reporter=verbose` | Local Node/Vitest worker | PASS, 1 benchmark test | Five rounds over 256 synthetic assertion versions: median 16.74 ms, max 38.79 ms, serialized snapshot footprint 57,943 bytes. The Vitest worker did not expose explicit GC, so no JS heap delta is claimed. |
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` | Local offline suite | PASS, 84 files / 947 tests | Full non-live regression suite; the generated Stage 01 timing report was restored unchanged afterward |
| `npx tsc --noEmit` | Local TypeScript | PASS | Exit code 0 after the compute-outside-transaction adjustment |
| `npm run build:cloudflare` | Local Cloudflare/Vite build | PASS | Client and Worker/SSR bundle plus TypeScript check |
| `npm run build` | Local application and realtime builds | PASS | Production client/SSR/Nitro and realtime host bundles |
| `git diff --check` | Local Git worktree | PASS | No whitespace errors after documentation/code staging |

### Acceptance mapping

| Case | Stage 07 evidence | Boundary |
|---|---|---|
| C06 scoped preference | `src/lib/memory/projections.test.ts`, explicit stable and active-topic profile test | The projection keeps the general bullet separate from a topic-local bullet; Stage 08 decides retrieval precedence. |
| C07 expiry | `expires temporary constraints without decaying a still-valid stable preference` | Valid-time expiry is local deterministic proof; no production scheduler is claimed. |
| C19 read-your-writes | Correction overlay test and live revision-2 feed/overlay test | The accepted feed and overlay are implemented; ordinary application retrieval is intentionally deferred to Stage 08/09. |
| C22 deletion | Live Stage 07 deletion test plus existing Stage 05 purge suite | Local PostgreSQL proves dependent projection/member/cache removal; remote deletion deadlines and uncontrolled copies are not proven. |
| C25 outage/lease | Cache test for unavailable authority and five-second expiry | The edge control flow is proven; no staging/production authority outage or live voice behavior was run. |
| C31 self-reinforcement | Duplicate-summary/inference test | Copies are excluded from profile promotion; automatic extraction/promotion policy belongs to Stage 10. |
| C32 model upgrade | Accepted correction overlays ignore older/out-of-order changes and preserve exact accepted lineage | A model-upgrade shadow-diff workflow is not implemented in this stage and is not claimed complete. |

The live test also provides negative evidence: a tampered cursor resets, a cursor from another principal/scope resets, stale prepared work cannot republish after a correction, and a deletion leaves no warm projection, member or managed-cache row for the test scope.

## Operational behavior

- `prepareWarmSnapshot()` requires the server-bound session and `recall` authorization. It reads at most 257 accepted current versions to detect overflow, then composes at most 256; overflow is marked incomplete in the snapshot inspector. Recent changes and source references are also bounded. Authority/authorization failure returns `unavailable` rather than an empty prepared snapshot.
- Composition is synchronous and deterministic. There is no provider call, model extraction, background worker or ordinary context-use counter in the projection builder.
- `publishPreparedWarmSnapshot()` is atomic for projection metadata, member references and the managed private cache entry. A stale epoch/input/watermark/generation returns `stale` and writes nothing. A failed transaction rolls back the projection write and cache write together.
- Warm reads are identity/scope/epoch bound. A missing entry is `cold`; an expired payload/lease is `expired`; an epoch/schema/freshness mismatch is `invalidated` or `unavailable`. Authority failure is surfaced as unavailable and never persists an empty replacement.
- The change feed uses bounded pages of at most 100 entries. A client that falls behind retained history receives `reset_required` and must rebuild from the current authority; it must not apply an untrusted cursor.
- Stage 05 deletion/revocation increments the epochs and purges the dependent rows. Existing purge/status behavior remains the rollback and privacy control. No Stage 07 database rollback is required because no migration ran.
- Disable/revert: do not call the new exports and ordinary application behavior remains unchanged. Reverting the Stage 07 implementation/documentation commits removes the isolated projection adapter while retaining the prerequisite schema and deletion controls; do not drop the shared Stage 03–05 tables.

## Remaining gaps

- No staging, production, deployed Worker, remote migration, live provider, real voice device, or real-user cache/deletion drill was run. Local PostgreSQL is not production proof.
- The projection builder is not connected to ordinary retrieval/context composition, HTTP, realtime voice, cards or the action ledger. Those integrations belong to Stage 08 and Stage 09.
- The edge invalidation listener is an in-process seam; no production push channel or cross-device reconnect protocol is wired yet. The server change feed and epoch checks provide the bounded inputs for that later work.
- The adapter uses the existing managed-cache row and optional Stage 05 private lease validation. Browser caches, provider logs, already-transmitted model context and uncontrolled exports remain outside the canonical deletion authority.
- Full C32 model-upgrade shadow diffs, background extraction and Jev classification are intentionally absent. No inference is promoted by this stage.

## Next stage contract

- Edge-safe callers can import `WarmSnapshot`, `ProfileBullet`, `ConstraintIndexEntry`, `EpisodeHead`, `ProjectionChange`, `ProjectionInspector`, `ProjectionCoverage`, `buildWarmSnapshot`, `applyAcceptedCorrectionOverlays`, `parseWarmSnapshot`, `WarmSnapshotCache` and `SnapshotTelemetryBuffer` from `src/lib/memory/index.ts`.
- Node callers can import `prepareWarmSnapshot`, `publishPreparedWarmSnapshot`, `rebuildWarmSnapshot`, `readWarmSnapshot`, `readProjectionInspector`, `readProjectionChangeFeed`, `encodeProjectionChangeCursor` and their result types from `backend/memory/src/index.ts` or `backend/memory/src/projections.ts`. The session must already be server-bound and backed by `PostgresMemoryStore`; callers cannot supply a new owner, scope or grant.
- The next retrieval layer should treat `snapshot.coveredAssertionRefs`, `snapshot.inspector.dependencies`, `snapshot.coverage`, `snapshot.constraints`, `snapshot.stableProfile`, `snapshot.activeProfile`, `snapshot.activeEpisodeHeads` and `snapshot.recentAcceptedChanges` as replaceable read inputs. It must preserve the exact lineage and use Stage 05 epochs/leases before exposing private content.
- Next prompt: `docs/memory/implementation/08-retrieval-and-composition.md`. Do not begin it as part of this handoff.
