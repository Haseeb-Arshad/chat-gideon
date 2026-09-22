# Stage 06 handoff: conversation state, reference resolution, and episode continuity

Status: LOCAL_VERIFIED
Implementation commit or working-tree identifier: `7ca0858` (`feat(memory): add conversation state continuity`)
Date: 2026-09-22
Environment: Windows local checkout, Node `v22.13.0`, disposable PostgreSQL 17 for the live authority suite

## Prerequisite evidence

- Re-read the common instructions, foundation, progress ledger, Stage 05 handoff, and the complete Stage 06 prompt before editing.
- Stage 05 handoff: `docs/memory/handoffs/05-deletion-and-revocation.md`, implementation commit `a68ee5a`, finalized documentation commit `22b3eef`.
- Stage 05 entry gate was reverified on branch `fix/reliability-and-memory-isolation`; the checkout was clean at `22b3eef` before Stage 06 work began.
- The existing `episode_checkpoint` assertion kind, evidence/dependency edges, suppression checks, and purge control plane were reused. No new PostgreSQL migration was required.

## Implemented behavior

- `src/lib/conversation-state.ts` provides a bounded, deterministic reducer and replay API for committed user/assistant turns, explicit corrections, artifact display revisions, stable selections, referent candidates, topic suspension/resumption, local constraints, decisions, open questions, requests, proposals, commitments, verified tool outcomes, interruptions, checkpoint summaries, and expiry.
- Recent turns retain committed source, revision, delivery phase, and heard text. An interruption uses the heard prefix for context; an ASR hypothesis can be replaced by a final correction, and correction lineage invalidates direct and transitive descendants.
- Artifact references can resolve against an exact artifact/display revision. An ordinal from an old display cannot silently follow a reordered display. Topic resolution returns one focused ambiguity question when multiple bounded topics match.
- Decisions retain alternatives, selected choice, stated reasons, rejection reasons, and unresolved factors. Local constraints are scoped to the active topic; replacing a constraint id changes the current local instruction without creating a global dislike or preference.
- Conversation context is explicitly labelled attributed continuity data, never an instruction or authority grant. It includes checkpoint coverage and the recent committed turns not covered by a lagging checkpoint. It distinguishes verified tool outcomes from unverified proposals/commitments.
- `backend/memory/src/episodes.ts` adds `persistEpisodeCheckpoint()` and `resumeEpisodeCheckpoint()` for an authorized PostgreSQL session. Persistence writes the server-generated checkpoint event, accepted `episode_checkpoint` assertion version, evidence edges, and accepted receipt in one transaction. Retry idempotency is keyed by episode and source watermark and reuses the original event sequence.
- The transport carries the validated bounded snapshot over WebSocket and HTTP fallback. `AgentPage` records final user transcripts, committed assistant text, display revisions/selections, and heard-text interruption corrections locally in the snapshot sent with subsequent turns. Speculative turns do not enter the state until the final transcript is committed.

## Source and schema map

| Concern | Paths | Contract |
|---|---|---|
| State model, reducers, replay, resolution, context | `src/lib/conversation-state.ts` | Edge-safe; no framework, Node, database, provider, identity, or secret imports |
| Deterministic state tests | `src/lib/conversation-state.test.ts` | Eight focused tests cover exact display revisions, ambiguity, correction, local decisions, verified outcomes, topic resumption, override, round-trip and expiry |
| Episode payload contract | `src/lib/memory/contracts.ts`, `src/lib/memory/contracts.test.ts` | `EpisodeCheckpointPayload.state` is a bounded JSON snapshot and is runtime validated |
| PostgreSQL persistence/resume | `backend/memory/src/episodes.ts`, `backend/memory/src/index.ts` | Node-only authorized session; `remember` for writes, `recall` for resume; uses existing assertion/evidence/receipt tables |
| Realtime/HTTP state transport | `src/lib/agent-core.ts`, `src/lib/protocol.ts`, `src/lib/realtime-session.ts`, `src/lib/realtime-client.ts`, `src/lib/openrouter.server.ts`, `src/routes/api.chat.ts`, `backend/worker/src/api.ts` | Invalid or oversized browser snapshots are ignored; state does not supply owner, scope, grants, policy epoch, or action authority |
| Browser event capture | `src/components/AgentPage.tsx` | Final/committed events only; conversation reset starts a new bounded conversation state |
| PostgreSQL conformance | `backend/memory/src/postgres.live.test.ts` | Fifteenth live test covers checkpoint idempotency, revision update, fresh-session resume, scope isolation, and deletion/purge |

No migration, feature flag, provider adapter, autonomous reminder, workflow engine, or new authority store was added. Stage 05 evidence edges mean deletion suppression and physical purge already cover checkpoint state and source-linked revisions.

## Decisions and deviations

