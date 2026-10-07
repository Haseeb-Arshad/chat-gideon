# GIDEON memory: the plan from 7 to 9.5

Proposal, 5 October 2026. Every number below is a target to prove with the evaluation in phase 6, not a result.

## Where the 7 comes from

| Dimension | Weight | Today | Target | Why today's score |
|---|---|---|---|---|
| Safety and privacy | 25 | 9.5 | 9.5 | Provenance, consent, deletion with tombstones, resurrection prevention, single-writer cutover |
| Data model | 20 | 9 | 9.5 | Versioned assertions with basis, status, valid time, scope, evidence |
| Evaluation | 15 | 8 | 9.5 | Honest pre-registered pilot, but 33 questions and no public benchmarks |
| Recall quality | 15 | 5 | 9.5 | Word matching only in use; misses paraphrase and Urdu / Roman Urdu |
| Learning | 10 | 4.5 | 9.5 | Regex extractor by default; the model extractor was never evaluated live |
| Operations | 10 | 4 | 9.5 | The Worker path has no background runner: no learning, purges stay pending |
| Simplicity | 5 | 4 | 9 | About 24k lines over 18 stages; stages 16 to 18 are not wired in |
| **Weighted** | | **7.2** | **9.5** | |

The held-out pilot is the reason recall and learning carry the plan: the full system scored 79% against 76% for a plain profile with session summaries, a difference inside the noise.

## The rule

Keep every safety guarantee (consent, deletion, provenance, the writer fence). Change what the user feels: whether the right memory reaches the answer.

## Fixes

1. **Recall by meaning.** Configure a multilingual embedding provider for `indexAuthorizedEmbeddings` and add an in-process hybrid search over the warm snapshot (cosine plus BM25, reciprocal-rank fusion, similarity floor), the design already built and measured in the portfolio agent (`E:\projects\port\portfolio\app\agent\memory\search.ts`). Index on write, not at query time. Gate: +15 points recall on a Urdu / Roman Urdu / paraphrase set.
2. **A compact context pack.** Render memories as plain dated lines grouped by topic; keep assertion and event IDs server-side for audit. Count real tokens instead of UTF-8 bytes in `composeContextPack`. Gate: at least 2× memories in view at the same budget, no new leakage in seed scenarios C01 to C36.
3. **Model learning.** Turn on the model extractor (`openai/gpt-6-luna`) behind the existing exact-quote validator, and add a reconcile step (add, update, duplicate, conflict) over the most similar accepted memories. Sensitive categories default to private. Gate: held-out false-memory rate no worse than the rules-only extractor.
4. **Consolidation.** Build the best version of the baseline that nearly tied: a short cited stable profile, one topic page per person, project or place, and episode recaps, all rebuilt from accepted assertions when their inputs change.
5. **Operations on the Worker.** Add a Cron Trigger plus Cloudflare Queues consumer that runs `runMemoryMaintenance` per account with fair budgets: learning, projection rebuilds and `runPurgeBatch`. Gate: physical purge p95 under 10 minutes; no "cleanup pending" older than a day.
6. **Self-improving skills.** Record turn traces (question, what memory was shown, reply, rule checks) and run an offline SkillRefiner loop: judge, cluster successes and failures separately, one proposal per cluster, evidence-gate failure fixes, merge into a learned overlay that is a candidate until promoted. Facts never come from this loop.
7. **Know what you don't know.** Count questions memory could not answer; ask "did I get that right?" only when a memory is uncertain and the answer depends on it.
8. **Prove it.** 300+ held-out questions, LongMemEval, LoCoMo-Plus and PersonaMem subsets, the multilingual set, production p95 latency. Pre-registered, paired trajectory bootstrap, one ablation per mechanism. Gate: beat the profile baseline by at least 5 points with the lower bound above zero.
9. **Simplify.** One runtime path after cutover, retire legacy flags, park the portable package, procedures and media memory until a second app needs them.

## Phases

| Phase | Work | Exit gate |
|---|---|---|
| 1 | Recall by meaning | Multilingual set +15 points |
| 2 | Compact pack and consolidation | ≥ 2× memories in view, C01 to C36 still pass |
| 3 | Model learning with reconcile | False memories ≤ today |
| 4 | Worker background | Purge p95 < 10 min |
| 5 | Self-improving skills | Held-out answers never worse after an overlay |
| 6 | Proof | Baseline beaten by ≥ 5 points |

## On a "perfect" score

A 9.5 is claimable once phase 6 says so. A 9.9 needs wins on public benchmarks against the strongest memory systems. Quote the measured numbers, not the score, in a portfolio.
