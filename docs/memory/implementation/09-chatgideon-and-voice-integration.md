# Stage 09: Integrate memory into HTTP, realtime voice, cards, and the action ledger

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Make the implemented runtime usable in ChatGideon while preserving speculation, transport parity and truthful conversation history.

## Prerequisites and entry gate

- Completed [stage 08](08-retrieval-and-composition.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

src/lib/agent-core.ts, registry.ts, realtime-session.ts, audio/player.ts, voice queue/abort, backend Worker API/session paths and relevant regression tests.

## Implementation steps

1. Trace the current HTTP and socket ownership flows and choose one shared application adapter for MemorySession creation. Preserve anonymous authenticated accounts and request-local fallback for unverified callers.

2. Add independently controlled capture, command-write and recall flags. Keep rollout cohort selection server-owned; default new production behavior off until stage 15.

3. Replace plain fact injection with the structured context pack and conversation state. Keep existing factual research/map/card routing and voice choice unchanged unless required for memory correctness.

4. Expose remember/correct/forget and deep recall through versioned commands, not direct array mutation. Translate receipts into concise speech and action-ledger states: pending, stored/accepted, indexed, failed.

5. Capture committed user events and source revisions once. Do not turn browser-supplied assistant histories into trusted evidence. Use server-issued response/segment IDs for generated and sent content.

6. Add bounded playback/display observations tied to those IDs. Distinguish generated, sent, playback-reported, displayed, acknowledged and interrupted. Without reliable timing alignment, use unknown/conservative bounds rather than exact heard-word claims.

7. Persist verified tool outcomes independently of speech delivery. Interrupting a response invalidates pending conversational delivery but does not erase a completed action.

8. Bind speculative recall to owner/scope, transcript hash, turn generation and policy epochs. Reject stale results at commit; discard hypotheses without durable events, profile changes or usefulness writes.

9. Connect card display revisions and stable artifact IDs to conversation state. Resolve historical 'second one' against its original visible ordering.

10. Carry recent accepted corrections into the next turn immediately. Propagate cache invalidation across open sockets and revalidate after reconnect/account changes.

11. Surface memory outages internally as unavailable while preserving graceful conversation. Never overwrite a durable corpus with an empty fallback; never pronounce a successful save on timeout.

12. Run enabled-feature end-to-end tests for both typed HTTP and direct realtime transport, then real voice/browser checks where available. Measure time to substantive audio as well as first byte/filler.

## Verification and acceptance scenarios

Relevant seed IDs: **C01, C03, C15, C16, C17, C18, C19, C25, C34** from [acceptance scenarios](../acceptance-scenarios.json).

Run existing speculative, voice-abort, transport and realtime-session regression suites plus memory tests. Verify forged segments, interruption before an important sentence, committed late negation, duplicate delivery, cache expiry and cross-device correction.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Application adapters, feature flags, ledger integration, voice/card provenance, enabled-mode HTTP/socket tests and local end-to-end report.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/09-chatgideon-and-voice-integration.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

The same owner sees consistent accepted memory across transports; speculative work has no durable side effects; generated speech is not treated as heard or agreed.

## Scope boundary

No production cutover yet; no unrelated visualization redesign or voice-model replacement.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 10](10-background-learning.md) as the next prompt.
