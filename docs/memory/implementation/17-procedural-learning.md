# Stage 17: Optional verified procedural memory

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Learn reusable procedures from independently verified outcomes while preserving action authorization and environment compatibility.

## Prerequisites and entry gate

- Completed [stage 16](16-independent-framework.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Episode/decision evidence, tool-result provenance, framework capability model and evaluation leakage rules.

## Implementation steps

1. Define a versioned declarative procedure manifest: trigger, inputs, preconditions, steps, stop conditions, verification, environment fingerprint, tool versions, required capabilities and source evidence.

2. Separate task procedures from memory-management policies. This stage must not allow learned records to rewrite identity, retention, authorization or extraction policy.

3. Create candidate lessons from attributed episodes containing actual observed outcomes. Assistant claims of success and user silence do not establish a verified procedure.

4. Implement progression from candidate to reviewed to verified version with independent verification records. Keep inconclusive outcomes distinct from success/failure.

5. Require held-out task variants and negative precondition cases before promotion. Do not copy benchmark answers, credentials, temporary IDs or task-specific outputs into reusable procedures.

6. Check environment/tool compatibility at recall. A historically valid deployment step for an old provider must be flagged incompatible or reverified, not presented as current instruction.

7. Keep execution capabilities outside memory: manifests request capabilities; they cannot grant tools, destinations or approval exemptions.

8. Run candidate procedures in shadow/advisory mode against raw episode retrieval and previous procedure versions. Measure independently verified success and harmful shortcut rate.

9. Implement rollback, supersession, source deletion propagation and model-upgrade review. Deleting supporting evidence invalidates unsupported derived procedures.

10. Expose procedure versions/evidence in the inspector and record adoption decisions. Leave automatic procedure execution off unless separately scoped and tested.

## Verification and acceptance scenarios

Relevant seed IDs: **C15, C29, C32** from [acceptance scenarios](../acceptance-scenarios.json).

Attempt procedure prompt injection, stale environment reuse, missing preconditions, claimed-but-unverified success and answer-key leakage. Verify capability checks remain enforced regardless of stored instructions.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Procedure schema/lifecycle, advisory retrieval, verifier history, held-out comparison and explicit activation policy.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/17-procedural-learning.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

Only supported compatible versions are promoted; permissions remain external; measurable task benefit justifies the feature.

## Scope boundary

Optional stage: no self-modifying code, unrestricted shell scripts, automatic model-weight training, or universal self-improvement claim.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 18](18-multimodal-memory.md) as the next prompt.
