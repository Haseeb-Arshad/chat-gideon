# Stage 08 handoff: hybrid retrieval and context composition

Status: LOCAL_VERIFIED

Implementation commit or working-tree identifier: `de46c69ec6ff1fe098da195da68239c7def007d6` (`feat(memory): implement stage 08 retrieval`)

Date: 2026-09-23

Environment: Windows local checkout, Node `v22.13.0`, disposable PostgreSQL 17 used by the owned local memory test harness

## Prerequisite evidence

- Re-read `docs/memory/implementation/00-COMMON-INSTRUCTIONS.md`, `docs/memory/FOUNDATION-2026-09-21.md`, `docs/memory/implementation/00-PROGRESS.md`, the Stage 08 prompt, and the Stage 07 handoff before editing.
- Stage 07 handoff: `docs/memory/handoffs/07-profiles-and-snapshots.md`; implementation commit `dab0225`, documentation commit `32a6e18`.
- Stage 07 had already established bounded warm snapshots, stable/active profiles, constraints, authorized accepted change feeds, correction overlays, identity/epoch binding, and purge integration. Stage 08 reused those interfaces rather than creating a competing authority.
- The selected branch was `fix/reliability-and-memory-isolation`; its remote was at the same Stage 07 documentation commit when the stage began. The implementation commit is authored and committed by Haseeb Arshad.
- All earlier stage handoffs 01–07 remain in place. This handoff does not promote local evidence to staging, production, provider, or live-voice proof.

## Implemented behavior

- `createRetrievalRequest()` validates bounded query/context inputs and derives principal, scope, grants and policy epoch from the server-bound `MemorySession`. Client-supplied authority is rejected. Unknown referents stay unknown; the planner will not manufacture an entity or exact memory identifier.
- `buildRetrievalQueryPlan()` uses the current query, resolved structured context and at most the small, relevant committed recent span. It keeps English/Roman Urdu negation and code-switch terms, avoids whole-history concatenation, and omits unresolved referents from evidence matching.
- Retrieval supports exact ID/version reads, warm snapshot candidates, PostgreSQL lexical search, exact-vector candidates, bounded evidence/relationship expansion and deterministic reciprocal-rank fusion. Scope and accepted-current-version filters apply before authoritative hydration. Candidate, vector-scan, expansion and evidence-fetch limits are explicit.
- The exact-vector path is intentionally suitable for the bounded test corpus, not a production ANN claim. It rejects wrong scope, assertion revision, source kind/reference, model/version, dimensions and content hash, non-finite/invalid vectors, and non-positive similarity. An evidence embedding can only rank its linked accepted parent after the adapter revalidates ownership and source metadata.
- The optional embedding provider is an injected server-side callback; no provider/model is configured by default. Indexing and query embedding require explicit authorization and consent, accepted/current source checks, retention eligibility and secret screening. Stored rows contain vector plus scope/revision/model/dimension/hash/source metadata, not duplicated source text.
- Evidence fallback is bounded to permitted, committed user statements and corrections with usable retention/consent. It preserves attribution and source spans and excludes hypotheticals, role-play, quotations, suppressed sources and evidence already linked to an accepted assertion (so it does not mislabel a known extraction as a miss).
- Applicable constraints are selected independently of lexical overlap using task/project/topic/format conditions, validity, explicit exceptions and current task overrides. A condition-matched preference can apply without repeating its exact words. Unknown conditions remain conditional, and an occupation or weak association does not become a fabricated budget/fact.
- Current explicit user task instructions can override a historical default for that task only. Retrieved memory is untrusted content, never action or tool authority; dispatch must make a separate current authorization check.
- `composeContextPack()` keeps source/assertion-version/evidence attribution, time interpretation, conflicts, applicable constraints, task overrides, coverage and freshness. Contradictory bundles remain together. Token counting uses the supplied provider tokenizer when available; otherwise an explicitly named conservative UTF-8 byte upper bound is used. Answer/tool overhead is reserved, with compact/standard/expanded/maximum tiers and explicit partial, unavailable, exhausted and budget-exhausted results. No empty search is phrased as proof that the user never said something.
- Bounded deep recall accepts cancellation and enforces hard edge/evidence-fetch caps. Warm snapshot reads can receive a deadline and abort signal; the PostgreSQL adapter applies a bounded statement timeout and surfaces cancellation/unavailability instead of substituting an empty corpus.
- Migration 005 adds scoped, revision-bound derivative embedding metadata and lexical indexes. It is exercised only in the owned disposable local PostgreSQL suite; it was not run against staging or production.
- The retrieval code is exported for a later integration stage but is not wired to HTTP, realtime voice, browser, Worker, action dispatch or production background jobs here.