- The canonical `episode_checkpoint` assertion variant was extended with the full bounded state rather than introducing an episode-specific table. This preserves the Stage 03–05 transaction, evidence, deletion, suppression, and receipt semantics.
- Checkpoint state is written only through an explicitly authorized server-side helper with a memory capture/retention consent reference. The browser may carry state for context but cannot write PostgreSQL directly and cannot provide identity or grants.
- The checkpoint event is server-generated and the assertion is attributed to Gideon as an inference over supplied committed evidence. A proposal, assistant promise, or display event is not represented as verified completion without an explicit verified tool outcome.
- The HTTP/realtime carry path is intentionally a bounded continuity seam, not the Stage 09 full memory/action integration. There is no automatic checkpoint cadence, consent prompt, user inspector, or production route in this stage.
- No foundation amendment was needed. Similar names remain separate; topic-local state is filtered on resume; omitted/invalid snapshots fail closed to ordinary turn context rather than becoming an empty durable corpus.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npx tsc --noEmit` | Local TypeScript | PASS | Exit code 0 after final implementation commit |
| `npx vitest run src/lib/conversation-state.test.ts src/lib/memory/contracts.test.ts --maxWorkers=2` | Local deterministic tests | PASS, 2 files / 25 tests | Focused reducer, contract, correction, ambiguity and round-trip tests |
| `npm run memory:postgres:test` | Fresh disposable PostgreSQL 17 | PASS, 1 file / 15 tests | Real transaction, idempotency, revision, resume, scope isolation, deletion/purge and prior Stage 03–05 cases |
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` | Local offline suite | PASS, 83 files / 936 tests | Full non-live regression suite |
| `npm run build:cloudflare` | Local Cloudflare/Vite build | PASS | Client and Worker/SSR bundle plus TypeScript check |
| `npm run build` | Local application and realtime builds | PASS | Production client/SSR/Nitro and realtime host bundles |
| `git diff --check` | Local Git worktree | PASS | No whitespace errors |

Seed/acceptance mapping exercised by the Stage 06 implementation:

- C01: `resolves an ordinal against the exact display revision that was shown`.
- C02: `asks when two suspended or active topics match instead of merging them`.
- C03: `lets a final correction replace an ASR hypothesis and invalidates its descendants`.
- C06: `keeps constraints and choices local to their topic` plus constraint replacement coverage.
- C08: the decision fixture preserves Laptop A's fan-noise rejection reason without a global brand/budget inference.
- C11/C12: existing contract coverage in the same focused suite preserves third-party quote attribution and hypothetical speech boundaries; the new state layer accepts only explicit caller-supplied events.
- C14/C15: the decision checkpoint retains alternatives/unresolved cost, while proposal/accepted commitment remains outside verified outcomes until the tool receipt event.
- C34: `resumes a suspended topic without importing another topic’s local constraint`.
- C36: `replaces a temporary local instruction while preserving old history outside the active state`.

The live test also provides negative evidence: the same checkpoint is idempotent, another owner cannot resume it, and deletion followed by bounded purge makes the checkpoint unavailable.

## Operational behavior

- State reduction is synchronous and deterministic. There is no remote model call in the reducer, no background task, and no mandatory preprocessing on a voice turn.
- WebSocket and HTTP fallback validate the snapshot before adding it to model context. A stale/invalid/oversized browser snapshot is ignored; server-bound identity, scope, grants, policy epoch, and memory session remain independently selected by the host.
- PostgreSQL writes run in the existing transaction authority. A failed transaction produces no checkpoint event, assertion version, or accepted receipt. Repeating the same episode/source watermark returns the original accepted receipt and version; different content under that key returns a conflict.
- Resume applies deterministic expiry. A globally expired state or expired checkpoint returns `expired`; a missing, suppressed, cross-scope, or purged checkpoint returns `not_found` without exposing another scope.
- Every persisted checkpoint assertion includes the generated checkpoint event and supplied source-event evidence. Stage 05 deletion suppression therefore blocks reads/reuse and purge removes content-linked rows while retaining only the existing non-content tombstone semantics.
- Disable/revert: callers can omit `conversationState` to return to ordinary turn context; no rollout flag was enabled. The implementation can be reverted with the Stage 06 implementation commit while retaining the prerequisite Stage 05 commits. No database rollback is needed because no migration ran.

## Remaining gaps

- No staging, production, deployed Worker, remote database, live provider, real voice device, or real-user checkpoint/deletion drill was run. Local PostgreSQL is not production proof.
- The model still supplies interpretation events such as explicit decisions, topic labels, corrections, and verified tool outcomes. Stage 06 does not invent those events from raw language, and it does not add Jev or another classifier.
- There is no user-facing checkpoint inspector, automatic consented checkpoint schedule, cross-device resume UI, or canonical memory/action ledger integration. Those belong to later stages.
- Browser caches, provider logs, already-transmitted model context, and uncontrolled exports remain outside the deletion authority, as documented by Stage 05.

## Next stage contract

- Edge/runtime callers can import `ConversationState`, `ConversationEvent`, `createConversationState`, `reduceConversationState`, `replayConversationState`, `resolveArtifactReference`, `resolveTopic`, `checkpointConversationState`, `expireConversationState`, `readConversationState`, `serializeConversationState`, and `conversationContext` from `src/lib/conversation-state.ts`.
- Node PostgreSQL callers can import `persistEpisodeCheckpoint`, `resumeEpisodeCheckpoint`, and their result/input types from `backend/memory/src/index.ts` or `backend/memory/src/episodes.ts`. The session must be server-bound and backed by `PostgresMemoryStore`; callers supply consent and bounded source-event ids, never scope or grants.
- `EpisodeCheckpointPayload.state` is required and bounded. Existing Stage 05 suppression, evidence, canonical-key and purge behavior must remain intact when Stage 07 adds projections.
- Next prompt: `docs/memory/implementation/07-profiles-and-snapshots.md`. Do not begin it as part of this handoff.
