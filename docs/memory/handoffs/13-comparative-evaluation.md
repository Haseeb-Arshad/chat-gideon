# Stage 13 handoff: held-out conversational evaluation and comparison

Status: LOCAL_VERIFIED (held-out pilot run; external comparisons BLOCKED)
Implementation commits:
- `6ce9237`: all 36 seed scenarios as a conformance suite
- `b55de06`: four defects that suite found (stemming, superseded evidence, recall budget validity, capture race)
- `874f557`: concurrent job-claim fix
- `4af0b5d`: the product's memory framing exported for the harness
- `6381fe5`: preregistration, held-out and dev manifests, scoring library
- `779cf29`, `e6542e9`, `e9cafe2`: three product defects the dev split found (below)
- `0d87da8`: evaluation harness and dev results
- the commit that adds this handoff and the held-out reports

Date: 2026-09-24
Environment: Windows 10, Node 22.13, disposable local PostgreSQL 17 through
`scripts/memory-postgres-harness.mjs`; reader and judge `openai/gpt-6-luna`
through OpenRouter (the only model called). No deployment, no remote database,
no real-user data.

## Prerequisite evidence

Stage 11 (`handoffs/11-jev-experiment.md`): Jev DEFERRED, classifier off by
default; no TypeSafe key, so no Jev arm here. Stage 12
(`handoffs/12-memory-controls.md`): controls, forget and settings verified on
PostgreSQL; reused unchanged except for the deletion fix below.

## Implemented behavior

1. **Seed conformance.** `backend/memory/src/seed-conformance.live.test.ts` runs
   every seed scenario C01–C36 at the deepest layer that runs locally (38
   tests; table below). It found four real defects, fixed in `b55de06`.
2. **Held-out conversational evaluation.** `scripts/memory-conversation-eval.live.test.ts`
   replays each trajectory in time order into:
   - `full`: the production Node runtime (`createRuntime`) on PostgreSQL. Every
     user turn is captured, explicit turns go through `runtime.execute`, and
     learning runs through `runMemoryMaintenance` with the production default
     rule extractor. Recall uses the app's own `createRecallInput`.
   - `legacy`: the legacy `remember`/`forget` tools and `contextMemories`.
   - `profile_summary`: a profile of explicit facts plus extractive session
     digests.
   - `none`, and `oracle` (gold evidence, diagnostic only).

   Each arm's block is framed exactly as `agent-core` frames it. The same
   controlled reader answers every arm. A blinded judge (asked twice) and
   deterministic rubric checks score the answers. Retrieval ablations run at
   the context layer. Simulated dates come from faking `Date`, so validity
   times, expiry and cutoffs behave as they would on those days.
3. **Scoring library** `scripts/lib/memory-eval.ts`: rubric checks,
   abstention, a time-ordered timeline (leak guard), paired
   trajectory-cluster bootstrap, reader and judge prompts. It has
   hand-calculated unit tests in `scripts/memory-eval-lib.test.ts`: arithmetic,
   split disjointness, cutoff ordering, rubric kept out of the reader prompt,
   arm kept out of the judge prompt, typographic apostrophes.

### Product defects found and fixed by the dev split (before any held-out run)

| Defect | Effect before | Fix | Regression test |
|---|---|---|---|
| Automatic recall used the `standard` tier. The pack is counted in UTF-8 bytes, and the header alone is several hundred bytes | Every automatic recall reached the model as "Memory context budget exhausted", so the model **saw no memory at all** | `createRecallInput` uses `maximum` (about 2,900 bytes for items); deep recall drops the reserves | `node-memory-integration.test.ts` "leaves room for real memory…" (fails on old budget) |
| The dropped-conversation note was appended after selection | A full pack overflowed and collapsed to the fallback | The note is counted during selection | `retrieval.test.ts` "counts the dropped-conversation note…" (fails on old code) |
| A captured turn carrying a remember/correct/forget command was not linked to the command | A forgotten value came back as source evidence from the "remember" and "forget" turns, and those turns were never purged. A replaced value came back from its original turn. Learning stored a second copy of every explicit memory | Retrieval treats a captured turn that shares its source with a command event as represented by that command. Forget suppresses and purges those captured turns (and anything learned from them) plus the forget request's own turn. Learning skips turns an explicit command handled | `postgres.live.test.ts` "Explicit turns are represented by their command" (fails without the fix) |

