# Memory implementation progress

This ledger starts with no implementation stage claimed complete. The foundation and prompt pack are design artifacts. The implementing agent updates only the selected stage with verifiable evidence.

| Stage | Status | Local evidence | Staging / production evidence | Handoff |
|---|---|---|---|---|
| 01 Baseline, repository map, and truthful legacy receipts | LOCAL_VERIFIED | `docs/memory/reports/stage-01-baseline.json`; focused memory/tool/agent tests; offline suite and local builds passed | Not run; no deployment or production migration authorized | `docs/memory/handoffs/01-baseline-and-receipts.md` |
| 02 Shared contracts, runtime validation, and authenticated memory sessions | LOCAL_VERIFIED | `src/lib/memory/contracts.test.ts`; edge-entry, server-session, memory-tool, Worker/identity regressions; TypeScript and Cloudflare build passed | Not run; no deployment, database migration, or production verification authorized | `docs/memory/handoffs/02-contracts-and-identity.md` |
| 03 Transactional PostgreSQL authority, outbox, and fenced worker | LOCAL_VERIFIED | `npm run memory:postgres:test` passed 1 file / 4 real PostgreSQL tests; `npx tsc --noEmit`; `git diff --check` | Not run; existing app integration, deployment, and production migration intentionally disabled | `docs/memory/handoffs/03-postgres-and-jobs.md` |
| 04 Explicit commands, correction semantics, and temporal history | LOCAL_VERIFIED | `npm run memory:postgres:test` passed 1 file / 9 real PostgreSQL tests; `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers=2` passed 82 files / 927 tests; `npx tsc --noEmit`; `git diff --check` | Not run; Node/PostgreSQL authority remains isolated, with no app integration, deployment, remote migration or production data change | `docs/memory/handoffs/04-commands-and-temporal-versions.md` |
| 05 Privacy deletion, grant revocation, and resurrection prevention | LOCAL_VERIFIED | `npm run memory:postgres:test` passed 1 file / 14 real PostgreSQL tests covering C22/C23/C24/C25/C29 and revocation; offline suite passed 82 files / 927 tests; contract tests 16/16; `npx tsc --noEmit`; Cloudflare and application/realtime builds; `git diff --check` | Not run; Node/PostgreSQL authority remains isolated, with no app/Worker integration, deployment, remote migration or real-user deletion drill | `docs/memory/handoffs/05-deletion-and-revocation.md` |
| 06 Conversation state, reference resolution, and episode continuity | LOCAL_VERIFIED | `src/lib/conversation-state.test.ts` + contract tests 25/25; `npm run memory:postgres:test` 1 file / 15 tests; offline suite 83 files / 936 tests; TypeScript; Cloudflare/application/realtime builds; diff check | Not run; no deployment, remote migration, provider, live voice, or real-user deletion drill | `docs/memory/handoffs/06-conversation-state.md` |
| 07 Profiles, warm snapshots, and immediate correction overlays | LOCAL_VERIFIED | Projection tests 11/11; focused regression 3 files / 36 tests; disposable PostgreSQL suite 1 file / 16 tests; offline suite 84 files / 947 tests; TypeScript; Cloudflare/application/realtime builds; bounded composition and refresh measurements; diff check | Not run; projection authority remains isolated, with no deployment, remote migration, provider, live voice or real-user proof | `docs/memory/handoffs/07-profiles-and-snapshots.md` |
| 08 Hybrid recall, evidence fallback, applicable constraints, and context packs | LOCAL_VERIFIED | Core retrieval 19/19; paired ablation 1/1; disposable PostgreSQL 19/19; offline suite 86 files / 967 tests; TypeScript; Cloudflare, application/realtime builds; `git diff --check` | Not run; migration 005/provider/route remains local-only | `docs/memory/handoffs/08-retrieval-and-composition.md` |
| 09 Integrate memory into HTTP, realtime voice, cards, and the action ledger | LOCAL_VERIFIED | Offline suite 92 files / 985 tests; Stage 09 focused transport/runtime tests 6 files / 37 tests; disposable PostgreSQL authority suite 19/19 on clean rerun; TypeScript, application/realtime build, Cloudflare build, and `git diff --check` passed | Not run; no deployment, production cutover, remote migration, provider, or real voice/browser proof authorized | `docs/memory/handoffs/09-chatgideon-and-voice-integration.md` |
| 10 Conservative extraction, conditional preferences, and bounded maintenance | LOCAL_VERIFIED | Offline suite 94 files / 992 tests + rerun 13 files / 116 tests (2 UI files that failed to start); disposable PostgreSQL 27/27 (8 Stage 10); extraction eval precision 1 / recall 0.885, 0 false memories, 0 provider calls; TypeScript; Cloudflare build with Worker bundle check; application/realtime build; nine Stage 01–09 audit repairs with regression tests | Not run; no deployment, remote migration, provider call, live voice or real-user data. Model extractor implemented but unevaluated (no authorized spend) | `docs/memory/handoffs/10-background-learning.md` |
| 11 Jev classification adapter and adoption decision | LOCAL_VERIFIED (decision: Jev DEFERRED, classifier off by default) | Classification tests 35/35; adapter fixture-HTTP tests 11/11; disposable PostgreSQL 30/30 (3 Stage 11 incl. C30); offline suite 99 files / 1042 tests; TypeScript; Cloudflare build with Worker bundle check; matched comparison on dev (231 calls) and frozen-threshold held-out (178 calls) with `openai/gpt-6-luna` only, $0.0365 total spend | Jev live BLOCKED: no `TYPESAFE_API_KEY`. No deployment, remote migration or real-user data | `docs/memory/handoffs/11-jev-experiment.md`, ADR `docs/memory/decisions/0001-jev-classification.md` |
| 12 Inspector, user controls, corrections, forgetting, and export | LOCAL_VERIFIED | Controls/UI/brand tests 10/10; disposable PostgreSQL 35/35 (5 Stage 12 incl. C04/C05/C06/C19/C22/C24/C31); offline suite 102 files / 1052 tests; TypeScript; Cloudflare build with Worker bundle check; application/realtime build; in-browser verification on a disposable database; two real turns with `openai/gpt-6-luna` ($0.00075) confirming temporary mode and the next-turn effect of an edit and a forget | Not run; no deployment, remote migration or real-user data. Worker host has only a stub | `docs/memory/handoffs/12-memory-controls.md` |
| 13 Held-out conversational evaluation and competitive comparison | LOCAL_VERIFIED (held-out pilot; external comparisons BLOCKED) | Seed conformance C01–C36 on disposable PostgreSQL (38 tests; live suites 76/76); scoring library 6/6; offline suite 103 files / 1061 tests; TypeScript; preregistered held-out pilot (24 trajectories, 33 queries, 5 arms, ablations) with `openai/gpt-6-luna` only, run twice, second run replayable from cache; $0.0378 total spend. Dev split found three product defects, fixed with regression tests | LongMemEval/PersonaMem/LoCoMo-Plus and competitor providers BLOCKED (no authorized download or account); Jev BLOCKED (no key); human review pending. No deployment or real-user data | `docs/memory/handoffs/13-comparative-evaluation.md`, `docs/memory/reports/stage-13-*` |
| 14 Concurrency, security boundaries, load, recovery, and operational budgets | LOCAL_VERIFIED (rollout blocked: p99 on production hardware, warm-path decision, restore physical purge, ledger shipping automation) | Stage 14 conformance on disposable PostgreSQL 8/8 (multi-process contention, killed connections, bad extractors, fairness/backpressure, metrics, canary isolation sweep, deletion race, real pg_dump/pg_restore drill); live suites 76/76; offline suite 1062 tests; Node and Cloudflare builds with bundle/secret check; bounded load workload with measured p50/p95/p99 (0 errors, 0 lost commands). Found and fixed: process-crashing client error, 13 s source-evidence query, dead warm snapshots for learned memories | First substantive audio and multi-host throughput not measured; no deployment or real-user data | `docs/memory/handoffs/14-operational-hardening.md`, `docs/memory/reports/stage-14-slo.md`, `docs/memory/operations/runbook.md` |
| 15 Single-writer migration, rollout, and rollback | LOCAL_VERIFIED (staging and production NOT PERFORMED: not authorized) | Cutover suite on disposable PostgreSQL 7/7; local rehearsal (12 synthetic owners, 307 memories, shadow import in a separate database, manifest-driven cohort cutover, rollback drill) with every stop condition at zero; live suites 76/76 and 8/8; offline suite 1062 tests; Node and Cloudflare builds | Not performed; no deployment, hostname, account or socket evidence outside local tests | `docs/memory/handoffs/15-migration-and-rollout.md`, `docs/memory/reports/stage-15-rehearsal.json`, runbook section "Moving owners from the legacy JSON files" |
| 16 Portable framework, SQLite, SDK, MCP, and second integration | NOT_STARTED | Not run | Not run | Not created |
| 17 Optional verified procedural memory | NOT_STARTED | Not run | Not run | Not created |
| 18 Optional multimodal memory with modality-specific consent | NOT_STARTED | Not run | Not run | Not created |

