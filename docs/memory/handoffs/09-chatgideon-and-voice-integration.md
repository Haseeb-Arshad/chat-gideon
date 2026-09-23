# Stage 09 handoff: ChatGideon HTTP, realtime voice, cards, and the action ledger

Status: LOCAL_VERIFIED

Implementation commit or working-tree identifier: `e4d1896` prerequisite HEAD plus the Stage 09 working tree described below; the final commit hash is recorded by the completion report after verification.

Date: 2026-09-23

Environment: Windows local checkout, PowerShell, Node `v22.13.0`, disposable PostgreSQL 17 used by the owned local memory test harness. No staging or production environment was contacted.

## Prerequisite evidence

- Re-read `docs/memory/implementation/00-COMMON-INSTRUCTIONS.md`, `docs/memory/FOUNDATION-2026-09-21.md`, `docs/memory/implementation/00-PROGRESS.md`, the Stage 09 prompt, and the Stage 08 handoff before editing.
- Stage 08 handoff: `docs/memory/handoffs/08-retrieval-and-composition.md`; its retrieval adapter, context-pack contracts, bounded deep recall, source-only fallback, policy/deletion epoch checks and local PostgreSQL migration 005 were present and reverified through the final Stage 09 PostgreSQL suite.
- Earlier Stage 01–08 handoffs remain in place. No authority, identity, consent, deletion, retention or policy-epoch contract was replaced.
- The selected branch is `fix/reliability-and-memory-isolation`, with Haseeb Arshad as the configured commit author. The branch name contains no Codex marker.

## Implemented behavior

### Shared HTTP/realtime memory adapter

- `src/server/node-memory-integration.ts` is the one Node-side adapter used by both HTTP and realtime. It resolves the server-signed `gideon-owner` cookie, binds the authenticated `MemorySession<PostgresMemoryStore>`, applies the existing principal/scope/grant/policy-epoch boundary, and lazily creates the existing PostgreSQL store only when a capability is enabled.
- `src/lib/openrouter.server.ts` and `src/server/realtime-host.ts` pass the same type of memory runtime into the turn path. The Worker graph remains free of the Node `pg` adapter and continues using its existing account/local/ephemeral authority.
- `src/lib/memory/rollout.ts` adds independent `capture`, `commandWrites` and `recall` controls. `GIDEON_MEMORY_ROLLOUT_PERCENT` is a server-owned stable owner bucket; malformed/unset values are zero. Unauthenticated or ownerless requests are disabled. `NODE_ENV=production` additionally requires `GIDEON_MEMORY_STAGE15_CUTOVER=1`.

### Structured recall, capture and commands

- `src/lib/memory/turn-runtime.ts` binds each recall to turn ID, server-issued response ID, principal, scope, policy epoch, timezone, exact latest-user transcript hash, speculative state, depth and bounded conversation state.
- `src/lib/agent-core.ts` places the Stage 08 `ContextPack` into the model request as attributed, untrusted evidence. Coverage and unavailable status are explicit; retrieved text is not tool authority. Stale or mismatched speculative results are rejected, and speculative turns do not capture or mutate memory.
- The canonical runtime routes `remember`, `correct`, `forget` and deep `recall` through `src/lib/tools/registry.ts`. Pending ambiguity is not reported as accepted. Accepted/final/failed action frames carry receipt state and receipt ID where available. If a canonical runtime exists but one capability is disabled, the action fails closed instead of silently mutating the legacy store.
- Committed user capture is performed once from the final user message. `buildCommittedUserEvent()` creates an authenticated `user_statement` envelope with deterministic event/idempotency keys, exact source-span hashes and no trusted browser assistant history. `backend/memory/src/postgres.ts` assigns the event sequence inside the transaction when requested and `backend/memory/src/serialization.ts` uses semantic event content for idempotency.
- `backend/memory/src/commands.ts` accepts validated exact source spans, includes them in command hashes and evidence, and preserves Stage 04 correction/forget semantics. Database failure/timeout is an unavailable or failed receipt; it never becomes an empty successful save.

