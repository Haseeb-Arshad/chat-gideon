# Plan B implementation ledger

Implementation started 12 October 2026 against the current shared checkout. The existing voice, illustration, UI, audit and dependency edits are preserved. The 9.5 rating is a proposed outcome, not a measured result.

Subsequent validation without provider credits: `reports/plan-b-no-credit-validation.md`.
It passed 210 unit/UI checks, 99 disposable-database checks and the 320-query
offline construction replay, and fixed a wrongly targeted corroboration hint.

| Requirement | Entry state | Implementation evidence |
|---|---|---|
| Multilingual semantic recall | Index/search algorithms existed; active runtime passed no provider | Implemented in `backend/memory/src/providers.ts`, wired in both host adapters; private scoped background indexing, BM25/vector reciprocal-rank fusion and current-version hydration. Development provider check: 12/12 versus 2/12 lexical. |
| Compact pack and actual token counts | IDs and UTF-8 byte counter in model context | Compact rendering plus `o200k_base` tokenizer; exact provenance stays server-side. Capacity test demonstrates at least twice as many memories at the same budget. |
| Model extraction and reconciliation | Optional Node extractor; deterministic reconciler existed | Worker and Node model selection; literal quotes, server-owned handles, similar known claims, duplicate/corroboration/conflict decisions. Changes to user-authored memory stay under review. Direct extractor calls screen secret windows before remote inference. |
| Profile/topic/episode consolidation | Warm profiles and episode heads existed; facts excluded from stable profile | Accepted facts included in profile; bounded cited topic pages plus existing episode heads; renewal only when authority, watermark and exact inputs still match. |
| Worker scheduled maintenance | No scheduled or queue handler | Cron dispatcher, fair scoped leases, Queue consumer/retry/DLQ configuration, per-owner budget, global purge/retention, projection/learning/indexing work. Node indexing retries after source jobs finish. Local PostgreSQL/queue fixture verified; not deployed. |
| Offline skill refinement | Advisory procedures existed outside application; no learned overlays  | Traces → judge → separate success/failure clusters → supported proposals → candidate overlays → independently executed verification → separate subordinate answer guidance. No automatic promotion. CLI and lifecycle integration test included. |
| Gap tracking | No memory answer-gap inbox | Owner-scoped unanswered-question counts; inspector answers go through explicit remember; learned-rule retirement; narrow confirmation wording for relevant uncertainty. |
| Larger evaluation and public imports | 33-question pilot; no phase-6 proof | Frozen 320-question internal fixture, paired comparison and six context ablations, 300 public-source imports, blinded public runner with canonical-memory adapter. Public model scores and fresh post-calibration holdout remain unmeasured. |
| Canonical simplification | Authority cutover existed; legacy fallback remained | Canonical-only active runtime; inactive non-empty legacy scopes receive paused receipts pending controlled migration. Compatibility code retained for cutover/rollback; portable/procedure/media modules remain parked. |

## Verification and interpretation

Local PostgreSQL suite: **82 checks passed**, including the existing 36 seed
scenarios and six Plan B integration checks. The new checks cover trace/gap
deletion, physical purge completion, temporary conversations, candidate-to-active
overlay verification, lease invalidation, Cron/Queue dispatch, secret exclusion
and provider retry without starving subsequent backfill.

An additional seven-check PostgreSQL run passed after the final migration
hardening: it reran the six lifecycle checks and verified that all five new
tables deny direct `anon`, `authenticated` and `service_role` grants even when
created under Supabase-style permissive default grants. Row-level security is
enabled on each table.

Focused unit suite: **84 checks passed**, followed by **21 host/runtime/inspector
checks**, including the learning-inbox interaction. The additional direct-model
secret-screening regression runs with the model-extractor checks. The proof-gate
regression refuses to award 9.5 from unscored imports or missing measurements.
TypeScript and
the Cloudflare production build/bundle/credential-boundary checks passed; the
verification logs are under `output/memory-plan-b-eval/`.

The final model/Plan B unit subset passed 13 checks; the public runner was
explicitly skipped because its paid invocation was not enabled. Its TypeScript
adapter compiles, but this does not establish public model-score execution.

