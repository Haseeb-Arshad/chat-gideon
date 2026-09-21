# Stage 05: Privacy deletion, grant revocation, and resurrection prevention

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Implement enforceable forgetting and access revocation before introducing more derived copies.

## Prerequisites and entry gate

- Completed [stage 04](04-commands-and-temporal-versions.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Foundation deletion/caching rules, schema dependency graph and all current read/write APIs.

## Implementation steps

1. Implement authorized exact-target deletion plans bound to actor, scope, target versions and short expiry. Unambiguous user-authorized operations need no redundant UI confirmation; ambiguity must be resolved before committing targets.

2. Define separate semantics for expiry, supersession, retraction and privacy deletion. Expose those explicitly in commands and tests.

3. In the logical-blocking transaction, install suppression, advance epochs, invalidate affected records/projections and cancel/restrict pending input jobs. Return a receipt that says reuse is blocked, not that every physical copy is already erased.

4. Walk dependency edges with bounded jobs. If a summary lacks precise per-claim lineage, invalidate the whole summary and rebuild only from permitted surviving inputs.

5. Enforce suppression on exact reads, historical reads, candidate hydration, exports, inspector access and worker commit. Future adapters must pass these same guards.

6. Implement physical purge tasks for source spans within scope, derived records, indexes and managed caches. Minimize tombstones: use non-content IDs and source watermarks, not copies of deleted text or reversible low-entropy hashes.

7. Implement grant revocation with an epoch change distinct from deleting the underlying user's data. Losing one app's grant must not erase independent authorized copies in other scopes.

8. Define private snapshot lease semantics and the promised revocation window. Account-session caching must not silently exceed this claim; either tighten/revalidate identity or state a weaker measured bound.

9. Add pre-dispatch epoch checks and cancellation hooks for controllable in-flight responses. Document that content already delivered or transmitted to an external model cannot be retroactively recalled.

10. Implement restore guard: a database restored from an old backup cannot serve until the independent deletion/revocation ledger is reconciled. Test the replay order and readiness behavior.

11. Provide retention and purge status APIs with bounded retries, failed-purge visibility and documented backup-retention limits. Do not call uncontrolled exported clones revocable.

12. Run deletion races against capture, extraction, projection publication, import, retrieval and lease expiry. Keep content out of ordinary logs.

## Verification and acceptance scenarios

Relevant seed IDs: **C22, C23, C24, C25, C29** from [acceptance scenarios](../acceptance-scenarios.json).

Use real PostgreSQL for deletion during an in-flight worker and stale restore. Verify C22–C25 and malicious memory authority claims. Inspect canonical rows, source text, projections and indexes, not just the assistant's response.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Deletion/revocation commands, suppression guards, purge worker, status receipts, restore protocol and adversarial race tests.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/05-deletion-and-revocation.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

Accepted deletion blocks subsequent authorized canonical reuse and stale jobs cannot resurrect it; physical and backup purge limitations are honestly represented.

## Scope boundary

Do not promise instant global deletion or indefinite offline private recall; do not run deletion drills on real user data.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 06](06-conversation-state.md) as the next prompt.
