# ADR 0001: Jev and classifier-assisted learning stay off by default

Status: accepted, 2026-09-24 (Stage 11)
Scope: background learning only. Explicit remember, correct and forget never use a classifier.

## Context

The foundation (section 9) proposes Jev, TypeSafe's System One model, as an optional classifier for memory candidacy, temporary-versus-durable scope, relation to known memories, and applicability. Stage 11 asked for a removable adapter, a matched comparison, and a decision backed by evidence.

Checked on 2026-09-23 against the official API reference (`docs.typesafe.ai/api.md`, `models.md`):

- Endpoint `POST https://api.typesafe.ai/v1/systemone`, bearer key.
- Pinned model `jev-1.13.0`.
- $0.042 per million input tokens.
- Limits: 64k tokens per request; 1,200 requests per minute.
- English is the strongest language.

Jev is not served through OpenRouter. No `TYPESAFE_API_KEY` exists in this environment, so no Jev call was made.

## What was measured

`npm run memory:classifier:eval` runs every arm on the same cases through the same reader: screen, extract, validate, reconcile.

- **Data.** Dev split: 73 cases, meaning 43 from Stage 10 plus 30 new. Held-out split: 56 cases. The splits share no trajectory and no normalized text.
- **Thresholds.** Chosen on dev only by an error-cost objective, where a false memory costs 5 and a miss costs 1. They were frozen in `scripts/fixtures/memory-classifier-thresholds.json`, committed at `1bd5d69` before the held-out run, together with the held-out file's hash.
- **Substitute classifier.** Because Jev was unavailable, `openai/gpt-6-luna` answered the same Choice/Noul questions through OpenRouter. It reports its own probabilities. It is a proxy for the workflow, not for Jev.
- **Spend.** $0.036 of OpenRouter credit across both phases: 409 provider calls, all to that one model.

Held-out results (`docs/memory/reports/stage-11-heldout.json`):

| Arm | Accepted precision | Recall | False accepts | Review escalations | Cost / 56 cases | Provider p50 / p95 |
|---|---|---|---|---|---|---|
| Rules (current default) | 0.77 | 0.32 | 3 | 0% | $0 | local |
| Luna structured extractor | 0.68 | 0.68 | 9 | 0% | $0.0050 | 2.9 s / 4.9 s |
| Extractor + Luna verify | 0.85 | 0.53 | 2 | 45% | $0.0102 | 5.7 s / 8.9 s |
| Luna gate, then extractor | 0.67 | 0.65 | 9 | 0% | $0.0073 | 5.1 s / 8.0 s |
| Rules + Luna verify | 0.88 | 0.24 | 1 | 31% | $0.0023 | 3.1 s / 5.8 s |
| Any Jev arm | BLOCKED | — | — | — | — | — |

Latency was measured from a workstation in Pakistan to OpenRouter, so it is not deployment-region latency.

Calibration of the substitute's "sincere current claim" probability on held-out: Brier 0.31, ECE 0.30. Risk at 25/50/75/100% coverage: 0.10 / 0.21 / 0.31 / 0.40. Its probabilities cannot be read as the chance that a memory is true.

Activity classification (applicability) on held-out: 94% coverage and 100% selective accuracy on 16 cases. The app currently sends no activity kind.

## Decision

1. **Jev: deferred.** The adapter (`backend/memory/src/typesafe-classifier.ts`) is implemented and tested against the documented contract with fixture HTTP. It has not been verified live. Adoption needs the blocked arms run with a key: set `TYPESAFE_API_KEY` and rerun both phases. The cache and frozen-threshold procedure then give a matched comparison against the arms above.
2. **Classifier-assisted learning is not enabled.** `GIDEON_MEMORY_CLASSIFIER_MODE` stays unset, which means off.
   - **Extractor + verify.** It improved on the rules default for both precision and recall on held-out. It still falls short of enforcement, for four reasons:
     - it sends private turns to a remote model, which needs a product and consent decision this stage cannot make;
     - it doubles cost and adds about 6 s per turn in the background;
     - it holds 45% of proposals for review with no review UI yet (Stage 12 shows them as proposed inferences);
     - the evidence comes from 56 cases written by the same author as the dev set.
   - **Next step for this configuration:** a `shadow` run for an internal cohort that consented to remote processing, using the decision log's disagreement codes, and then an independent held-out set in Stage 13.
3. **Gating is rejected.** It saved nothing: the gate call cost as much as extraction and rarely skipped. It also left the extractor's false accepts in place.
4. **Rules + verify is rejected for now.** It removes false accepts but loses a quarter of the rules' already low recall.
5. **Activity classification is not put on the serving path.** A remote call on every voice turn is excluded by the foundation, and one call takes seconds. The measured accuracy justifies a later experiment that runs it asynchronously on a topic change.

## Consequences and safeguards

- **Default behavior is unchanged.** Learning uses the local rule extractor, with no remote calls.
- **Classification only makes things more conservative.** It can refuse a proposal, hold it for review, or narrow it to the current task. It cannot widen scope or rescue a refused speech act. It never sees assertion, scope or tenant identifiers, and it never picks a write target.
- **Failure means abstention.** Timeouts, cancellation, outages and malformed answers leave proposals pending review. Explicit commands are unaffected (C30, live PostgreSQL test).
- **Shadow mode is inert.** It writes only reason codes (`learning_decisions.action = 'shadow'`, migration 008) and never memory.
- **The dependency is removable.** Unset the flags, or delete the two adapter files and `learningExtractorsFromEnv`. Migration 008 only widens a check constraint.
- **The shared reader was repaired.** The dev run found that an extractor quoting only part of a sentence could hide a special-category topic ("I am a diabetic and I love sweets"). The reconciler now checks the whole sentence around the evidence, for every extractor.
