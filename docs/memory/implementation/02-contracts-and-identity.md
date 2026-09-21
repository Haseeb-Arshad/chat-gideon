# Stage 02: Shared contracts, runtime validation, and authenticated memory sessions

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Define the exact semantic and authorization boundary every backend and application adapter must obey.

## Prerequisites and entry gate

- Completed [stage 01](01-baseline-and-receipts.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Foundation sections 4–6 and 10; stage 01 source map; existing account ownership and MemoryStore consumers.

## Implementation steps

1. Add edge-safe types and runtime validators for authenticated principal/client context, subject IDs, scope IDs, grants, event envelopes, assertion versions, evidence refs, projections, commands, receipts and typed failures.

2. Implement MemorySession construction only through a trusted server resolver. Public request payloads cannot set tenant, grant sets or source authority. Model-visible tools receive a prebound session.

3. Separate immutable actor/source attribution from subject-of-claim. A user statement about a colleague is not a self-preference; browser-provided assistant history is not server-authenticated assistant output.

4. Define event fields: idempotency key, conversation and turn ID, source revision, committed phase, sequence, source/received time, consent reference and bounded payload. Define source spans against immutable versioned text.

5. Define assertion payload variants for facts, conditional preferences, constraints, decisions and episode checkpoints. Register scalar/set/event cardinality for canonical slots; allow attributed free-form propositions without guessed slot/entity assignment.

6. Define valid time, system interpretation time and precision. Define correction versus transition versus temporary exception. Unknown effective dates remain unknown; timezone-derived dates preserve the source zone and precision.

7. Specify receipts with captured, accepted, indexed, pending and failed states plus canonical revision/watermark. Define unauthorized, conflict, ambiguous, unavailable, budget-exhausted and validation errors.

8. Specify storage capability contracts with transactions, exact-version lookup, scoped candidate reads, optimistic revision/slot locking, outbox leasing, suppression checks and dependencies. Avoid a get/set abstraction that cannot express guarantees.

9. Implement deterministic policy functions for source basis, grant evaluation, scope binding and payload limits. Retrieved text cannot call or alter these functions.

10. Create contract conformance tests and a test-only in-memory implementation for pure policy/reducer tests. Name it explicitly as a test adapter; it is not a substitute for the next stage's transactional backend.

11. Add serialization/version-compatibility tests and reject unknown unsafe enum states. Document a schema-version upgrade strategy and bounded error payloads.

12. Export only core contracts to the Worker. Prove no PostgreSQL driver, filesystem import or server secret is reachable through the edge-safe entry point.

## Verification and acceptance scenarios

Relevant seed IDs: **C11, C12, C24, C29** from [acceptance scenarios](../acceptance-scenarios.json).

Attempt tenant spoofing, subject/actor confusion, forged assistant attribution, invalid source spans, oversized payloads, cross-scope access and malicious stored instructions. Run runtime validators against malformed JSON, not only typed objects.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Core contracts and validators; trusted session resolver seam; test-only conformance adapter; policy tests and documented API semantics.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/02-contracts-and-identity.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

Identity is bound outside the model/browser payload; core imports are edge-safe; contradictory receipt/time meanings cannot be represented as a successful validated response.

## Scope boundary

Do not implement a second account system, automatically link people by name/email, or broaden current grants.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 03](03-postgres-and-jobs.md) as the next prompt.