### Conversation, speech and card provenance

- `src/lib/protocol.ts` is now version 4. Server-issued response IDs, text segment IDs/ranges, action receipt metadata, card artifact IDs and display revisions are carried over the shared HTTP/socket frame shape.
- `src/lib/realtime-session.ts`, `src/lib/realtime-client.ts` and `src/lib/voice-queue.ts` validate client-supplied speech provenance against server-issued exact text. Forged spans are rejected; accepted audio receives a server-owned segment ID. Late terminal action receipts remain observable after interruption.
- `src/lib/delivery-observations.ts` adds a bounded, deduplicated observation ledger for generated text, sent audio, playback-reported ranges, interruption points and displayed card revisions. Generated text is not treated as heard, playback or agreement. Interruption records conservative bounds rather than inventing an exact heard sentence.
- `src/components/AgentPage.tsx`, `src/components/ResourcesPanel.tsx` and `src/components/stage/Stage.tsx` surface receipt state, record completed tool outcomes independently of speech delivery, report displayed card revisions and retain stable artifact IDs for historical ordering references. A completed action is not erased when its speech is interrupted; a pending action is not treated as completed.
- `src/lib/conversation-state.ts` receives the final tool outcome and card/display provenance. Existing correction, expiry, topic and artifact-reference semantics remain the conversation-state authority.

## Source and schema map

| Concern | Paths | Contract and compatibility |
|---|---|---|
| Rollout and turn binding | `src/lib/memory/rollout.ts`, `src/lib/memory/turn-runtime.ts` | Server-owned identity/cohort; production default off; exact transcript binding |
| Node HTTP adapter | `src/lib/openrouter.server.ts`, `src/server/node-memory-integration.ts`, `src/server/memory-session.ts` | Authenticated signed-cookie owner; PostgreSQL only when enabled; typed unavailable fallback |
| Node realtime adapter | `src/server/realtime-host.ts`, `src/lib/realtime-session.ts` | Same adapter and memory runtime contract as HTTP; no Worker `pg` import |
| Agent/context/action path | `src/lib/agent-core.ts`, `src/lib/tools/registry.ts`, `src/lib/conversation-state.ts` | Context pack is evidence, not policy; canonical runtime fails closed when disabled; legacy direct store remains for compatibility callers |
| Transport protocol | `src/lib/protocol.ts`, `src/lib/realtime-client.ts` | Version 4; optional callback metadata preserves older callback consumers, while supplied provenance is validated |
| Delivery ledger | `src/lib/delivery-observations.ts`, `src/lib/voice-queue.ts` | Bounded server-issued ranges and revisions; no claim that generated text was heard |
| UI integration | `src/components/AgentPage.tsx`, `src/components/ResourcesPanel.tsx`, `src/components/stage/Stage.tsx` | Stable artifact/display revisions and action receipts; no unrelated visual redesign |
| Event/command persistence | `backend/memory/src/serialization.ts`, `backend/memory/src/postgres.ts`, `backend/memory/src/commands.ts` | Existing PostgreSQL authority and migrations retained; no production migration |
| Verification | `src/lib/memory/*.test.ts`, `src/lib/delivery-observations.test.ts`, `src/lib/realtime-delivery.test.ts`, `src/lib/openrouter-memory-integration.test.ts`, `src/server/node-memory-integration.test.ts`, updated agent/card/routing/voice tests | Local control-flow and disposable-authority proof only |

No new schema migration was added in Stage 09. Existing Stage 03–08 migrations remain the authority and were exercised only by the disposable local harness.

## Decisions and deviations

