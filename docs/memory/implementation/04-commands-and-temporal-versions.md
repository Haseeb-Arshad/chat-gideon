# Stage 04: Explicit commands, correction semantics, and temporal history

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Make explicit memory writes and corrections reliable before adding automatic learning.

## Prerequisites and entry gate

- Completed [stage 03](03-postgres-and-jobs.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Canonical contracts, transaction API, temporal examples and the legacy tool receipt behavior.

## Implementation steps

1. Implement remember, correct and scoped-exception commands over a server-bound MemorySession. Validate exact target IDs/revisions; natural-language target resolution may return ambiguous instead of choosing a destructive top-k match.

2. For remember, commit the accepted assertion, evidence edge and change notification atomically. Preserve original supporting evidence and any registered slot cardinality.

3. For correction of a false interpretation, retract/supersede the old interpretation while preserving allowed audit history. Do not describe the incorrect value as historically true.

4. For an actual real-world transition, preserve old valid intervals and create the new state from its effective date. Store the system interpretation time independently; keep uncertain precision.

5. For a contextual override, store explicit scope/conditions/expiry without rewriting unrelated global preferences. Current task instructions override relevant defaults in composition, not through global deletion.

6. Implement deterministic duplicate handling using exact canonical identity or formatting equivalence. Semantic similarity alone cannot merge contradictory quantities, entities or polarity.

7. Apply slot locks/expected revisions from stage 03; conflicting simultaneous scalar changes must serialize or surface a conflict/dispute. Record both attributable inputs rather than last-arrival-wins.

8. Commit accepted versions and an outbox invalidation/change-feed event together. Return revision and watermark only after commit.

9. Provide exact current and as-of query functions, including what-was-known-at-time versus what-was-valid-at-time. Suppression gates apply even to historical queries.

10. Implement admission/quota policy with explicit errors or documented retention choices. Hot context selection cannot delete durable accepted records.

11. Add a recent accepted-change overlay contract for later sessions: a correction receipt can immediately override an older snapshot. Do not pretend a merely captured event is an accepted assertion.

12. Add tests for retry after ambiguous network failure, source revision changes, expected-version mismatch and whole-transaction rollback. Write examples for the future UI/tool adapter.

## Verification and acceptance scenarios

Relevant seed IDs: **C04, C05, C06, C07, C19, C20, C21, C26, C33, C36** from [acceptance scenarios](../acceptance-scenarios.json).

Exercise C04–C07, C19–C21, C26/C33/C36 with exact version and time assertions. Test backdated imports arriving after a current correction. Verify receipts after a successful commit and after injected failures.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Command service, current/historical reads, quota/admission responses, version change feed, transaction tests and sample request/receipt pairs.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/04-commands-and-temporal-versions.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

No acknowledged edit is lost; correction/transition/exception semantics remain distinct; deterministic explicit operations work without an LLM.

## Scope boundary

No implicit preference inference, profile rewriting by a model, or destructive semantic matching.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 05](05-deletion-and-revocation.md) as the next prompt.