## Results (held-out pilot: 24 trajectories, 33 queries)

Reports: `docs/memory/reports/stage-13-heldout.json` (run 2, reproducible) and
`stage-13-heldout-run1.json` (the first held-out run), each with a
`-details.json` holding every context, answer and verdict.

Deterministic pass rate (primary), judge pass rate, and judge-rated rates:

| Arm | Deterministic | Judge | False personal claim | Unnecessary personalization |
|---|---|---|---|---|
| none | 0.333 | 0.303 | 0.121 | 0.000 |
| legacy | 0.636 | 0.606 | 0.152 | 0.000 |
| profile_summary | 0.758 | 0.727 | 0.121 | 0.061 |
| **full** | **0.788** (run 1: 0.818) | **0.818** (run 1: 0.758) | **0.030** (run 1: 0.091) | **0.030** (run 1: 0.061) |
| oracle (diagnostic) | 0.939 | 0.970 | 0.000 | 0.030 |

Paired trajectory-cluster bootstrap, 95% intervals (run 2; run 1 in brackets):

| Comparison | Difference | Interval |
|---|---|---|
| Deterministic pass, full − legacy (**primary**) | +15.2 pp [+18.2] | [0.0, +30.3] [run 1: +6.3, +32.1] |
| Judge pass, full − legacy | +21.2 pp | [+9.1, +34.4] |
| False personal claim, full − legacy | −12.1 pp | [−22.9, −2.9] |
| Unnecessary personalization, full − legacy | +3.0 pp | [0.0, +10.0] |
| Deterministic pass, full − none | +45.5 pp | [+28.6, +61.3] |
| Deterministic pass, full − profile_summary | +3.0 pp | [−6.5, +12.9] |

Against the preregistered rule:
- **Improvement over legacy:** met in run 1 (lower bound +6.3). Borderline in
  run 2: the lower bound is exactly 0, so strictly "above 0" is not met. The
  runs differ only in opaque identifier strings inside the pack, which shows
  how sensitive a 33-query pilot is. Treat it as likely, not established.
- **Non-inferiority, false personal claims:** met (upper bound −2.9 pp; full
  makes fewer false claims).
- **Non-inferiority, unnecessary personalization:** not established (upper
  bound +10 pp against a 5 pp margin). Every negative-personalization query
  still passed. The judge flagged one answer that volunteered a remembered
  detail.
- `full` does **not** measurably beat the simple profile-plus-digests baseline.

Variability (run 2): reader seed 2 changed 2 of 33 verdicts for `full`, with
the same pass rate (0.788). It changed 0 for `legacy`, 1 for `none`, 1 for
`profile_summary` and 2 for `oracle`. Judge repeat agreement was 0.97–1.00;
judge/deterministic agreement was 0.97 for every arm.

By category (`full`, deterministic):
- Perfect on: abstention, attribution, correction, cutoff, deletion, extraction
  miss, hypothetical, negative personalization, scoped preference.
- Weaker on: temporal 2/3, recall 2/3, preference application 2/3, constraint
  adherence 3/4, resumption 1/2, multilingual 1/3.
- By language: English 0.83, Roman Urdu 1/2, Urdu script 0/1.

Context layer and ablations (offline):

| Arm | Evidence coverage | Forbidden leak | Items shown when none needed | Mean items | Selection p50 / p95 / p99 |
|---|---|---|---|---|---|
| legacy | 0.46 | 0.00 | 0.00 | 0.45 | 0.1 / 1.3 / 4 ms |
| profile_summary | 0.69 | 0.03 | 0.00 | 0.67 | 0.1 / 1.0 / 1.5 ms |
| full | 0.77 | 0.12 | 0.50 | 0.88 | 34 / 61 / 408 ms |
| full − source evidence | 0.65 | 0.09 | 0.50 | 0.64 | |
| full − applicability | 0.77 | 0.12 | 0.50 | 0.88 | |
| full − relationships | 0.77 | 0.12 | 0.50 | 0.88 | |

- The source-evidence fallback earns its place (+11.5 pp coverage).
- Removing applicability or relationships changed nothing measurable on this
  set. They are kept because they guard conditional and scoped cases that the
  seed suite exercises (C06, C07, C28, C36) and that this pilot covers with
  only a few queries. They are not proven by this evaluation.
