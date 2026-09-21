# Stage 13: Held-out conversational evaluation and competitive comparison

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Produce reproducible evidence of conversational benefit and identify which mechanisms justify their complexity.

## Prerequisites and entry gate

- Completed [stage 11](11-jev-experiment.md) and its handoff, including the actual interfaces/tests it established.
- Completed [stage 12](12-memory-controls.md) and its handoff, including the actual interfaces/tests it established.

Stage 11 may record a measured rejected/disabled or explicitly deferred Jev decision. That does not prevent no-Jev evaluation; it does prevent claiming verified Jev quality.


If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

All stage handoffs, fixture coverage, foundation evaluation protocol, original dataset protocols/licenses and current competitor adapter documentation.

## Implementation steps

1. Finalize the runner's separation of construction, retrieval/composition and downstream answering metrics. Every output records system config, source cutoff, reader, judge, prompts, model/index versions, seed and timing boundaries.

2. Implement all 36 seed scenarios across the relevant storage, projection, transport and answer layers. They are development/conformance cases; author independent holdout trajectories and paraphrases before tuning.

3. Add baselines for no long-term memory, repaired legacy ChatGideon, profile plus searchable summaries, lexical, hybrid, full runtime without applicability, and full runtime without/with Jev where evaluated.

4. Integrate at least one established provider only through supported scoped APIs with synthetic or explicitly authorized data. Record capabilities that cannot be matched, such as deletion or provenance, rather than simulating them.

5. Read and pin the original LongMemEval, PersonaMem, LoCoMo-Plus and selected additional protocols/licenses before implementing adapters. Preserve official evaluation and report modified conversational variants separately.

6. Prevent time leakage: ingest only history available at the query cutoff, separate users/trajectories across splits, and keep expected answers out of extraction/retrieval/model prompts.

7. Run controlled-reader/prompt/context/deadline comparisons and a separate best-practical-configuration track. Count ingestion models, time-to-ready, embeddings, reranking, extra context and serving costs.

8. Add an oracle-evidence diagnostic to locate reader versus retrieval failures. Label it diagnostic and exclude it from competitive rankings.

9. Measure supported constraint adherence, correct resumption, false personal claims, repeat-correction rate, unnecessary personalization, temporal correctness, abstention, latency and total cost. Report subgroup failures for language, negation and context length.

10. Use blinded judges, deterministic checks and human-reviewed samples. Record judge disagreement and repeated-run variability; do not treat one model's preferences as ground truth.

11. Preregister the primary metric, improvement threshold, non-inferiority bounds and cluster-aware sampling plan. Compute paired trajectory-level intervals and publish sample sizes. Small pilots are diagnostic, not proof of superiority.

12. Run ablations for conversation state, reasons/conditions, source fallback, hybrid retrieval, applicability, overlays and Jev. Remove or disable components that add cost without a relevant measured benefit.

13. Publish a reproducibility manifest, actual result artifacts and an honest release recommendation. If external access is missing, complete the local harness/report and mark the comparison blocked; no fabricated competitor rows.

## Verification and acceptance scenarios

Relevant seed IDs: **C01, C02, C03, C04, C05, C06, C07, C08, C09, C10, C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C21, C22, C23, C24, C25, C26, C27, C28, C29, C30, C31, C32, C33, C34, C35, C36** from [acceptance scenarios](../acceptance-scenarios.json).

Check runner arithmetic on hand-calculated fixtures, split isolation, query cutoffs, denominator handling and judge prompt contamination. Verify failures and missing cases remain visible. Confirm no fixture-only run is labeled live or competitive.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Benchmark adapters, independent held-out manifest, complete seed coverage, paired reports, cost/latency tables, ablations and release recommendation.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/13-comparative-evaluation.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

Results can be reproduced from a manifest and distinguish local conformance, real-model quality and external comparisons; a competitive claim requires actual matched evidence.

## Scope boundary

Do not tune on hidden answers, publish private conversations, or reduce all safety/quality metrics to one flattering average.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 14](14-operational-hardening.md) as the next prompt.
