# Stage 08: Hybrid recall, evidence fallback, applicable constraints, and context packs

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Retrieve what changes the answer, including indirect constraints, within explicit latency and token budgets.

## Prerequisites and entry gate

- Completed [stage 07](07-profiles-and-snapshots.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Conversation reference contract, profiles/constraints index, authorization guards, original rank function and evaluation runner.

## Implementation steps

1. Define a RetrievalRequest with authenticated context, current query, resolved topic/entity/artifact IDs, activity, requested time interpretation, consistency mode, token budget and deadline. Unknown referents remain unknown.

2. Implement exact key/entity/current-decision reads and warm lexical retrieval. Build query terms from the resolved request plus the minimal relevant recent span; neither last utterance alone nor whole-history concatenation is sufficient.

3. Add PostgreSQL lexical search and a versioned embedding adapter over authorized accepted text, episodes and permitted evidence. Record model/dimension/content hash and never embed secrets or unauthorized source text.

4. Implement exact vector search first for small test corpora; if adding approximate indexing, verify scope filtering recall and authoritative hydration checks. Never global-top-k then casually post-filter as the only tenant boundary.

5. Run lexical and semantic candidate branches in parallel under a shared deadline. Fuse candidates with a simple deterministic method such as reciprocal rank fusion; tune only on development data.

6. Expand bounded evidence/relationship edges with a visited set and depth/result caps. Keep contradiction bundles intact. Source-span fallback must recover facts an extractor missed.

7. Implement applicable-constraint selection by activity/project/format/conditions independent of lexical overlap. Store inferred association hints separately from facts; do not infer a budget from occupation.

8. Apply current explicit task overrides, validity, authority and exception rules. An old general preference cannot overrule today's explicit task instruction; an instruction cannot elevate tool permissions.

9. Compose attributed sections for conversation state, constraints, relevant facts, conflicts and evidence handles. Count actual rendered prompt tokens with the configured provider tokenizer or an explicitly conservative fallback; reserve answer/tool overhead.

10. Support budget tiers and partial/unavailable/exhausted outcomes. A timeout or empty search cannot justify 'you never said that.' Expose coverage and freshness in the pack.

11. Provide a bounded deep-recall tool seam with cancellation and a maximum expansion/evidence-fetch count. Add optional reranking only after a measured baseline exists; a reranker cannot rescue an absent candidate.

12. Run paired lexical, hybrid and applicability ablations. Record quality, retrieval latency, context size, network/provider cost and filtered-candidate diagnostics without raw sensitive logs.

## Verification and acceptance scenarios

Relevant seed IDs: **C02, C04, C07, C08, C09, C10, C19, C24, C27, C28, C35, C36** from [acceptance scenarios](../acceptance-scenarios.json).

C09 must surface quiet-meeting constraints for a differently worded request; C10 must exclude irrelevant profile material. Test negation, Roman Urdu/code switching, evidence-only recovery, stale prices, disputed facts, tenant isolation and token ceilings. Real semantic-model verification is separate from deterministic vector fixtures.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Retrieval router, lexical/vector adapters, evidence fallback, constraint selector, tokenizer-aware composer, deep-recall contract and ablation report.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/08-retrieval-and-composition.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

Recall returns current authorized evidence with honest coverage/budgets; no required hard constraint is silently discarded by popularity; unavailable providers degrade predictably.

## Scope boundary

Do not require Jev, adopt a graph database, or advertise semantic quality from stub embeddings.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 09](09-chatgideon-and-voice-integration.md) as the next prompt.
