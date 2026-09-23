# Stage 11 handoff: Jev classification adapter and adoption decision

Status: LOCAL_VERIFIED. The decision is a measured deferral: Jev live is BLOCKED because there is no TypeSafe key, and every classifier mode stays off by default.
Implementation commits: `14b137f` (adapter and workflow), `c736c78` (labeled splits and harness, committed before any live run), `1bd5d69` (reader repair, frozen thresholds and dev report), and the commit that adds this handoff.
Date: 2026-09-24
Environment:
- Machine: Windows 10.0.19045 x64, Node v22.13.0, Vitest 4.1.5, disposable local PostgreSQL 17.
- Live calls: OpenRouter only, and only `openai/gpt-6-luna`. The user explicitly authorized that model for this stage's testing, with a spend ceiling of about $0.30.
- Spend: account usage moved from $38.308890 to $38.345344, a total of **$0.0365** including two probe calls.
- No TypeSafe, Exa or other provider was called.

## Prerequisite evidence

- **Stage 10:** `handoffs/10-background-learning.md` is LOCAL_VERIFIED. The contract Stage 11 builds on held:
  - `MemoryExtractor` is replaceable;
  - `validateExtractorOutput` requires exact spans;
  - `decideCandidate` is the only writer-side decision.
- **Rechecked before starting:**
  - the offline suite passes;
  - the disposable PostgreSQL suite passed 27/27 before any Stage 11 test was added.
- **Official TypeSafe documentation (`docs.typesafe.ai`), read 2026-09-23:**
  - API reference, models, primitives and confidence pages.
  - Endpoint: `POST https://api.typesafe.ai/v1/systemone` with a bearer key.
  - Request body: `{ state, model, questions }`.
  - Answers come back keyed by question id.
  - Errors: 401, 422, 429, 529.
  - Model: `jev-1.13.0`, behind the `jev-latest` alias.
  - Price: $0.042 per million input tokens.
- **Model availability:** Jev is not on OpenRouter; the OpenRouter model list was checked.

## Implemented behavior

- **Bounded classification contract** (`src/lib/memory/classification.ts`, edge-safe).
  - It defines Choice, Noul and Score questions and answers in TypeSafe's shape.
  - Requests are validated:
    - at most 32 questions;
    - state at most 24,000 characters;
    - option keys must match a strict pattern;
    - 2 to 255 choice options, 2 to 10 score levels.
  - Answers are strictly parsed. A response is malformed as a whole if an answer is missing, has the wrong type, uses an option that was not offered, has probabilities that do not sum to 1 (±0.02), or reports a choice that is not the argmax.
  - Every provider returns a typed failure rather than throwing: `timeout`, `cancelled`, `unavailable`, `rate_limited`, `overloaded`, `unauthorized`, `invalid_request`, `malformed` or `not_configured`.
- **Allowed question families.** Only four:
  - candidacy: speech act and whether the clause is a sincere current claim;
  - temporary versus durable;
  - relation to already retrieved memories;
  - activity (applicability).

  No question concerns tenants, grants, identity or deletion targets. The classifier sees text only. It never sees assertion, scope, event or principal ids, which the tests check.
- **Staged, conservative workflow** (`src/lib/memory/classified-extractor.ts`). It composes an extractor and a classifier into an ordinary `MemoryExtractor`.
  - **`verify` mode:**
    - The extractor proposes candidates.
    - One request asks independent questions about each open proposal. Proposals the reconciler would refuse anyway are never sent.
    - A dependent second request runs only for proposals that would be kept. It asks how each relates to at most three code-retrieved known memories of the same scope, sent as opaque handles.
    - The verdict can only refuse (`review: 'reject'`), hold for review (`review: 'abstain'`, which becomes a candidate), or narrow a durable clause to a per-task local candidate. It never widens scope and never rescues a refused speech act.
    - A changed or exception relation holds the proposal for review.
  - **`gate` mode:** one question about the whole turn decides whether the extractor runs.
  - **Failure handling:** any classifier failure makes every open proposal an abstention. Gate failure still extracts, with proposals held. Classifier confidence is never fabricated.
- **Reconciler hooks** (`src/lib/memory/learning.ts`).
  - The validator accepts an optional `review` field, restricted to `reject` or `abstain`.
  - `decideCandidate` rejects on `reject`. It makes `abstain` a candidate that also cannot corroborate, because corroboration feeds promotion.
  - The window has optional `knownMemories` for the relation stage.
