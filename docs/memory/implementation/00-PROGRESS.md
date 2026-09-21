# Memory implementation progress

This ledger starts with no implementation stage claimed complete. The foundation and prompt pack are design artifacts. The implementing agent updates only the selected stage with verifiable evidence.

| Stage | Status | Local evidence | Staging / production evidence | Handoff |
|---|---|---|---|---|
| 01 Baseline, repository map, and truthful legacy receipts | LOCAL_VERIFIED | `docs/memory/reports/stage-01-baseline.json`; focused memory/tool/agent tests; offline suite and local builds passed | Not run; no deployment or production migration authorized | `docs/memory/handoffs/01-baseline-and-receipts.md` |
| 02 Shared contracts, runtime validation, and authenticated memory sessions | LOCAL_VERIFIED | `src/lib/memory/contracts.test.ts`; edge-entry, server-session, memory-tool, Worker/identity regressions; TypeScript and Cloudflare build passed | Not run; no deployment, database migration, or production verification authorized | `docs/memory/handoffs/02-contracts-and-identity.md` |
| 03 Transactional PostgreSQL authority, outbox, and fenced worker | NOT_STARTED | Not run | Not run | Not created |
| 04 Explicit commands, correction semantics, and temporal history | NOT_STARTED | Not run | Not run | Not created |
| 05 Privacy deletion, grant revocation, and resurrection prevention | NOT_STARTED | Not run | Not run | Not created |
| 06 Conversation state, reference resolution, and episode continuity | NOT_STARTED | Not run | Not run | Not created |
| 07 Profiles, warm snapshots, and immediate correction overlays | NOT_STARTED | Not run | Not run | Not created |
| 08 Hybrid recall, evidence fallback, applicable constraints, and context packs | NOT_STARTED | Not run | Not run | Not created |
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

None assessed by an implementation agent yet. Missing provider/database access discovered during implementation must be recorded with the exact affected gate.

## Resume instructions

Read the latest actual handoff, verify current repository state, and run relevant prerequisite checks. The ledger is a navigation aid; test/deployment evidence establishes completion. Never overwrite later verified state with an older handoff.