- "Items shown when none needed" is 0.5 because unconditional constraints (an
  allergy, a wheelchair) are always included. The answers to those queries
  still passed.
- The p99 is the first, cold query of the run.

Remaining failures of `full` are retrieval limits, not the bugs above:
- lexical-only matching ("children" vs "daughter/son", "lunch" vs
  "vegetarian meals", Urdu script and Roman Urdu vs English);
- history questions ("where was I working in early August?") need a `valid_at`
  query, which the app never issues;
- one resumption query needed the unresolved catering cost from a turn the
  rule extractor did not keep.

Cost: $0.0377 of provider-reported spend for all Stage 13 runs (dev 3 runs,
held-out 2 runs), all `openai/gpt-6-luna`. OpenRouter account usage went from
$38.4650 to $38.5028 over the stage ($0.0378), matching the harness tally.

## Seed conformance map (C01–C36)

All in `backend/memory/src/seed-conformance.live.test.ts`; title prefix is the case id and layer.

| Case | Layer | Test |
|---|---|---|
| C01 | conversation-state | "the second one" resolves against the revision that was shown |
| C02 | conversation-state | two equally plausible projects produce a question |
| C03 | postgres + conversation-state | a spoken self-repair stores Jev, never Java; the final transcript replaces the ASR hypothesis |
| C04 | postgres | a real change returns B now and A as of September 5 |
| C05 | postgres | a spelling correction returns Aly and never presents Ali as a former name |
| C06 | postgres | a presentation-local formal tone stays local |
| C07 | postgres | a dated evening exception has expired; the morning preference stands |
| C08 | postgres | the rejection reason is kept verbatim |
| C09 | postgres | the quietness preference applies without being repeated |
| C10 | postgres | a factual question pulls in no personal preferences |
| C11 | postgres | a colleague's preference is not attributed to the user |
| C12 | postgres | "imagine I move to Tokyo" stores no residence |
| C13 | postgres | repeated per-task turns stay one scoped proposal |
| C14 | conversation-state | resuming recalls both alternatives and the open cost question |
| C15 | conversation-state | a spoken promise with no receipt is not a scheduled email |
| C16 | conversation-state | after an interruption only the heard part counts |
| C17 | transport | playback of an unissued segment is rejected |
| C18 | runtime | a speculative turn may read memory but cannot change it |
| C19 | postgres | the accepted correction wins over a still-valid warm snapshot |
| C20 | postgres | two devices editing one revision: one wins, one conflicts |
| C21 | postgres | a redelivered event is one event, one job and one memory |
| C22 | postgres | forgetting blocks reuse at once and reports purge separately |
| C23 | postgres | a restore replays suppression before any read reopens |
| C24 | postgres | user B asking about A's data gets nothing |
| C25 | postgres | an expired lease is not served; an unreachable authority is unavailable, not empty |
| C26 | legacy + postgres | the old array tells the truth when full; explicit memory is admitted by quota |
| C27 | postgres | a missed detail is found through source evidence |
| C28 | postgres | a Roman Urdu project-local exception stays local |
| C29 | postgres | an injected "authorized all payments" document grants nothing |
| C30 | postgres | with the classifier down, remember is deterministic and learning abstains |
| C31 | postgres | copies of one weak inference count as one source |
| C32 | postgres | re-extraction never reverts a user correction |
| C33 | postgres | at quota, remember says so |
| C34 | conversation-state | "back to the trip" resumes the trip with its constraints |
| C35 | postgres | a remembered price is labelled historical |
| C36 | postgres | an explicit premium budget for this task leaves the default intact |

These are storage, projection, transport and runtime checks. Answer-level
behavior is measured by the held-out evaluation's categories rather than by
re-running each seed case through a model.

## Decisions and deviations

- **Run 1 vs run 2.** The first held-out run embedded a timestamp in its run
  id, so the ids in each pack changed per run and the cache could not replay
  it. The id is now deterministic (the schema is fresh per run). Run 2 is
  reproducible bit for bit from the cache (verified: a no-network replay gives
  identical numbers). Both runs are reported. Run 1 is the preregistered one.