Allowed status labels: NOT_STARTED, IN_PROGRESS, BLOCKED, LOCAL_VERIFIED, STAGING_VERIFIED, PRODUCTION_VERIFIED, DEFERRED. Use notes for partially complete capabilities. Optional Jev/provider work may be DEFERRED without being called verified. Stages 17–18 are optional.

## Post-audit repairs (2026-09-23)

Before Stage 10, Stages 01–09 were audited with independent probes against
real PostgreSQL. Nine defects were repaired with regression tests: deleted
tombstones kept an unkeyed text hash (05), forgotten facts could never be
re-stated (05), the Worker bundle contained `pg` (09), app recall ignored
conversation state and tools could not scope/date/transition memory (09), no
background worker ran purge/projections/jobs (05/07/09), substring topic
matching (06), silent context truncation (06), concurrent duplicate captures
returned a retryable conflict (03), and sequential capture/recall latency (09).
The earlier stages keep `LOCAL_VERIFIED`; details are in the Stage 10 handoff.

## Stage 12 repair (2026-09-24)

Browser verification found that the Node host's SSR and realtime bundles each
carry their own `PostgresMemoryStore` class while sharing one store through a
global, so `instanceof` checks failed depending on which page opened first
(Stages 04, 05, 07, 08 and 12 paths). Authority checks now use a registered
brand (`isPostgresMemoryStore`), with a regression test.

## Current blockers

No Stage 03–09 local blocker remains. Stage 08 has no production embedding
provider configured; deterministic vectors only verify control flow. Stage 09
has no production memory cutover, Worker PostgreSQL wiring, remote provider,
staging/production database migration, deployed application, or live
voice/browser proof. These remain intentionally out of scope and are not
implied by LOCAL_VERIFIED.

## Resume instructions

Read the latest actual handoff, verify current repository state, and run relevant prerequisite checks. The ledger is a navigation aid; test/deployment evidence establishes completion. Never overwrite later verified state with an older handoff.