- HTTP and realtime share one Node adapter so identity, flags, retrieval and command receipts cannot diverge by transport. The Worker was not made a PostgreSQL client; that would cross the existing edge/server boundary and belongs to the separately governed migration/cutover work.
- The rollout percentage defaults to zero, and production requires the Stage 15 cutover gate even when individual flags are set. This prevents a deploy-time environment typo from enrolling real accounts.
- Capture stores only the final committed user text once. Assistant history supplied by a browser is not promoted to evidence. Assistant generated text is tracked for delivery provenance but is not automatically durable memory.
- A terminal accepted command is independent from the delivery of its explanatory speech. This keeps an interrupted voice response from erasing a completed action, while pending ambiguity and failed/unavailable outcomes remain visibly non-successful.
- The browser may report playback/display observations, but those reports are untrusted claims bounded by server-issued IDs, exact character ranges and artifact revisions. The UI records an interruption point conservatively and does not claim that the tail was heard or agreed.
- Legacy direct `MemoryStore` callers remain supported when no canonical runtime is supplied. Once a canonical runtime is supplied, disabling its relevant flag fails closed. This prevents the same request from accidentally writing to two authorities.
- The first disposable PostgreSQL Stage 09 run had one quota case hit its 15-second test timeout while the host was loaded. The isolated clean rerun passed all 19/19 tests; the transient first-run timeout is recorded as test-harness load behavior, not as an unresolved local blocker.
- No foundation amendment, new authority, grant broadening, automatic extraction, Jev classifier, production flag enablement, remote migration, or voice-model replacement was introduced.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=1` | Local Node/Vitest | PASS, 92 files / 985 tests | Full offline regression suite; generated Stage 01 timing churn was restored unchanged |
| `npx vitest run src/lib/agent-core.test.ts src/lib/realtime-delivery.test.ts src/lib/memory/rollout.test.ts src/lib/tools/memory-tools.test.ts src/lib/tools/routing.test.ts src/lib/card-frames.test.ts --maxWorkers=1` | Local Node/Vitest | PASS, 6 files / 37 tests | Stage 09 focused agent, transport, rollout, action, routing and card regression |
| `npx tsc --noEmit` | Local TypeScript | PASS | Exit code 0 after the final protocol/runtime changes |
| `npm run build` | Local application/SSR/realtime build | PASS | Client, SSR and realtime bundles; only existing chunk-size/dynamic-import warnings |
| `npm run build:cloudflare` | Local Cloudflare/Vite build | PASS | Client, Worker/SSR and configured type check; no deployment |
| `npm run memory:postgres:test` | Owned disposable PostgreSQL 17 | PASS, 1 file / 19 real database tests on the clean rerun | Capture idempotency, sequence assignment, command receipts, quotas, ambiguity, retrieval and deletion authority checks |
| `git diff --check` | Local worktree/index | PASS | No whitespace errors after documentation and code changes |

### Acceptance mapping

| Case | Executable evidence | Result and boundary |
|---|---|---|
| C01 stable card/history identity | `src/lib/card-frames.test.ts`, `src/lib/delivery-observations.test.ts`, existing conversation-state artifact tests | Server artifact IDs/display revisions and visible snapshots are stable locally; no cross-device live proof |
| C03 interruption before an important sentence | `src/lib/delivery-observations.test.ts`; AgentPage interruption path | Interrupted playback records a bounded point/unknown tail; no exact heard/agreed claim is invented |
| C15 action ledger | `src/lib/agent-core.test.ts`, `src/lib/conversation-state.ts` integration path | Pending/accepted/failed receipt frames and independent final tool outcomes are wired; no background scheduler or automatic commitment extractor is claimed |
| C16 generated/sent/playback distinction | `src/lib/delivery-observations.test.ts`, voice queue/client/session changes | Generated text, issued audio ranges and playback reports remain separate; actual TTS/device timing is not verified |
| C17 forged segment | `src/lib/realtime-delivery.test.ts` | Forged text/span is rejected; exact server-issued span receives a new server audio segment ID |
| C18 speculative recall/write isolation | `src/lib/agent-core.test.ts`, `src/lib/memory/turn-runtime.test.ts` | Transcript/owner/epoch/response binding rejects stale results and speculative turns do not capture or mutate |
| C19 read-your-writes and transport wiring | `src/lib/openrouter-memory-integration.test.ts`, `src/server/node-memory-integration.test.ts`, disposable PostgreSQL suite | Structured retrieval and authenticated event construction are wired; a deployed HTTP+realtime run against shared production authority is not proven |
| C25 outage/failure honesty | `src/server/node-memory-integration.ts`, memory tool/agent regressions | Unavailable/failed receipts preserve the conversation and never imply an empty corpus or successful save |
| C34 conversation continuity | `src/lib/conversation-state.ts`, AgentPage card/action recording and existing state tests | Card revisions and final action outcomes enter bounded conversation state; reconnect/cross-device invalidation remains open |

Meaningful negative evidence includes unauthenticated/ownerless rollout rejection, malformed rollout values, disabled-feature fail-closed behavior, empty/oversized capture rejection, duplicate semantic event handling, exact source-span hash validation, ambiguous command pending state, stale speculative binding, forged audio ranges, duplicate/out-of-order observations, invalid playback bounds, invalid artifact revisions, memory outage handling, and interrupted speech with a completed action receipt.

## Operational behavior

- Startup is lazy. If no Stage 09 capability is enabled for a server-authenticated owner, no Node PostgreSQL memory pool is created. If enabled, the adapter uses the existing `GIDEON_MEMORY_DATABASE_URL` configuration and existing bounded pool/statement-timeout settings.
- Request/turn cancellation is propagated into retrieval and transport handling. Stale speculative work is dropped. An accepted terminal action receipt is still emitted when speech delivery is cancelled so the action ledger remains truthful.
- Database and retrieval deadlines return typed unavailable/failed outcomes. The adapter does not retry a timed-out write as a second unbounded mutation and does not replace the canonical corpus with an empty store.
- Disable safely by leaving the three capability flags unset/zero, setting `GIDEON_MEMORY_ROLLOUT_PERCENT=0`, or withholding `GIDEON_MEMORY_STAGE15_CUTOVER=1` in production. Rollback is a code revert of the Stage 09 commit(s); do not drop the existing shared schema or run a migration rollback for this stage.
- Capture is bounded to one exact latest user source span per committed turn. Delivery observations are bounded/deduplicated in memory and are not durable user memory. Existing Stage 05 deletion/revocation and Stage 07 cache/projection purge remain authoritative.
- The local PostgreSQL harness creates and removes only its owned disposable cluster/schema. No customer data, remote database, deployment, provider credential or paid infrastructure was used.

## Remaining gaps

- No staging/production deployment, cutover, remote migration, real provider, real browser, TTS/device timing, or live voice acceptance was performed. `LOCAL_VERIFIED` must not be read as production or live-voice verification.
- The Worker still uses its existing authority; Node PostgreSQL is not imported into the Cloudflare graph. Stage 15 must own any single-writer migration, rollout and rollback.
- Cross-socket correction invalidation/reconnect/account-switch revalidation has not been proven end-to-end. Each new Node turn rebinds identity and retrieves current authority, but no live multi-device test was run.
- Automatic extraction of commitments/background learning and Jev classification remain later stages. Stage 09 records explicit verified tool outcomes only; it does not infer new durable facts from speech delivery.
- There is no production latency or substantive-audio measurement. Local build/test timings do not establish a voice SLO.

## Next stage contract

- Use `docs/memory/implementation/10-background-learning.md` next. Do not begin it in this stage.
- Later code may import `memoryFeatureFlags()`/`anyMemoryFeatureEnabled()` from `src/lib/memory/rollout.ts`, the exact turn binding/hash helpers from `src/lib/memory/turn-runtime.ts`, and the Node adapter factory from `src/server/node-memory-integration.ts`.
- Later controllers may rely on `MemoryTurnRuntime.retrieve()`, `captureUserTurn()`, and `execute()` receipt states, but must keep the server-bound `MemorySession` as authority and must not accept client principal/scope/grant/policy values.
- Transport consumers should treat response/segment/artifact IDs and ranges as provenance, not proof of user hearing/agreement. Pending/failed/unavailable action frames are not accepted outcomes.
- Stage 10 must add conservative extraction/maintenance behind its own flag and tests without converting speculative or unverified speech into durable memory. It must preserve the Stage 09 stopping boundary and update its own handoff/ledger entry.