- **Reader repair found by the dev run.** `decideCandidate(..., { sourceText })` now checks the whole sentence around the evidence for special-category topics. Before this, a remote extractor could quote "I love sweets" out of "I am a diabetic and I love sweets" and pass. This applies to every extractor. Stage 10's eval is unchanged: precision 1, recall 0.885.
- **Providers** (server-only).
  - `backend/memory/src/typesafe-classifier.ts`:
    - pins `jev-1.13.0`;
    - enforces timeout and cancellation through the caller's signal;
    - retries 429/529 once, honoring `retry-after`;
    - maps errors to typed failures;
    - logs the answering model version;
    - computes cost from input tokens.
    
    The key never appears in results or errors.
  - `backend/memory/src/llm-classifier.ts` is the OpenRouter substitute (`openai/gpt-6-luna`, minimal reasoning). Its probabilities are self-reported, and confidence is recomputed locally. It is labeled `llm_substitute` everywhere.
- **Shadow mode.** `processLearningJob(..., { shadow })` runs a second extractor after the writing one. It has its own deadline and runs outside every transaction.
  - Both outcomes are judged by the same reconciler against the same snapshot.
  - Only reason codes are recorded: `learning_decisions.action = 'shadow'` with reasons `shadow_agree`, `shadow_refuse`, `shadow_hold`, `shadow_accept`, `shadow_support`, `shadow_missing`, `shadow_extra_*` or `shadow_failed`.
  - A failing shadow never affects the job.
  - `includeKnownMemories` adds at most 24 accepted memories of the bound scope to the window, text only with opaque handles.
- **Wiring.** `learningExtractorsFromEnv()` in `src/server/node-memory-integration.ts` feeds the background runner. Nothing runs on a voice or HTTP turn, and explicit commands never touch a classifier.
- **The Stage 10 model extractor** now defaults to `openai/gpt-6-luna` with minimal reasoning. This follows the user's model instruction and is still gated by its own spend switch.

## Source and schema map

| Concern | Paths |
|---|---|
| Edge contract, questions, verdicts | `src/lib/memory/classification.ts` |
| Workflow | `src/lib/memory/classified-extractor.ts` |
| Reconciler hooks and sentence check | `src/lib/memory/learning.ts` |
| Flags | `src/lib/memory/rollout.ts` (`memoryClassifierPlan`) |
| Providers | `backend/memory/src/typesafe-classifier.ts`, `backend/memory/src/llm-classifier.ts`, `backend/memory/src/model-extractor.ts` |
| Worker and runner | `backend/memory/src/learning.ts` (`compareShadow`, shadow, known memories), `backend/memory/src/background.ts` |
| Node wiring | `src/server/node-memory-integration.ts` (`learningExtractorsFromEnv`) |
| Migration | `backend/memory/migrations/008-classifier-shadow.sql`: widens the `learning_decisions.action` check to allow `shadow`. Additive. Applied only to disposable clusters |
| Evaluation | `scripts/memory-classifier-eval.test.ts`, `npm run memory:classifier:eval`, `scripts/fixtures/memory-classifier-{dev,heldout,thresholds}.json`, `docs/memory/reports/stage-11-{dev,heldout}.json` |
| Decision | `docs/memory/decisions/0001-jev-classification.md` |
| Tests | `src/lib/memory/classification.test.ts` (12), `backend/memory/src/classifiers.test.ts` (9), the Stage 11 block in `backend/memory/src/postgres.live.test.ts` (3), one case in `src/lib/memory/learning.test.ts` |

Flags, all off by default and gated in production by `GIDEON_MEMORY_STAGE15_CUTOVER`:

| Flag | Meaning |
|---|---|
| `GIDEON_MEMORY_CLASSIFIER_MODE=shadow\|enforce` | Unset means off. `shadow` records codes only; `enforce` wraps the writing extractor |
| `GIDEON_MEMORY_CLASSIFIER_REMOTE_ALLOWED=1` | Spend and privacy switch, required for any mode |
| `GIDEON_MEMORY_CLASSIFIER_PROVIDER=jev\|substitute` | Default `jev`. Needs `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` respectively |
| `GIDEON_MEMORY_CLASSIFIER_WORKFLOW=verify\|gate` | Default `verify` |
| `GIDEON_MEMORY_JEV_MODEL` | Default `jev-1.13.0`, pinned |
| `GIDEON_MEMORY_CLASSIFIER_MODEL` | Default `openai/gpt-6-luna` |

Unknown values mean off. A missing key means the plain extractor runs.

## Decisions and deviations

