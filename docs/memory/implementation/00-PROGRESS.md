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
| 09 Integrate memory into HTTP, realtime voice, cards, and the action ledger | NOT_STARTED | Not run | Not run | Not created |
| 10 Conservative extraction, conditional preferences, and bounded maintenance | NOT_STARTED | Not run | Not run | Not created |
| 11 Jev classification adapter and adoption decision | NOT_STARTED | Not run | Not run | Not created |
| 12 Inspector, user controls, corrections, forgetting, and export | NOT_STARTED | Not run | Not run | Not created |
| 13 Held-out conversational evaluation and competitive comparison | NOT_STARTED | Not run | Not run | Not created |
| 14 Concurrency, security boundaries, load, recovery, and operational budgets | NOT_STARTED | Not run | Not run | Not created |
| 15 Single-writer migration, rollout, and rollback | NOT_STARTED | Not run | Not run | Not created |
| 16 Portable framework, SQLite, SDK, MCP, and second integration | NOT_STARTED | Not run | Not run | Not created |
| 17 Optional verified procedural memory | NOT_STARTED | Not run | Not run | Not created |
| 18 Optional multimodal memory with modality-specific consent | NOT_STARTED | Not run | Not run | Not created |

Allowed status labels: NOT_STARTED, IN_PROGRESS, BLOCKED, LOCAL_VERIFIED, STAGING_VERIFIED, PRODUCTION_VERIFIED, DEFERRED. Use notes for partially complete capabilities. Optional Jev/provider work may be DEFERRED without being called verified. Stages 17–18 are optional.

## Current blockers

No Stage 03–08 local blocker remains. Stage 08 has no production embedding
provider configured; deterministic vectors only verify control flow. Staging /
production database migration, application cutover, remote-provider execution,
and live voice proof remain intentionally out of scope and are not implied by
LOCAL_VERIFIED.

## Resume instructions

Read the latest actual handoff, verify current repository state, and run relevant prerequisite checks. The ledger is a navigation aid; test/deployment evidence establishes completion. Never overwrite later verified state with an older handoff.