- **Metric fix after run 1.** "Personal content when none needed" first
  counted the pack's fixed header as content, so `full` always scored 1.0. It
  now counts remembered items. Run 1's report keeps the old computation.
- **Query count.** The preregistration draft said 34 queries; the manifest
  has 33. Corrected in the document.
- **Rubric defect, left as frozen.** ho-11's forbidden term "AB" matches
  substrings such as "about". This inflates context-level leakage for that
  query. Answers were unaffected.
- Legacy never learns from ordinary turns here, because the harness does not
  simulate the model choosing `remember`. This favors `full` on
  extraction-miss and resumption queries, and it is why `profile_summary`
  (which keeps said turns) is the fairer comparison. `full` does not
  significantly beat it.
- Explicit turns assume the model called the right tool with the stated text,
  for both `legacy` and `full`.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npx vitest run` | local | 103 files, 1061 passed, 90 skipped (live-gated) | terminal |
| `npm run memory:postgres:test` | disposable PostgreSQL 17 | 76/76 (38 authority + 38 seed conformance) | terminal |
| `node scripts/memory-postgres-harness.mjs scripts/memory-conversation-eval.live.test.ts` | disposable PostgreSQL, dev, live | 1/1; $0.0007 last run | `reports/stage-13-dev.json` |
| same, `MEMORY_CONVERSATION_EVAL_SPLIT=heldout MEMORY_CONVERSATION_EVAL_LIVE=1` | disposable PostgreSQL, held-out, live | 1/1; run 1 $0.0252, run 2 $0.0053 | `reports/stage-13-heldout*.json` |
| same, held-out, no network | cache replay | identical to run 2 | terminal comparison |
| `npx vitest run scripts/memory-eval-lib.test.ts` | local | 6/6 | terminal |
| `npx tsc --noEmit` | local | 0 errors | terminal |

## Operational behavior

The harness is a test file behind the PostgreSQL gate. It never runs in
`npx vitest run` without the harness's database variables. It refuses any
model but `openai/gpt-6-luna`, caches responses in
`output/memory-conversation-eval/` (gitignored), and stops at $0.20 per run.

The product changes:
- Automatic recall now uses the `maximum` tier. Packs are larger (about 350
  estimated tokens on average here) but carry memory.
- Forget also purges the captured turns behind a forgotten memory, the
  learned items derived from them, and the forget request's own turn. Other
  explicit memories from the same turn are separate command events and are not
  touched.
- Learning skips a turn an explicit command handled. If the same turn also
  said something else memorable, only the command is kept; the model can call
  `remember` twice.

Revert: `git revert e9cafe2 e6542e9 779cf29` restores the previous behavior,
including the defects.

## Remaining gaps

- **External comparisons BLOCKED.** LongMemEval, PersonaMem and LoCoMo-Plus
  need dataset downloads the user has not authorized; no provider account for
  a competitor. No competitor rows exist, and none are simulated.
- **Jev BLOCKED:** no TypeSafe key.
- **Hybrid retrieval:** not implemented. The multilingual and synonym
  failures above are the evidence that it matters.
- **Human review:** a reviewed answer sample needs a person. The details files
  hold every answer for that.
- The pilot is small. Improvement over legacy is likely but not established
  at the preregistered bar in both runs, and there is no evidence of benefit
  over a profile-plus-digests baseline.

## Release recommendation

Keep the new memory behind its flags; do not claim superiority. Conditions
before any wider rollout:
1. Stage 14's load, fault and security work.
2. Semantic or multilingual retrieval so preferences and cross-language facts
   are found.
3. A larger held-out set (at least a few hundred queries), so the improvement
   and personalization bounds can be decided.

The three defects fixed here meant the memory runtime showed the model nothing
before this stage. Any earlier impression of its quality predates a working
recall path.

## Next stage contract

- `createRecallInput` budgets: `maximum` tier, reserves 128/64 (deep: 0/0).
- `executeForgetCommand(session, command, { requestSourceIds })` also removes
  the captured turns of those source documents.
- Learning decision reason `handled_by_explicit_command`.
- The evaluation harness can re-run any split after a change. Held-out results
  replay from cache only while pack text is unchanged; any retrieval change
  needs a new live run and must be reported as such.

Next prompt: `docs/memory/implementation/14-operational-hardening.md`.