## Source and schema map

| Concern | Paths | Contract |
|---|---|---|
| Edge-safe request, query planning, ranking, applicability and pack composition | `src/lib/memory/retrieval.ts` | Bounded pure contracts; derives authority from `MemorySession`; no Node, DB driver, provider or secret imports |
| Edge-safe export | `src/lib/memory/index.ts` | Re-exports retrieval contracts/core; does not wire an application route |
| PostgreSQL adapter and embedding index | `backend/memory/src/retrieval.ts` | `retrieveMemory()` and `indexAuthorizedEmbeddings()` require a server-bound session and `PostgresMemoryStore`; remote work is injected and explicitly authorized |
| Backend export | `backend/memory/src/index.ts` | Exposes the Node adapter to later server integration |
| Exact vector metadata and lexical indexes | `backend/memory/migrations/005-retrieval-embeddings.sql` | FK-cascaded, scoped/revision-bound derivatives; no raw source text; local/test-only for this stage |
| Deadline-aware snapshot read | `backend/memory/src/projections.ts` | Optional deadline/signal bounds warm reads; existing snapshot authority/epoch checks remain in force |
| Migration and test safety guidance | `backend/memory/README.md` | Documents migration 005, owned disposable DB requirements and non-production boundary |
| Core behavior tests | `src/lib/memory/retrieval.test.ts` | Request identity, unresolved references, query terms/negation, constraints, validity/overrides, vector filters, conflicts, budgets, honest absence, cancellation and caps |
| Real database tests | `backend/memory/src/postgres.live.test.ts` | Three Stage 08 PostgreSQL cases added to the existing authority suite; 19 total tests |
| Paired development ablation | `scripts/memory-retrieval-ablation.test.ts`, `package.json` | `npm run memory:retrieval:ablation`; 12 synthetic fixtures, deterministic vectors, no network/model/user data |
| Report and navigation | `docs/memory/reports/stage-08-retrieval-ablation.json`, `docs/memory/implementation-map.md`, `docs/memory/implementation/00-PROGRESS.md` | Records synthetic metrics and local verification; progress is `LOCAL_VERIFIED` only |

The report's median local fixture timings exclude PostgreSQL, model/provider, network, voice and application overhead. They are not production latency SLO evidence.

## Decisions and deviations

- Exact vector scan was implemented first as requested; ANN indexing and its authorization-aware recall measurement were not added.
- The PostgreSQL adapter executes lexical/exact/vector/evidence branches with bounded candidate sets and a shared request deadline, then fuses deterministically. Provider calls remain disabled unless a caller supplies and authorizes an implementation.
- The ablation compares lexical-only, deterministic hybrid and independent applicability paths over hand-authored fixtures. The observed hybrid improvement is control-flow evidence only; it must not be presented as measured real-world semantic quality.
- Query/source secret checks suppress remote embedding dispatch rather than attempting to redact and submit an uncertain derivative. A missing or denied provider is represented as unconfigured/unavailable, not as an empty memory corpus.
- No authority, identity, deletion, consent, receipt or foundation contract was amended. Existing Stage 05 suppression, epoch advancement and FK cascades remain the privacy boundary.
- C02's retrieval-side guarantee is only that ambiguous referents stay unresolved and are not guessed. Asking the user to choose between authorized candidates is an interaction/controller behavior and remains for Stage 09; C02 is not claimed end-to-end complete here.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npx vitest run src/lib/memory/retrieval.test.ts scripts/memory-retrieval-ablation.test.ts --maxWorkers=2` | Local Node/Vitest | PASS, 2 files / 20 tests (19 core + 1 ablation) | Retrieval core and deterministic paired ablation tests |
| `npm run memory:postgres:test` | Owned disposable PostgreSQL 17; isolated `gideon_memory` test schema | PASS, 1 file / 19 real database tests | Existing Stage 03–07 authority checks plus three Stage 08 cases in `backend/memory/src/postgres.live.test.ts` |
| `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` | Local offline suite | PASS, 86 files / 967 tests | Full non-live regression suite; the incidental Stage 01 timing artifact rewrite was restored unchanged after the run |
| `npx tsc --noEmit` | Local TypeScript | PASS | Exit code 0 after the final vector source-kind guard |
| `npm run build:cloudflare` | Local Cloudflare/Vite build | PASS | Client + Worker/SSR build and configured TypeScript check; no deployment |
| `npm run build` | Local application/realtime build | PASS | Application client/SSR/Nitro and realtime host bundles; no deployment |
| `npm run memory:retrieval:ablation` | Local synthetic fixtures | PASS, 12 paired fixtures, zero provider/network calls | `docs/memory/reports/stage-08-retrieval-ablation.json` |
| `git diff --check` | Local worktree/index | PASS | No whitespace errors |

