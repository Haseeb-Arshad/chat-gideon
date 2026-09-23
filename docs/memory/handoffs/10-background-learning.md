# Stage 10 handoff: conservative extraction, conditional preferences, and bounded maintenance

Status: LOCAL_VERIFIED
Implementation commit or working-tree identifier: working tree on `fix/reliability-and-memory-isolation` after `7b6eee1`; uncommitted at handoff time
Date: 2026-09-23
Environment: Windows 10.0.19045 x64, Node v22.13.0, Vitest 4.1.5, disposable local PostgreSQL 17 clusters. Every command ran behind a process-level network guard that refused non-loopback connections and blanked provider keys; the guard logged zero blocked attempts. No OpenRouter, Exa or other provider was called.

## Prerequisite evidence

- Re-read the common instructions, the foundation (write path, maintenance, learning rules), the Stage 10 prompt and all Stage 01–09 handoffs.
- Before starting, Stages 01–09 were audited against their prompts with independent adversarial probes on real PostgreSQL (not the implementer's own tests). The full offline suite (92 files / 985 tests) and the PostgreSQL suite (19/19) passed at `7b6eee1`, and nine defects were found. Following the entry-gate rule ("repair a small directly blocking prerequisite with tests and document it"), all nine were repaired first, because several would have corrupted Stage 10 behavior (a learner writing through a content-hash tombstone, recall ignoring conversation state, no worker to run jobs).

### Prerequisite repairs (Stages 01–09)

| # | Stage | Defect found by probe | Repair and regression test |
|---|---|---|---|
| 1 | 05 | After purge the assertion tombstone kept `canonical_key`, an unkeyed SHA-256 of the normalized proposition; a dictionary attack recovered "I am pregnant" | Logical deletion and restore replay set `canonical_key = NULL`; migration 006 scrubs existing tombstones. Live test asserts no deleted row keeps a key |
| 2 | 05 | A forgotten fact could never be explicitly remembered again (`suppressed` forever) | A new explicit command gets a new identity; replaying the deleted command ID stays `suppressed` before and after purge via retained event suppression. Live test covers both |
| 3 | 09 | The Cloudflare Worker bundle contained `pg` and the Node adapter, contrary to the Stage 09 handoff | Cloudflare builds resolve `node-memory-integration` to a stub; `build:cloudflare` now runs `scripts/check-worker-bundle.mjs`, which fails on `pg`/adapter markers |
| 4 | 09 | App recall passed an empty activity, no recent span and no conversation state; `remember` always sent `conditions: []`; `replaces` was silently ignored; `correct` could not say "changed" vs "mistake" | `recall-context.ts` feeds topic, the committed turns before the query, local instructions and bounded state into retrieval. `remember` accepts `appliesTo`, `until`, and `replaces`+`since` (a real transition of one exact memory). `correct` accepts `change` and `since`. The activity kind stays unknown and is not guessed |
| 5 | 05/07/09 | Nothing in the app ran purge, projection rebuilds or the job queue; forgets reported "cleanup pending" indefinitely | Stage 10 maintenance runner (below) |
| 6 | 06 | Topic/label matching used substrings ("my Taiwan trip" resumed a topic called "AI") | Whole-word matching; regression test |
| 7 | 06 | `conversationContext` cut at 8,000 chars mid-word with no marker (invariant 13) | Oldest uncovered turns are dropped with a count notice; a lone oversize line is marked `…[trimmed for length]` |
| 8 | 03 | Concurrent identical captures got a retryable `conflict` instead of the original receipt | Under READ COMMITTED the waiting duplicate re-reads the winner and returns its receipt; live test with 8 simultaneous deliveries |
| 9 | 09 | Capture then recall ran sequentially before the model started | They now run concurrently. Time-to-audio is still unmeasured |

All nine original probe checks now fail against the repaired code, which confirms the fixes.

## Implemented behavior

- **Committed turns only.** A captured `user_statement` event enqueues an `interpret_event` job (unchanged since Stage 03). The worker builds a window from that turn plus at most three earlier committed user turns of the same conversation. Speculative text never reaches it.
- **Screen before any extractor.** Windows containing secret-like material (keys, tokens, card/CNIC-like numbers, "my password is …") or asking to forget, delete or not remember something are closed without extraction. The second rule stops the learner from re-learning "I like tea" out of "forget that I like tea".
- **Replaceable extractor.** `MemoryExtractor` returns untrusted JSON. The default `RULE_EXTRACTOR` is local and deterministic, covering English, Roman Urdu and code switching. An optional model adapter exists but is off (see Decisions). Every candidate must cite an exact span: `validateExtractorOutput` drops any candidate whose quote is not literally at its offsets in the committed text, along with unknown enums, bad conditions, oversized output and timeless exceptions.
- **Distinct speech acts.**
  - Quotes of other people, hypotheticals ("imagine", "farz karo"), jokes, questions and assistant echoes are refused, each with a reason code.
  - A spoken self-repair ("I use Java, sorry, I mean Jev") keeps only the words after the repair (C03).
  - Per-task instructions ("for this email", "is project ke liye") become local, inferred candidates.
  - A stated change ("I moved to Karachi") is held as a candidate for review rather than becoming a second current fact.
  - Tool outcomes are recorded only from verified receipts (Stage 09), never re-derived from text.
- **Deterministic reconciliation.** This happens inside the commit transaction, against current unsuppressed memory:
  - A near-duplicate with the same conditions and polarity **corroborates**: a `supports` evidence edge is added, no new assertion.
  - Opposite polarity is a **dispute** (`contradicts` edge), never an overwrite.
  - A proposed correction of a user-authored memory (`explicit_user_statement` or `user_correction`) is downgraded to a dispute (C32).
  - Special-category topics (health, religion, sexuality, politics, ethnicity, criminal record, immigration, finances) are never learned implicitly.
  - Explicit `remember` is unaffected by any of this.
- **Commit safety.** The model/extractor call runs outside every transaction. The commit transaction:
  - locks and rechecks the job's fence and lease;
  - rechecks the policy epoch, restore guard and input suppression;
  - confirms the source event still exists unchanged with consent;
  - takes the scope policy lock (the same serialization explicit commands use);
  - keeps 10% of the durable quota free for explicit commands.

  If an unrelated deletion moved the scope's deletion epoch mid-extraction, nothing is committed and the job is requeued to recompute. If the input itself was deleted, the job is dead-lettered with nothing written.
- **Learned writes.** Accepted items are ordinary assertions:
  - basis `explicit_user_statement` for plain self-statements;
  - producer `gideon-rules` with version, prompt version and schema version, plus exact-span evidence and an event dependency;
  - a `learned` change-feed row, so correction overlays and projections see them;
  - a projection invalidation job;
  - the event receipt moves to `accepted`.

  Inferred items are `candidate`s with basis `inference`, invisible to recall until promoted.
- **Promotion policy** (`DEFAULT_PROMOTION_POLICY`): at least 3 distinct conversations, at least 2 distinct days, zero counterevidence, no sensitive category.
  - Only committed user statements count, once per conversation. Repeated turns, duplicate deliveries and generated or assistant text are not evidence (C13, C21, C31).
  - A promoted revision says so in its text ("Inferred from requests in N separate conversations: …"), keeps basis `inference`, and drops the per-task marker.
  - Candidates unsupported after 90 days are retired.
- **Shadow re-extraction.** `shadowReextract()` runs a new extractor over earlier-learned turns and returns a diff: unchanged, added, missing, polarity changed, and preserved user edits. It never writes and skips suppressed events.
- **Bounded maintenance.** `runMemoryMaintenance()` works in this priority order, each step capped:
  1. physical purge;
  2. coalesced warm-view rebuilds per scope;
  3. learning, at most two jobs per user per tick, with interpretation jobs settling 15 s so same-turn explicit commands land first;
  4. promotion and retirement;
  5. a content-free queue report (pending, dead, oldest age).

  Per-user daily budgets (jobs, units, cost) defer learning to the next UTC day without spending attempts; explicit commands are never budgeted. Expired temporary state needs no rewrite because valid time is evaluated at read.
- **Runner and flags.** `startMemoryBackground()` runs ticks without overlap, can be stopped cleanly, and logs only a failure count. The Node adapter starts it once per process when `GIDEON_MEMORY_BACKGROUND_ENABLED=1`. Learning additionally needs `GIDEON_MEMORY_LEARNING_ENABLED=1` and the owner's rollout cohort. Owners whose learning is off have their queued turns closed as `learning_disabled`, not learned later.
- **Decision log.** `learning_decisions` stores reason codes and identifiers only, never text, and cascades away with its source event when a deletion is purged.

## Source and schema map

| Concern | Paths |
|---|---|
| Edge-safe learning core | `src/lib/memory/learning.ts`, `src/lib/memory/rule-extractor.ts`, `src/lib/memory/screening.ts` (shared with Stage 08 retrieval), exported from `src/lib/memory/index.ts` |
| Worker, promotion, shadow diff | `backend/memory/src/learning.ts` |
| Optional model extractor | `backend/memory/src/model-extractor.ts` |
| Maintenance tick and runner | `backend/memory/src/background.ts` |
| Job claims | `backend/memory/src/jobs.ts`: claims now return `kind`, and accept `kinds`, `minAgeMs` (settle on `available_at`) and `perScopeLimit` (fairness). New in-transaction helpers: `checkRunningJob`, `finishCheckedJob`, `requeueCheckedJob`, `retryCheckedJob`, `deadLetterCheckedJob`. Existing `claimJobs`/`completeJob` behavior is unchanged for old callers |
| Command helpers | `backend/memory/src/commands.ts` exports `acceptedAssertionCount`, `allocateWatermark`, `watermarkId` |
| Migrations | `006-tombstone-canonical-keys.sql` (repair), `007-background-learning.sql` (`learning_decisions`, `learning_budgets`, change kinds `learned`/`promoted`/`retired`, job-kind index). Applied only to disposable harness clusters |
| Flags | `src/lib/memory/rollout.ts`: `memoryLearningEnabled()`, `memoryBackgroundEnabled()` |
| Node wiring | `src/server/node-memory-integration.ts` (runner start, extractor selection, recall context, tool shapes) |
| Post-audit repairs | `backend/memory/src/deletion.ts`, `backend/memory/src/postgres.ts`, `src/lib/conversation-state.ts`, `src/lib/agent-core.ts`, `src/lib/tools/registry.ts`, `src/lib/memory/recall-context.ts`, `src/server/node-memory-integration.worker.ts`, `vite.config.ts`, `scripts/check-worker-bundle.mjs`, `package.json` |
| Evaluation | `scripts/memory-extraction-eval.test.ts`, `scripts/fixtures/memory-extraction-dev.json`, `docs/memory/reports/stage-10-extraction-eval.json`, `npm run memory:extraction:eval` |
| Tests | `src/lib/memory/learning.test.ts`, `src/lib/memory/recall-context.test.ts`, `src/lib/conversation-state.test.ts` (2 added), `backend/memory/src/model-extractor.test.ts`, `backend/memory/src/postgres.live.test.ts` (8 Stage 10 cases plus repaired Stage 03/05 assertions) |

Flags, all default off:

| Flag | Meaning |
|---|---|
| `GIDEON_MEMORY_BACKGROUND_ENABLED` | Runs the maintenance runner |
| `GIDEON_MEMORY_BACKGROUND_INTERVAL_MS` | Tick interval |
| `GIDEON_MEMORY_LEARNING_ENABLED` | Enables implicit learning |
| `GIDEON_MEMORY_EXTRACTOR=rules\|model` | Chooses the extractor |
| `GIDEON_MEMORY_EXTRACTOR_REMOTE_ALLOWED` | Spend switch; required for the model extractor |
| `GIDEON_MEMORY_EXTRACTOR_MODEL` | Model name, default `openai/gpt-5.6-luna` |

Production additionally requires `GIDEON_MEMORY_STAGE15_CUTOVER=1`.

## Decisions and deviations

- **Rules first, model optional and off.** The user's instruction for this work was to spend no OpenRouter credit. The rule extractor is the default and the only extractor evaluated. The model adapter is implemented and exercised against a fixture provider (request shape, local offset computation, fabricated-quote rejection, error handling), but it is not quality-evaluated. It needs two independent switches, including a spend switch, to run at all.
- **Reconciliation is in code, not in the model.** The extractor's `operation`/`targetAssertionId` are hints. Ownership, revision, polarity, conditions and user-authored protection are decided by `decideCandidate()` inside the commit transaction.
- **Corroboration uses evidence edges.** Stage 05 deletion expansion follows evidence edges, so forgetting a learned memory also suppresses the turns that corroborated it, and they cannot re-teach it. Because deletion is per turn, other memories learned from those same turns are removed too. This is the conservative direction; per-claim span-level deletion would be a later refinement.
- **Unrelated deletions force recomputation, related ones kill the job.** The Stage 03 `completeJob` still dead-letters on any epoch change. The new learning path distinguishes the two cases (`stale_epoch` vs `revoked`) so one forget does not discard every queued learning job in the scope.
- **No episode summaries were added.** Decision and rejection reasons persist as reason codes in `learning_decisions`. Automatic episode checkpoints still need a consent and inspector UX (Stage 12), in line with "avoid daily/hourly summary jobs".
- **Activity kind remains unknown in app recall.** Classifying "this is a work meeting" from free text is interpretation work for Stage 11 (Jev) or a later interpreter. Activity-conditioned constraints therefore stay `conditional` in the live app rather than being guessed.
- No foundation amendment. Identity, deletion, receipt and authority semantics are unchanged, except repair 2, which makes explicit re-statement after deletion possible while keeping replay blocked.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npx tsc --noEmit` | Local TypeScript | PASS | Exit 0 after final edits |
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` | Local offline suite, network guard | PASS, 94 files / 992 tests; 2 UI files (`chart.test.tsx`, `blocks.test.tsx`) did not start (Vitest worker-start timeout under host load) and are counted in the next row | Suite output |
| `npx vitest run <2 UI files> src/lib/memory scripts/memory-extraction-eval.test.ts backend/memory/src/model-extractor.test.ts --maxWorkers=1` | Local, network guard, after the final forget-screen edit | PASS, 13 files / 116 tests | Includes learning 22/22, recall-context, projections, retrieval, edge-entry boundary |
| `npm run memory:postgres:test` | Fresh disposable PostgreSQL 17 cluster | PASS, 1 file / 27 tests (19 Stage 03–09 incl. repaired assertions + 8 Stage 10) | `backend/memory/src/postgres.live.test.ts` |
| `npm run memory:extraction:eval` | Local, rules only, zero provider calls | PASS (hard gates: 0 false memories, 0 polarity errors) | `docs/memory/reports/stage-10-extraction-eval.json` |
| `npm run build:cloudflare` | Local Cloudflare/Vite build + typecheck + bundle check | PASS; "Worker bundle is free of the Node PostgreSQL memory adapter." | Build output |
| `npm run build` | Local application/SSR/realtime build | PASS | Build output |
| Original audit probes rerun against repaired code | Fresh disposable PostgreSQL | All 4 "FINDING CHECK" probes now fail (defects gone); concurrent-capture stress passes | Probe files kept outside the repo |
| Network guard log | All runs above | Empty: zero outbound attempts | Session scratchpad |

### Extraction evaluation (development set, rules only)

43 hand-authored cases (English, Roman Urdu, code-switching, speech corrections, quotes, hypotheticals, jokes, sensitive, secrets, forget requests, hard implicit phrasing). Precision **1** (23/23 learned items correct), recall **0.885** (23/26; 3 missed, all in the deliberately hard implicit category), false memories from refusal categories **0**, wrong scope 0, wrong polarity 0, wrong status 0. Cost: 0 provider calls, 0 micros. Time errors are not measured because the rule extractor emits unknown valid time. The evaluation already caught and fixed one real false memory during development (the C03 self-repair case). This is development evidence, not a held-out benchmark.

### Seed-case coverage

| Case | Evidence | Boundary |
|---|---|---|
| C03 | `learning.test.ts` "C03: after a spoken self-repair…"; eval `en-speech-1` | Final committed text only; ASR hypotheses never reach capture (Stage 09) |
| C06 / C28 | `learning.test.ts` "C28: keeps a project-local formal exception local…"; eval `cs-scope-1`, `en-instruction-2` | Local exception is a scoped candidate; general default is accepted |
| C07 | Temporary exceptions carry `validTime.until` and are read by valid time (Stage 04/08); the `remember until` tool shape is in `recall-context.test.ts` | No scheduler rewrite needed |
| C08 | `learning.test.ts` "C08: keeps the stated rejection reason verbatim…"; eval `en-decision-1` | No brand or budget inference |
| C11 | Unit test and live "C11/C12" case; eval `en-quote-*`, `cs-quote-1` | Includes third-party paraphrase without quotes |
| C12 | Unit test and live "C11/C12" case; eval `en-hypo-*`, `ru-hypo-1` | |
| C13 | Unit "C13" and live "C13/C31" (one conversation stays a candidate) | |
| C14 | Stage 06 state already keeps unresolved decisions; learning does not claim a choice (decisions are verbatim clauses) | No new episode summary |
| C21 | Live "C21: a duplicated delivery is one job and one memory…" and repair 8 | |
| C22 | Live "C22: an in-flight extraction cannot commit after its source is deleted…" and the maintenance purge case | |
| C31 | Unit "C31" (assistant/imported copies don't count) and live promotion | |
| C32 | Unit "C32" (user-authored target protected) and live shadow re-extraction (diff, no writes) | |
| C36 | Stage 08 overrides are unchanged; learning never promotes a per-task instruction without cross-conversation support | |

Negative and concurrency evidence:
- secret and withdrawal screening, including prior turns;
- fabricated-quote rejection;
- sensitive-category refusal;
- deletion of the input mid-extraction (dead-lettered, nothing written);
- unrelated deletion mid-extraction (recomputed);
- budget deferral without spending attempts;
- learning-disabled owners closed without extraction;
- decision rows contain no user text;
- the Worker bundle check.

## Operational behavior

- **Startup:** lazy. The runner starts on the first memory request that creates the PostgreSQL store, and only with `GIDEON_MEMORY_BACKGROUND_ENABLED=1`. The first tick runs within 2 s, then every 10 s by default. Timers are `unref`'d.
- **Shutdown:** `stop()` aborts, waits for the running tick, and requeues claimed-but-unstarted learning jobs without spending attempts. Leases (30 s) and fences protect against a crashed tick.
- **Retries:** extractor failures retry with the existing bounded backoff (5 attempts, then dead-letter with a safe code). Budget deferral and stale-epoch recomputation do not spend attempts.
- **Credentials:** the rule extractor needs none. The model extractor reads `OPENROUTER_API_KEY` server-side only, and only when both switches are set.
- **Retention and deletion:** learned memories are ordinary assertions; `forget` and purge remove them with their evidence, edges, change-feed rows and decision rows. Tombstones no longer carry content-derived keys.
- **Disable/revert:** unset `GIDEON_MEMORY_LEARNING_ENABLED` to stop learning (queued turns close as `learning_disabled`), or unset `GIDEON_MEMORY_BACKGROUND_ENABLED` to stop all background work (jobs wait). Migrations 006–007 are additive; do not drop tables. Code revert: revert the Stage 10 working-tree changes while keeping migrations applied, because 006 is a privacy repair and must not be undone.

## Remaining gaps

- No staging or production run, deployment, remote migration, real provider, live voice or real-user data. `LOCAL_VERIFIED` only.
- The model extractor's quality, cost and latency are unmeasured; this needs authorized spend. The rule extractor misses implicit phrasings by design (3 of 26 expected items in the dev set).
- The dev set is public and hand-authored, not held-out. Stage 13 owns held-out evaluation.
- Activity-kind interpretation for implicit applicability (C09 in the live app) is not implemented; see Stage 11.
- Deletion is per turn, not per claim: forgetting one learned memory also removes others learned from the same turns.
- The p95 30 s event-to-ready target is not measured under load; the default settle (15 s) plus interval (10 s) bounds a quiet system.
- The runner is not wired into `server/serve.mjs` directly; it starts with the first memory-enabled request.

## Next stage contract

- Edge: `MemoryExtractor`, `ExtractionWindow`, `ExtractionCandidate`, `validateExtractorOutput`, `decideCandidate`, `evaluatePromotion`, `diffShadowExtraction`, `screenWindow`, `RULE_EXTRACTOR` and `extractWithRules` from `src/lib/memory/index.ts`.
- Node: `processLearningJob`, `promoteLearnedCandidates`, `shadowReextract`, `runMemoryMaintenance`, `startMemoryBackground`, `createModelExtractor` and the checked-job helpers from `backend/memory/src/index.ts`.
- Stage 11 (Jev) can plug in as another `MemoryExtractor`, or as a classifier that fills candidate speech acts and activity kinds, and be compared with `shadowReextract()` and `npm run memory:extraction:eval`. It must not decide tenancy, grants or deletion targets, and learned output must stay behind `decideCandidate()`.
- Next prompt: `docs/memory/implementation/11-jev-experiment.md`. Do not begin it as part of this handoff.