The first complete 320-question diagnostic used a semantic floor of 0.25.
Its reader completed both arms for all 320 queries. Judge scores were 68.3% full
and 54.9% profile baseline; paired gain **13.2 points**, 95% trajectory bootstrap
CI **9.7–16.7 points**, with 318 complete judge pairs. Deterministic scores were
74.7% and 62.5%. There were no explicit-ingestion failures. This internal
synthetic fixture repeats scenario families; these are not public benchmark or
production results. See `reports/plan-b-320-diagnostic.json`.

That evaluation exposed weak cross-language matching for unfamiliar names.
A separate development probe measured 0.204 for a valid Urdu residence pair
and 0.241 for Roman Urdu; duplicating the Urdu question reduced it to 0.183.
The runtime floor is now 0.15. The development recall check retrieved all 12
cases, including an unfamiliar synthetic place name, versus two lexical hits.
The completed 320-query report describes the **earlier** floor; it must not be
used to claim held-out quality for this revision. A fresh holdout is required.

A separate 32-case development extraction diagnostic had eight positive and
24 negative examples. Model extraction accepted all eight positives and no
false personal assertions; rules accepted four positives and one false
assertion. Candidate proposals are reported separately because they are not
active personal memories. An initial test incorrectly counted candidates as
accepted memories; the corrected report preserves both states. This is a
development check, not the registered held-out false-memory gate.

The quality reader/model was `openai/gpt-6-luna`. Paid replay reused exact-prompt
cache entries; the completed resumed run spent $0.0237 on 356 new calls and
reused 2,204 calls. The initial interrupted run's cache contained approximately
$0.1194 of receipts. These are chat-call receipts, not a total including every
embedding/probe/extraction request. Production latency and purge p95 remain
**unproven**.

## Running the tools

Operator help: `npm run memory:plan-b -- help`. Commands include `status`,
`maintain`, `index`, `refine`, `gaps`, `overlays`, `verify` and `retire` for an
existing authenticated owner. They do not provision owners or grants. Paid
commands require `MEMORY_PLANB_LIVE=1`; refinement/verification accept a bounded
`--cap`. Queue setup and staged migration/deployment commands are in
`backend/worker/README.md`.

Public imports: `node scripts/import-memory-benchmarks.mjs DIRECTORY`, using
downloaded official source files and preserving their hashes. The executable
public runner is `scripts/memory-public-eval.live.test.ts`, run through the
disposable PostgreSQL harness. It requires `MEMORY_PUBLIC_EVAL_LIVE=1`, a provider
key, `MEMORY_PUBLIC_SPEND_CAP_USD` (at most $1), and an explicit case limit. Gold
answers are visible only to the blinded judge. Assistant dialogue is retained
in source imports/baseline summaries but never promoted as a personal statement
by the canonical adapter. Incomplete learning/indexing aborts scoring.

Imports comprise LongMemEval oracle diagnostic, LoCoMo-Plus cue-only diagnostic
and PersonaMem original multiple-choice source subsets. These are explicitly
named protocol variants; they cannot establish official full-history or stitched
leaderboard performance. Public-source imports and runner availability alone
are not benchmark scores.

## Deployment and the 9.5 gate

This implementation is **local**. No production migration, queue creation or
deployment was performed. The session had no direct production database URL;
the checkout also contains unrelated work that must be reviewed before any
whole-tree release. Migration 012 is additive and must precede activation.

The gate evaluator in `scripts/lib/memory-proof.ts` fails closed without a fresh
complete holdout, a positive baseline gain, multilingual improvement, the
held-out learning comparison, capacity and safety checks, executed overlay
verification, scored public subsets, and production purge/latency evidence.
The proposed 9.5 is **not yet a defensible rating**. Implementation of the
mechanisms, local conformance and production proof are distinct milestones.

The portfolio repository and its Plain/Goblin modes were not edited by this
Gideon implementation. Both Node/HTTP and Worker/WebSocket memory adapters
retain the existing agent's transport, tool and turn contracts. This is not a
new verification of the separate portfolio's deployed modes.

Existing videos were located and checked as non-empty files:
`E:/projects/gideon-memory-video/final/A-how-gideon-memory-works-today.mp4` and
`E:/projects/gideon-memory-video/final/B-gideon-memory-v2-plan-to-9.5.mp4`.
They describe the earlier architecture and proposal; they were not re-rendered
as measured implementation proof.
