# Plan B evaluation protocol

Registered before the first paid Plan B quality evaluation on 12 October 2026. Offline construction checks had already run; the smoke set is a separate development check.

Internal challenge fixture: `scripts/fixtures/memory-plan-b-heldout.json`, SHA-256 `20dffa0db576983b53a457db60cf7827fc1a0cf0e4c8b50c522bc6904a9920d1`. Forty independent owners, 320 queries. This is an internal synthetic challenge set; its repeated scenario families do not establish public benchmark performance.

Primary comparison: full canonical memory against the existing explicit profile plus session-summary baseline, using the same reader. Required: at least 300 complete answers, gain >= 0.05, trajectory-cluster bootstrap 95% lower bound > 0. Cached answers must be keyed to exact prompts and the fixture. No gold evidence or rubric enters the reader. Keep answer ordering hidden from the judge. Report reader/model and extractor versions, costs, incomplete calls and failures.

Context ablations: semantic provider, compact pack, consolidation, source evidence, constraint applicability, relationship expansion. Rule-only and model extraction run as separate ingestion experiments; they must not share an authority scope or accepted corpus.

Other gates: multilingual recall gain >= 0.15; false learned memory rate no greater than rules-only; compact capacity >= twice the prior byte-budget pack; C01-C36 all pass; production physical-purge p95 < 600 s; no cleanup older than one day; no regressions on independently executed overlay cases. Record production latency separately from local SQL or virtual microphone tests.

Public imports: LongMemEval oracle diagnostic, LoCoMo-Plus cognitive cue-only diagnostic, PersonaMem original multiple-choice 32k protocol. Preserve source roles, question cutoffs and native answer formats. Diagnostic imports must never be reported as scores on the full-history/stitched official tracks. Store exact source hashes in `output/memory-plan-b-datasets/manifest.json`; generated data is not published with the code.

`scripts/lib/memory-proof.ts` refuses a 9.5 claim while any gate lacks evidence. The implementation and local conformance are separate from the rating.
