# Stage 07: Profiles, warm snapshots, and immediate correction overlays

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Build fast, inspectable read projections that preserve source lineage and never become an independent authority.

## Prerequisites and entry gate

- Completed [stage 06](06-conversation-state.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Canonical versions/change feed, conversation checkpoints, deletion epochs and current owner Durable Object cache.

## Implementation steps

1. Implement profile bullets as references to accepted assertion versions plus compact rendered text. Each bullet exposes basis, scope, source and reason for promotion; keep stable defaults separate from active topics.

2. Start promotion with explicit eligible preferences and decisions only. Inferred preferences remain candidates until stage 10's policy exists. Never promote a generated summary as independent evidence.

3. Build warm snapshot payloads containing the stable profile, active episode heads, constraints index, precomputed lexical tokens/frequencies, recent accepted changes and coverage/freshness metadata.

4. Persist projection dependencies and input watermarks. Compute outside long transactions; recheck versions/epochs before publishing. Stale computations are discarded or explicitly marked stale.

5. Implement a bounded signed/opaque change cursor or equivalent authenticated watermark protocol. Paginate deltas; define reset behavior when a client falls behind retained change history.

6. Apply recent accepted correction overlays ahead of old snapshots. Remove/rewrite superseded bullets immediately; do not depend on lease validity as proof of data freshness.

7. Implement private cache lease renewal and push invalidation with identity, scope, policy and deletion binding. Batch/coalesce renewals where safe; measure control-plane traffic.

8. Handle cold start, missed invalidation, out-of-order updates, reconnect and authority outage. On expired private leases, continue without private memory; do not write an empty replacement corpus.

9. Keep usage telemetry outside canonical record mutation and ordinary context selection. Buffer bounded counters and distinguish retrieved, included, cited and independently useful.

10. Expire temporary constraints by valid time. Never decay a still-valid important preference solely because it was rarely recalled.

11. Expose projection inspector data: version, input coverage, age, dependencies, missing inputs, conflicts and why each bullet is present.

12. Load-test local composition and snapshot refresh separately. Record memory footprint and serialized size; set configurable bounds without deleting durable facts.

## Verification and acceptance scenarios

Relevant seed IDs: **C06, C07, C19, C22, C25, C31, C32** from [acceptance scenarios](../acceptance-scenarios.json).

Verify correction revision 12 supersedes snapshot 11 immediately; deletion invalidates all dependent views; stale workers cannot republish; duplicate summaries do not create new evidence. Test lease expiry and reconnect against actual time controls.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Projection builders, change-feed consumer, warm snapshot cache, recent overlays, telemetry buffering and cache-conformance tests.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/07-profiles-and-snapshots.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

Every bullet traces to permitted accepted evidence; stale/deleted projections are excluded; warm reads perform no canonical use-counter writes.

## Scope boundary

Do not enable ordinary production retrieval or introduce indefinite private cache leases.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 08](08-retrieval-and-composition.md) as the next prompt.
