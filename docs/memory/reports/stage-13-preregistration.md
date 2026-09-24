# Stage 13 preregistration: held-out conversational evaluation

Written 2026-09-24, before any system was run on the held-out split. It is
committed together with the held-out manifest
(`scripts/fixtures/memory-conversation-heldout.json`), the development split
(`scripts/fixtures/memory-conversation-dev.json`) and the scoring library
(`scripts/lib/memory-eval.ts`). Anything changed after the first held-out run
is reported as a deviation in the handoff, with the reason.

## What is compared

Each arm replays the same trajectories in time order. A query sees only the
sessions that happened before it (`timeline()` in the scoring library; checked
by unit test). Every arm answers with the same reader under the same reader
system prompt.

| Arm | Memory written by | Memory shown to the reader |
| --- | --- | --- |
| `none` | nothing | nothing |
| `legacy` | the legacy `remember`/`forget` tools (`runServerTool` with no memory runtime); a correction is `remember` with `replaces`, as the legacy tool contract asks | `contextMemories(store, query, 4, true)` under the legacy prompt header from `agent-core` |
| `profile_summary` | a profile of explicitly remembered facts (corrections replace, forgets remove) plus one extractive digest per session of what the user said | `createProfileSessionSummaryBaseline` selection (top 4) under a neutral header |
| `full` | the production Node memory runtime on real PostgreSQL: every user turn captured, explicit turns through `runtime.execute`, background learning through `runMemoryMaintenance` with the production default (rule) extractor | `retrieveMemory` with the app's `createRecallInput` (standard budget) under the context-pack header from `agent-core` |
| `oracle` | none | the gold evidence lines, under the neutral header. **Diagnostic only; excluded from every comparison and ranking.** |

Turn kinds map to what the product does after the model has chosen the right
tool: `remember`, `correct` and `forget` turns assume the tool call was made
with the stated text for both `legacy` and `full`. `say` turns are ordinary
turns: the legacy store only learns from them if the model calls `remember`,
which this controlled harness does not simulate (so `legacy` never learns from
`say` turns; this is stated as a limitation, not hidden).

Retrieval ablations (`full` minus source-evidence fallback, minus
applicability, minus relationships) are measured at the context layer only,
offline, with no model calls.

## Metrics

Answer layer (live reader `openai/gpt-6-luna`, temperature 0; judge the same
model, blinded to arm; both prompts versioned in the scoring library):

- **Primary: deterministic answer pass rate.** A query passes when every
  required rubric group appears, no forbidden term appears, and, where the
  rubric expects abstention, the answer abstains (`deterministicPass`).
- Secondary: judge pass rate (`judgePass`), false personal claim rate,
  unnecessary personalization rate (judge), and per-category pass rates for
  constraint adherence, temporal, correction, deletion, attribution,
  hypothetical, resumption, abstention, multilingual, cutoff and negative
  personalization.
- Judge/deterministic agreement is reported; neither is treated as truth.
- Repeat variability: the reader is run a second time for every arm with a
  different `seed` and the pass-rate difference between the two runs is
  reported.

Context layer (offline, deterministic): evidence coverage (every required group
present in the memory block), forbidden-content leakage into the block, and
personal content injected for queries that need none (negative
personalization and abstention queries). Also context size and selection
latency.

## Decision rule

- Sampling unit: the trajectory. Intervals are paired, trajectory-cluster
  bootstrap 95% intervals (`pairedBootstrap`, 10,000 resamples, seed 13) of
  the difference in pass rate between two arms over the same queries.
- **Improvement:** `full` beats `legacy` on the primary metric when the point
  estimate is at least +5 percentage points and the interval's lower bound is
  above 0.
- **Non-inferiority:** `full`'s false personal claim rate and unnecessary
  personalization rate may not exceed `legacy`'s by more than 5 percentage
  points at the interval's upper bound.
- `full` versus `none` and versus `profile_summary` are reported with the same
  statistics but carry no release decision.
- Denominators: every query counts. A provider error, a refusal to parse or a
  spend-cap stop is a failure for that arm and is reported by count, never
  dropped.

## Size and status

24 held-out trajectories, 34 queries, 4 language groups (English, Roman Urdu,
code-switched, Urdu script). This is a pilot: it is sized to find large
effects and regressions, not to establish small differences, and its results
are diagnostic. No result here is a competitive claim against another
product.

## Spend

Only `openai/gpt-6-luna` is called (the harness refuses any other model).
Responses are cached on disk and replayed; a hard stop at $0.20 of
provider-reported cost per run applies.

## Out of scope for this run (reported as blocked, not simulated)

- Jev: no TypeSafe API key is available.
- Hybrid (vector) retrieval: not implemented in the runtime.
- External providers and public benchmarks (LongMemEval, PersonaMem,
  LoCoMo-Plus): need a download or account the user has not authorized.
- Human-reviewed answer sample: needs a reviewer.
