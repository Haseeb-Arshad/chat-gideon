# Stage 06: Conversation state, reference resolution, and episode continuity

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Implement the conversation's current meaning so continuity does not depend solely on long-term similarity search.

## Prerequisites and entry gate

- Completed [stage 05](05-deletion-and-revocation.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Existing agent-core history construction, screen/card descriptions, realtime session transport, and foundation conversation contract.

## Implementation steps

1. Define a bounded ConversationState with active topic, suspended-topic stack, entity/referent candidates, artifact display revision, choices, rejections/reasons, local constraints, open questions, request/proposal/outcome states and source watermark.

2. Implement deterministic reducers for committed turns, explicit corrections, artifact changes, selections, interruptions and verified tool outcomes. Use source turn IDs/revisions and avoid mutating accepted global preferences through this reducer.

3. Maintain a recent verbatim window and a checkpoint summary with coverage interval. If summary coverage lags, include recent uncovered turns rather than pretending the checkpoint is current.

4. Represent ambiguous references as candidate sets. Resolve 'the second one' against a specific artifact display snapshot and stable IDs; do not use current search result ordering.

5. Implement topic suspension and explicit resumption. Bound stack growth and checkpoint meaningful open topics under the authorized session's retention policy.

6. Store decisions with alternatives, choice, stated rejection reasons and unresolved factors. A rejected option does not imply a global brand/person/category dislike.

7. Separate user request, assistant proposal, accepted commitment, scheduled task receipt and verified completion. The assistant's sentence cannot prove an external action or consent.

8. Apply local corrections to entity references and invalidate descendants of an incorrect turn interpretation. Preserve final committed speech when an earlier ASR hypothesis differed.

9. Provide an optional interpretation interface for complex turns. Initially use deterministic structured fixtures and existing model integration only where available; do not insert a mandatory new remote preprocessing call before each voice response.

10. Persist and resume authorized episode checkpoints across sessions. Casual topics should work without requiring a full project/workstream object.

11. Implement expiry for temporary state and cross-session selection that asks one targeted question when several topics genuinely fit. Do not merge similar names into a single person.

12. Write reducer, persistence and replay tests. Prove deterministic replay from committed events and report which semantic interpretations still require a model.

## Verification and acceptance scenarios

Relevant seed IDs: **C01, C02, C03, C06, C08, C11, C12, C14, C15, C34, C36** from [acceptance scenarios](../acceptance-scenarios.json).

Exercise references after card reordering, two ambiguous projects, scoped formality, quoted preferences, a hypothetical move, rejected laptop reasons, unresolved plans and topic resumption. Assert source IDs and forbidden global inferences.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Conversation state schema/reducer, authorized checkpoint persistence, reference-resolution contract, replay tests and episode resume API.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/06-conversation-state.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

The system retains what was decided and why; it distinguishes ambiguity, proposals and verified outcomes; it can resume a topic without conflating unrelated preferences.

## Scope boundary

Do not implement autonomous reminders, psychological profiling, or a separate workflow engine.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 07](07-profiles-and-snapshots.md) as the next prompt.
