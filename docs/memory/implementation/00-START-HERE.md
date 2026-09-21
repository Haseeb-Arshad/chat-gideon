# ChatGideon memory: implementation prompt pack

This pack converts the [foundation](../FOUNDATION-2026-09-21.md) into executable work instructions for an implementation agent. It contains **18 numbered stage prompts**, common rules, a progress ledger, and a handoff template. The stages are not implemented merely because these documents exist.

## How to use

1. Give the agent repository access and this entire `docs/memory` folder. Do not supply a stage in isolation without its referenced files.
2. Start with stage 01. Paste the launch prompt below and substitute the numbered filename.
3. The agent reads common instructions, the selected stage, the foundation, and completed prerequisite handoffs.
4. It implements that stage, runs meaningful checks, updates the ledger and writes a handoff. It stops at that stage's boundary.
5. Give the next stage to the same or another agent after its prerequisites pass. An incomplete prerequisite is repaired or explicitly reported; it is never silently assumed.
6. Stages 17 and 18 are optional advanced tracks. Stage 11 can finish as an evaluated rejection/defer decision if Jev access or benefits are absent; no fake provider success is acceptable.

### Copy-and-paste launch prompt

> Implement the stage in `docs/memory/implementation/01-baseline-and-receipts.md`. First read `docs/memory/implementation/00-COMMON-INSTRUCTIONS.md`, the foundation, the progress ledger, and prerequisite handoffs. Inspect the current repository and preserve unrelated work. Complete the actual implementation and verification described in the stage; do not stop at a plan. Resolve routine implementation choices using the specified architecture. Do not implement later stages. Update the progress ledger, write the required handoff, and report verified results and concrete blockers separately. Do not deploy or migrate production unless my instruction explicitly includes that environment and action.

For later stages change only the selected filename. If additional execution or deployment authorization is supplied in the same conversation, use it; do not ask for the same permission again.

## Sequence

| Stage | Prompt | Primary outcome |
|---|---|---|
| 01 | [Baseline and receipts](01-baseline-and-receipts.md) | Truthful legacy persistence and runnable baseline |
| 02 | [Contracts and identity](02-contracts-and-identity.md) | Shared types, validators and scope-bound session |
| 03 | [PostgreSQL and jobs](03-postgres-and-jobs.md) | Real transactional backend and fenced worker |
| 04 | [Commands and temporal versions](04-commands-and-temporal-versions.md) | Explicit remember/correct and honest receipts |
| 05 | [Deletion and revocation](05-deletion-and-revocation.md) | Suppression, dependency invalidation and purge |
| 06 | [Conversation state](06-conversation-state.md) | Topics, references, decisions and open loops |
| 07 | [Profiles and snapshots](07-profiles-and-snapshots.md) | Provenanced warm context and fresh overlays |
| 08 | [Retrieval and composition](08-retrieval-and-composition.md) | Hybrid/evidence recall and applicable constraints |
| 09 | [ChatGideon and voice integration](09-chatgideon-and-voice-integration.md) | HTTP/socket integration and delivery-aware continuity |
| 10 | [Background learning](10-background-learning.md) | Conservative extraction and bounded maintenance |
| 11 | [Jev experiment](11-jev-experiment.md) | Measured adoption, rejection or explicit deferral |
| 12 | [Memory controls](12-memory-controls.md) | Inspector, correction, forgetting and export UX |
| 13 | [Comparative evaluation](13-comparative-evaluation.md) | Held-out quality, cost and latency evidence |
| 14 | [Operational hardening](14-operational-hardening.md) | Load, crash, restore and security conformance |
| 15 | [Migration and rollout](15-migration-and-rollout.md) | Rehearsed single-writer cutover and rollout evidence |
| 16 | [Independent framework](16-independent-framework.md) | Portable packages, SQLite, MCP and second integration |
| 17 | [Procedural learning](17-procedural-learning.md) | Optional verified, compatible procedures |
| 18 | [Multimodal memory](18-multimodal-memory.md) | Optional consented assets and derived evidence |

Use the numbered order as the default. Stages 17 and 18 independently require 16; neither requires the other. Stage 13 can execute without Jev if stage 11 records a reasoned disabled decision. Stage 16 requires a passed local migration rehearsal and stable contracts, not an unrequested public production launch.

## Supplied and generated artifacts

Supplied: foundation, 36 seed acceptance scenarios, this pack. The seed cases are specifications, not already runnable tests or a hidden benchmark.

The implementing agent creates:
- `implementation-map.md`: actual source locations, scripts, flags, API route mapping and architecture decisions.
- `handoffs/NN-short-name.md`: completed-stage evidence and next-stage contract.
- Evaluation and conformance reports under a location recorded in the implementation map.
- The runtime, tests and migrations required by each stage.

Suggested implementation locations are starting points, not claims that directories exist: `src/lib/memory-runtime/` for edge-safe core; `backend/memory/` for Node API/worker, PostgreSQL migrations and integration tests; existing `src/server/` and `backend/worker/src/` for application adapters. Confirm repository constraints in stage 01; record one consistent mapping instead of each agent inventing a new layout.

## Completion labels

Use `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `LOCAL_VERIFIED`, `STAGING_VERIFIED`, `PRODUCTION_VERIFIED`, or `DEFERRED`. Record capability-level limitations. Do not label the whole system production-ready because unit tests passed. A feature flag being off is not verification of its enabled behavior.

## Acceptance ownership

See [the coverage map](00-ACCEPTANCE-COVERAGE.md) for which stages implement and verify each of the 36 seed cases.
