# Stage 11: Jev classification adapter and adoption decision

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Determine whether Jev materially improves the memory workflow; successful completion may recommend keeping it disabled.

## Prerequisites and entry gate

- Completed [stage 10](10-background-learning.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Current official TypeSafe documentation and launch article linked in the foundation; existing extractor/policy interfaces and cost instrumentation.

## Implementation steps

1. Verify current official API access, schema, model/version identifiers, authentication and provider terms relevant to the configured environment. Do not guess endpoint syntax from old examples or unofficial mirrors.

2. Implement a server-only removable adapter for bounded Choice/Score/Noul decisions with timeout, cancellation, request limits and structured errors. Never expose credentials in the browser or logs.

3. Limit initial tasks to candidacy, temporary-versus-durable classification, relation to known candidates and applicability. Jev cannot assign grants, tenants or arbitrary deletion targets.

4. Stage dependent decisions in code: first bind authorized scope and retrieve candidate records, then classify their relationship. Independent questions in one request do not see one another's outputs.

5. Keep the existing extractor for arbitrary names, values and summaries. Define the complete rules/extractor/Jev workflow so its total cost can be compared fairly.

6. Prepare labeled development and held-out examples covering corrections, time, negation, entity ambiguity, quotation, jokes, multilingual text and ASR mistakes. Split by source trajectory and prevent duplicate leakage.

7. Compare rules alone where applicable, conventional structured extraction, extractor plus Jev, and Jev gating followed by extraction. Keep the same underlying examples and downstream reader.

8. Measure per-class precision/recall, false acceptance, selective risk, calibration, escalation frequency, timeout rate, deployment-region latency and complete workflow cost.

9. Choose thresholds on development data according to error cost; a high model confidence is not source truth. Freeze thresholds before held-out evaluation.

10. Implement fail-open only for ordinary conversation, not for unauthorized writes: provider failure falls back to deterministic explicit operations or pending/abstained automatic interpretation.

11. Run in shadow mode and record disagreements for review. Enable only an operation whose improvement survives the matched comparison without unacceptable regressions.

12. Write an adoption ADR with evidence and default flag. If access/spend is unavailable, complete contract tests and record provider verification as blocked/deferred. Do not present mocked results as a successful experiment.

## Verification and acceptance scenarios

Relevant seed IDs: **C03, C06, C07, C11, C12, C28, C30** from [acceptance scenarios](../acceptance-scenarios.json).

C30 must pass without Jev. Validate malformed, timeout, cancelled, low-confidence and contradictory decisions. Test that unrelated optional calls cannot block voice or durable explicit commands.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Optional adapter, labeled evaluation manifest, comparative report or exact external blocker, adoption ADR and tested no-Jev path.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/11-jev-experiment.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

The dependency is removable; there is either measured justification for selected use or an explicit disabled/deferred decision. Live integration cannot be labeled verified without a real call.

## Scope boundary

Do not add Jev to every voice turn or treat vendor type guarantees as evidence of memory accuracy.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 12](12-memory-controls.md) as the next prompt.