### Acceptance mapping

| Case | Executable evidence | Result and boundary |
|---|---|---|
| C02 ambiguous project reference | `keeps unresolved referents unknown and rejects an invented exact identifier` in `src/lib/memory/retrieval.test.ts` | Retrieval refuses to guess. The required user-facing clarification turn is not wired and is deferred to Stage 09; not end-to-end complete. |
| C04 historical transition | `Stage 08 resolves exact valid-at reads across a transition and labels the historical version` in the PostgreSQL suite | Current and requested historical values remain distinct, with temporal/source semantics. |
| C07 expiry | `expires a dated temporary exception while retaining the still-valid stable preference` | Expired exception stops applying while the stable preference remains. |
| C08 rejection rationale | `retains the explicit rejection reason without converting it into a global brand preference` | The reason is preserved without inventing a global brand dislike or budget. |
| C09 implicit applicability | Core test `surfaces quiet-meeting constraints independently of lexical overlap...` and PostgreSQL test `Stage 08 retrieves applicable constraints...` | A differently worded work-meeting query selects the quiet constraint; no live venue/location facts are invented. |
| C10 negative personalization | `does not add unrelated personal profile material to a factual answer` | Unrelated profile data does not enter the context pack. |
| C19 read-your-writes | PostgreSQL test `Stage 08 indexes only authorized safe text and semantically retrieves only the current assertion revision` | A corrected revision supersedes old warm/vector content; live app/session integration remains Stage 09. |
| C24 authorization | PostgreSQL test `Stage 08 retrieves applicable constraints and source-only evidence without crossing tenant scopes` plus exact-vector scope filters | Similar/private scopes are filtered before hydration; no other-scope detail is returned. This is local database proof, not production identity proof. |
| C27 extraction miss | Core `reports bounded empty search as not found in this search...`; PostgreSQL source-only fallback in `Stage 08 retrieves applicable constraints...` | Permitted original user source spans can recover an unindexed detail; an empty bounded lookup does not claim absolute absence. |
| C28 scoped multilingual preference | `preserves a project-local formal exception without promoting it over the general casual default` | English/Roman Urdu terms and condition scope preserve both local exception and general default. |
| C35 volatile artifact history | `marks volatile remembered prices as historical and requires current-source verification` | Stored value is labeled historical; the current-source tool action itself is not wired in this stage. |
| C36 explicit task override | `uses current explicit task instructions over an old preference without rewriting the default` | Current task-level request wins only for that task; old default remains. |

Meaningful negative/failure evidence also covers caller-supplied authority rejection, unresolved IDs, cross-tenant candidates, wrong model/version/dimension/hash/revision/source-kind embeddings, non-positive similarity, secret-bearing source/query suppression, missing/denied remote provider, expired constraints, cancellation and hard expansion caps, conflict bundles that cannot be split to fit, and bounded token exhaustion. Deletion tests verify the FK-cascaded derivative rows are purged with their source assertion/event.

