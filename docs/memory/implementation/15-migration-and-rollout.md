# Stage 15: Single-writer migration, rollout, and rollback

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Prepare and rehearse an auditable cutover from the legacy store; deploy only within the environment explicitly authorized by the user.

## Prerequisites and entry gate

- Completed [stage 14](14-operational-hardening.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Current live/deployment configuration only as authorized, legacy store/CAS ownership, canonical command service and operational runbook.

## Implementation steps

1. Write an environment-specific migration manifest: owner scopes, legacy source, destination, revision/fence mechanism, snapshot/import IDs, expected counts, protected data and rollback responsibilities. Start with synthetic local data.

2. Implement idempotent legacy import preserving record IDs/text and source creation metadata with legacy_import basis. Do not fabricate source conversations, approval or real-world effective dates.

3. Validate counts, content hashes and sampled current/historical reads. Report malformed legacy rows as rejected/quarantined with reason; do not silently drop them.

4. Implement per-scope writer fencing. Pause or queue old writes, capture final revision/delta, import it, compare expected revision and atomically mark the new authority active. HTTP and sockets must obey the same fence.

5. Define in-flight command behavior and honest local-versus-central receipts during cutover. Retry with stable idempotency keys; avoid simultaneous independent reconciliation engines.

6. Generate any legacy compatibility view from the new authority using suppression filters. The old array becomes a projection, never an independent writable source.

7. Rehearse rollback after new corrections and deletion. Rollback disables the new retrieval path or uses a current safe projection; it cannot restore a stale pre-deletion writable snapshot.

8. Run shadow capture/recall with isolated candidate state, then an internal synthetic cohort. Compare corrections, continuity, source coverage and latency before expanding.

9. Prepare exact deployment/migration commands and configuration checks without printing secrets. If the user has not authorized an environment's deployment/data migration, finish local rehearsal and provide the concrete ready-to-run handoff; do not request approval for completed reversible development.

10. When staging/production action is explicitly authorized, execute the reviewed manifest, verify the actual deployed hostname, authenticated account ownership, HTTP routing, realtime socket behavior and cross-device correction. A successful build or deploy command alone is not domain proof.

11. Use measured stop conditions: false receipts, unauthorized disclosure, resurrection, lost writes, unacceptable backlog or quality/latency regression. Record cohort exposure and rollback invocation.

12. Write separate local, staging and production outcomes. A local cutover rehearsal can pass while a public launch remains not performed; preserve that distinction in the ledger.

## Verification and acceptance scenarios

Relevant seed IDs: **C19, C20, C21, C22, C23, C24, C25, C26** from [acceptance scenarios](../acceptance-scenarios.json).

Rehearse new writes during the fence, duplicate import, reconnecting stale socket, rollback after deletion, and two devices updating one fact. Validate actual routes on the authorized environment rather than only provider deployment IDs.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Import/cutover tooling, migration manifest, local rehearsal artifacts, rollback drill and deployment evidence only where authorized.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/15-migration-and-rollout.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

Exactly one authority accepts canonical writes per scope; imported state and receipts reconcile; rollback cannot resurrect deleted content. Production verification requires real deployment evidence.

## Scope boundary

No blanket production authorization is implied by this document, no dropping the legacy source before retention/rollback requirements are met, and no account identity reassignment by guessed names.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 16](16-independent-framework.md) as the next prompt.
