# Stage 10: Conservative extraction, conditional preferences, and bounded maintenance

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Learn useful durable context from ordinary committed conversation without accumulating fabricated or overgeneralized personal facts.

## Prerequisites and entry gate

- Completed [stage 09](09-chatgideon-and-voice-integration.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Event/outbox pipeline, assertion contracts, shadow candidate storage, source spans and episode checkpoints.

## Implementation steps

1. Define extractor input windows using the committed event and the minimal prior context needed for references. Include source IDs and revision boundaries; exclude speculative content, secrets and disallowed categories before any remote request.

2. Implement a replaceable structured extractor returning candidate payloads, exact evidence spans, scope/conditions, polarity, time precision and proposed operation. Validate schema and cited source contents before reconciliation.

3. Handle explicit self-statement, quoted speech, hypothetical/role-play, joke, assistant suggestion, temporary instruction and confirmed tool outcome distinctly. Prefer no-op or candidate status over uncertain permanent claims.

4. Retrieve bounded existing versions through stage 08 to propose no-op, corroboration, add, correction, transition, scoped exception or dispute. A model may propose IDs/relations, but code rechecks ownership, revision and cardinality.

5. Implement independent-evidence counting by original event/episode, not repeated copies or model summaries. Start inferred preferences local to the relevant scope and clearly label them.

6. Promote inferred preferences only through a configurable conservative policy evaluated on development data. Do not treat three sessions as a proof; preserve counterevidence and sensitive-category exclusions.

7. Persist decisions and rejection reasons into episodes; summarize only meaningful transitions/checkpoints. Avoid daily/hourly summary jobs merely because another product uses folders.

8. Commit accepted interpretations with dependencies and producer prompt/model/schema versions. Recheck worker fence, deletion, consent and source revision after model calls.

9. Add token/job limits, per-user fairness, backpressure, bounded retries and dead-letter inspection. Explicit corrections/deletion outrank ordinary learning; exhausted automatic budgets do not disable explicit structured operations.

10. Implement bounded incremental maintenance for expired temporary state, stale views, unresolved candidates and duplicate dependencies. No whole-history nightly rewrite.

11. Support shadow re-extraction on model/prompt upgrades. Produce a diff; preserve accepted user edits and tombstones. Never re-ingest generated profiles as independent evidence.

12. Evaluate extraction precision, missed useful facts, wrong scope, polarity/time errors, candidate promotion and cost. Include English, Urdu/Roman Urdu, code switching and speech corrections.

## Verification and acceptance scenarios

Relevant seed IDs: **C03, C06, C07, C08, C11, C12, C13, C14, C21, C22, C28, C31, C32, C36** from [acceptance scenarios](../acceptance-scenarios.json).

Test the supplied attribution, hypothetical, inference, negation, scoped preference and self-reinforcement cases. Inject deletion/source revision changes while extraction is in flight. Run real-provider labeled samples only with configured access and authorized spend; record mock plumbing separately.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Extractor interface/adapter, candidate reconciliation, promotion policy, maintenance jobs, cost bounds and extraction-quality report.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/10-background-learning.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

Each accepted item has valid source support and scope; worker races cannot override correction/deletion; ordinary implicit learning is measurable and independently disableable.

## Scope boundary

Do not train model weights, create sensitive personality profiles, or enable unrestricted self-modifying procedures.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 11](11-jev-experiment.md) as the next prompt.