- **No Jev result exists.** Every Jev arm is reported `BLOCKED`, not mocked. The substitute arm is always labeled as not-Jev.
- **Why a substitute arm.** The user asked for the OpenRouter path so the workflow could be measured without Jev. The substitute therefore measures the workflow design (verify vs gate), not Jev.
- **Thresholds.** They were chosen on dev by an error-cost objective (false memory 5, miss 1) and frozen in git at `1bd5d69` with the held-out file's hash before the held-out run. The held-out run asserts that hash.
- **Reader repair after the first dev pass.** The sentence-level sensitivity check changed the shared reader after the first dev pass. Dev thresholds were then re-derived from cached responses at no spend, came out identical, and were only then frozen.
- **Matching rules.**
  - A learned item matches on status, scope and the labeled `contains` term.
  - Polarity is required for preferences.
  - Kind is recorded but not required, because the fact/constraint taxonomy is fuzzy across extractors.
- **Adoption:** see the ADR. Jev is deferred. Classifier-assisted learning is not enabled. Gating is rejected. Activity classification stays off the serving path.

## Verification

| Command/check | Environment | Result | Evidence |
|---|---|---|---|
| `npx tsc --noEmit` | Local | PASS | Exit 0 after final edits |
| `npx vitest run src/lib/memory/classification.test.ts src/lib/memory/learning.test.ts` | Local, no network | PASS, 35 tests | Contract, verdicts, failure modes, workflow, flags, reader repair |
| `npx vitest run backend/memory/src/classifiers.test.ts backend/memory/src/model-extractor.test.ts` | Local, fixture HTTP | PASS, 11 tests | TypeSafe request shape against the documented contract, errors, retry, timeout/cancel, key hygiene; substitute; wiring |
| `npm run memory:postgres:test` | Fresh disposable PostgreSQL 17 | PASS, 30/30 (27 earlier + 3 Stage 11) | C30, shadow codes only, scope-bound relation stage |
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` | Local offline suite | PASS, 99 files / 1042 tests, 1 skipped (the phase-gated live eval) | Suite log |
| `npm run memory:extraction:eval` | Local | Unchanged: precision 1, recall 0.885, 0 false memories | Stage 10 report not rewritten |
| `MEMORY_CLASSIFIER_EVAL_PHASE=dev MEMORY_CLASSIFIER_EVAL_LIVE=1 npm run memory:classifier:eval` | Live OpenRouter, `openai/gpt-6-luna` only | 231 calls, $0.0225 | `docs/memory/reports/stage-11-dev.json`, `scripts/fixtures/memory-classifier-thresholds.json` |
| `MEMORY_CLASSIFIER_EVAL_PHASE=heldout MEMORY_CLASSIFIER_EVAL_LIVE=1 npm run memory:classifier:eval` | Live OpenRouter, single run with frozen thresholds | 178 calls, $0.0165 | `docs/memory/reports/stage-11-heldout.json` |
| TypeSafe (Jev) live call | — | BLOCKED: no `TYPESAFE_API_KEY` | — |

### Held-out results (56 cases)

| Arm | Accepted precision | Recall | False accepts | Escalations | Cost | Provider p50/p95 |
|---|---|---|---|---|---|---|
| Rules (default) | 0.77 | 0.32 | 3 | 0% | $0 | local |
| Luna extractor | 0.68 | 0.68 | 9 | 0% | $0.0050 | 2.9 s / 4.9 s |
| Extractor + Luna verify | 0.85 | 0.53 | 2 | 45% | $0.0102 | 5.7 s / 8.9 s |
| Luna gate + extractor | 0.67 | 0.65 | 9 | 0% | $0.0073 | 5.1 s / 8.0 s |
| Rules + Luna verify | 0.88 | 0.24 | 1 | 31% | $0.0023 | 3.1 s / 5.8 s |

Other held-out measurements:
- **Classifier calibration** (sincere-claim probability):
  - verify-on-extractor: Brier 0.31, ECE 0.30;
  - verify-on-rules: Brier 0.25, ECE 0.24.
- **Selective risk** for verify-on-extractor at 25/50/75/100% coverage: 0.10 / 0.21 / 0.31 / 0.40.
- **Failures:** timeouts 0, classifier failures 0.
- **Activity:** coverage 0.94, selective accuracy 1.00 over 16 cases. The rules baseline has coverage 0.
- **Latency** was measured from a workstation in Pakistan, not from the deployment region.
- **Per-class and per-category tables** are in the report.

### Seed-case coverage

| Case | Executable evidence |
|---|---|
| C30 | Live "C30: with Jev unavailable, explicit remember is deterministic and accepted; ambiguous capture stays pending". It covers:<ul><li>a hanging classifier;</li><li>explicit remember accepted while learning is in flight;</li><li>the learned item is `candidate` / `classifier_abstained`;</li><li>the receipt is not `accepted`;</li><li>recall shows the text only as source evidence.</li></ul>The unit test "C30: a failed, slow, cancelled or malformed classifier abstains" covers four failure kinds plus cancellation propagation |
| C03 | Held-out `h-asr-3` / `h-correction-*` and dev `d-correction-1` / `d-entity-1` have `forbidden` terms (Java, Gulberg, Corolla, Faisalabad). There were 0 forbidden hits in every arm on both splits |
| C06 / C28 | `d-cs-1`, `h-cs-2`, `h-time-2` and Stage 10 `cs-scope-1` measure local candidate recall. The verify arm narrows durable-looking task instructions (unit test "verify: refuses, narrows or holds") |
| C07 | Temporary cases `d-time-*` and `h-time-*` are measured. No arm emits `until` dates, so time-bounded exceptions remain the explicit `remember until` path from Stage 10 |
| C11 | Quote cases in both splits. Rules had a false accept on `d-ru-3` (dev); verify-on-extractor had 0 refusal-category false memories on held-out |
| C12 | Hypothetical cases in both splits: 0 false memories in all arms on held-out |

Negative and failure checks:
- malformed, partial and contradictory answers;
- timeout vs cancellation;
- 401, 422, 429 (retried once) and 529 with recovery;
- oversized state rejected locally;
- the key never appears in errors;
- a relation stage that never sees another scope's memory or any identifier;
- a failing shadow never fails the job;
- decision rows hold no user text.

## Operational behavior

- **Nothing runs by default.** With the flags unset, learning uses the local rule extractor, exactly as in Stage 10.
- **Where the classifier runs.** Only in background learning, after the Stage 10 settle delay. It never runs on a voice turn, the HTTP turn path or explicit commands.
- **Timeouts.**
  - Classification has its own deadline (default 8 s), inside the job deadline (20 s).
  - The job's abort signal propagates to the classifier.
  - The shadow run has the job deadline.
- **Retries.** TypeSafe retries 429/529 once with backoff, capped at 5 s.
  - A classifier failure abstains. It does not fail the job.
  - An extractor failure keeps Stage 10's bounded retry.
- **Budget.** Classifier usage is added to the Stage 10 per-user daily cost budget.
- **Credentials.** `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` are read server-side only, and only when the mode, provider and spend switch are all set.
- **Retention and deletion.** Shadow decision rows cascade with their source event on purge, as before. Classifier requests are not stored.
- **Disable or revert.**
  - Unset `GIDEON_MEMORY_CLASSIFIER_MODE`.
  - To remove the dependency, delete `typesafe-classifier.ts`, `llm-classifier.ts` and `learningExtractorsFromEnv`.
  - Keep migration 008. It only widens a check constraint, and removing it would reject existing shadow rows.
  - Keep the reader repair (sentence-level sensitivity). It is a privacy fix.

## Remaining gaps

- **No Jev measurement.** This needs a TypeSafe key and an authorized spend of well under $0.01 at listed prices. Then set `TYPESAFE_API_KEY` and rerun both phases. The frozen-threshold procedure requires new thresholds selected on dev for Jev before its held-out run.
- **The held-out split is small and not independent.** It has 56 cases and 16 activity cases, written by the same author as dev. Stage 13 owns independent held-out evaluation.
- **Rules corroboration is loose.** They missed "Again, I really prefer window seats" as a duplicate (`h-rel-2`, lexical similarity below 0.75).
- **Weak spots remain in both arms.** Rules miss sarcasm (`d-joke-1`) and Roman-Urdu reported speech with "kehti hain" (`d-ru-3`). The Luna extractor accepts stated changes as new current facts unless verified.
- **Time bounds are not extracted.** No extractor emits valid-time bounds; temporary state is caught only as local or per-task scope.
- **No production, staging, deployment, real-user or live-voice evidence.**

## Next stage contract

- Edge: `MemoryClassifier`, `ClassifierRequest`, `parseClassifierAnswers`, `candidateQuestions`, `relationQuestions`, `activityQuestions`, `candidateVerdict`, `activityVerdict`, `createClassifiedExtractor`, `classificationTraceOf`, `memoryClassifierPlan`, and `decideCandidate(..., { sourceText })`.
- Node: `createTypeSafeClassifier`, `createSubstituteClassifier`, `compareShadow`, the `processLearningJob` options `shadow` and `includeKnownMemories`, and `learningExtractorsFromEnv`.
- Stage 12 can present `candidate` items with reason `classifier_abstained` or `change_requires_review` as "proposed" in the inspector. It can also show shadow disagreement counts, as reason codes only.
- Stage 13 can reuse `scripts/memory-classifier-eval.test.ts`, its cache and its frozen-threshold procedure for independent held-out data.
- Next prompt: `docs/memory/implementation/12-memory-controls.md`.