### Synthetic ablation result

The checked-in 12-fixture report records lexical relevant/context recall `0.50` (12/24), deterministic hybrid recall `1.00` (24/24), and applicability recall `1.00` (24/24) with all 12/12 applicable hard constraints selected. Median packed context is 529/671/938 UTF-8 bytes and the latest measured local fixture times are 0.1883/0.1519/0.2544 ms for lexical/hybrid/applicability respectively. It records zero provider/network calls and 60 expected filtered candidates. These are hand-authored deterministic fixtures, not statistical confidence intervals, provider-quality evidence, production latency, or semantic benchmark results.

## Operational behavior

- The pure retrieval core has no external startup requirement. The PostgreSQL adapter uses the existing server-only `GIDEON_MEMORY_DATABASE_URL` and configured bounded pool; no credential is exposed to client/Worker `vars`.
- No embedding provider is selected at startup. Without an authorized injected provider, semantic coverage is `not_configured`; lexical, exact, warm and permitted evidence branches can still run and coverage identifies the missing branch.
- Deadline/cancellation are request-scoped. Deep recall enforces at most 32 relationship edges and 64 evidence fetches, with bounded candidate/vector/source sets. A timeout/cancel is a partial/unavailable result, not an empty canonical state.
- No background embedding worker or route was enabled. Callers must supply a properly authorized server session, pass only authenticated recent turns/resolutions/overrides, and revalidate current tool permissions at dispatch.
- Migration 005 was applied only by the owned local disposable PostgreSQL harness. No staging/production database was contacted or migrated. The migration is additive; do not drop the shared `gideon_memory` schema as rollback. Reset only an explicitly owned disposable test schema.
- Deletion and revocation remain Stage 05 authority. FK cascades remove revision/event-bound embeddings; source suppression and epoch checks prevent stale derivatives from being rehydrated.
- Disable/revert: because no application route calls these exports, reverting implementation commit `de46c69` restores the prior application behavior. Keep prerequisite Stage 03–07 tables and Stage 05 deletion controls; never remove a shared schema to roll back this isolated adapter.

## Remaining gaps

- No real embedding provider/model is configured or called. Deterministic vectors prove filtering/control flow only; semantic quality remains unverified.
- No staging/production migration, deployed application/Worker, route integration, live voice, customer data, remote provider, user-facing clarification flow, or real-user deletion drill was performed.
- The current C02 planner prevents guessing but does not itself ask the user to choose between two candidate projects.
- C35 labels remembered prices historical but does not call a current-source tool. Stage 09 owns ordinary application/voice integration and tool-policy coordination.
- No ANN/indexing-scale benchmark, production load test, cost measurement, or real provider tokenizer configuration was performed. UTF-8-byte counting is a conservative fallback, not exact tokenizer proof.

## Next stage contract

- Edge-safe callers can import `createRetrievalRequest`, `retrievalRequestMatchesSession`, `buildRetrievalQueryPlan`, `fuseRetrievalBranches`, `rankLexicalDocuments`, `selectApplicableConstraints`, `exactVectorSearch`, `composeContextPack` and `runBoundedDeepRecall` from `src/lib/memory/index.ts` (or `src/lib/memory/retrieval.ts`). Authority-bearing fields in the resulting request are server-derived.
- Server callers can import `retrieveMemory`, `indexAuthorizedEmbeddings` and `RetrievalEmbeddingProvider` from `backend/memory/src/index.ts` (or `backend/memory/src/retrieval.ts`). Both operations require an already authenticated/authorized `MemorySession` and the existing PostgreSQL store. Do not accept client-owned scope/principal/grant values.
- The pack is contextual evidence, not policy or tool authorization. Stage 09 must integrate it into HTTP/realtime turns without trusting its text as instructions; ask for clarification when exact references remain ambiguous, pass only committed relevant recent turns, apply accepted correction overlays/authoritative reads, and independently revalidate action permissions.
- Migration 005 remains local/test-only until a separately authorized migration stage establishes rollout and rollback gates.
- Next prompt: `docs/memory/implementation/09-chatgideon-and-voice-integration.md`. Do not begin Stage 09 as part of this handoff.
