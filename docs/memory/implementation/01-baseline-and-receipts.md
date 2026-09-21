# Stage 01: Baseline, repository map, and truthful legacy receipts

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Establish a reproducible starting point and fix the existing admission/receipt defect without replacing memory architecture yet.

## Prerequisites and entry gate

- Repository access and the supplied foundation/acceptance scenarios. No prior memory-runtime stage is assumed.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Inspect src/lib/tools/memory.ts, src/lib/tools/registry.ts, their tests, src/server/memory-authority.ts, backend/worker/src/memory.ts, accounts.ts, package scripts, and existing speculative/transport tests.

## Implementation steps

1. Record HEAD, dirty paths, relevant test status and actual runtime boundaries in implementation-map.md. Confirm the authenticated owner path for HTTP and WebSocket; do not infer that a browser session identifier proves ownership.

2. Choose and document one source layout for edge-safe core, Node/PostgreSQL adapter, migrations, evaluation runner and reports. Preserve existing build conventions; later stages must use this mapping.

3. Reproduce the exact full-cache case: 400 distinct existing facts each with uses > 0, then insert one new fact with uses = 0. Assert returned result and membership separately.

4. Implement truthful admission behavior using an explicit failure/rejection result when the newly inserted fact does not survive. Update every caller and action-ledger message to handle it. Do not claim the hot-list fix creates unlimited durable retention.

5. Add failure tests for storage.save rejection, duplicate merging, exact-cap insertion, and quotas where a quota exists. Preserve formatting-equivalence merge and exact destructive matching.

6. Create a fixture runner that loads the supplied case schema and records case ID, backend, capability, outcome, latency boundary and evidence. Unsupported cases must be NOT_IMPLEMENTED, not silently passing or removed from the denominator.

7. Build a deterministic current-memory baseline adapter. Add a simple profile/session-summary retrieval baseline interface; use controlled synthetic summaries for offline plumbing and label them supplied-summary fixtures until a real summarizer is configured.

8. Instrument selection CPU time, persistence time and context length without logging raw user text. Include empty, small and cap-sized corpora; report observed sample counts and machine/runtime.

9. Record baseline results and existing failures. Establish flag names for new capture, writes, recall, learning, semantic search and Jev, without wiring unavailable features as working.

10. Leave application routing and existing production persistence authority unchanged except for truthful legacy receipts. Write the first handoff with actual scripts and next-stage paths.

## Verification and acceptance scenarios

Relevant seed IDs: **C26, C33** from [acceptance scenarios](../acceptance-scenarios.json).

Run memory unit/tool tests and relevant Worker memory tests. Verify a failing storage adapter cannot yield an ok stored result. Exercise C26/C33 with explicit expected receipt states. Report benchmark boundary as local selection, not end-to-end voice.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

implementation-map.md; working legacy receipt fix and regression tests; fixture runner and capability report; baseline measurements; stage handoff.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/01-baseline-and-receipts.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

A successful legacy storage receipt corresponds to actual saved membership; runner reports missing capabilities honestly; unrelated dirty changes are preserved.

## Scope boundary

Do not introduce PostgreSQL tables, automatic extraction, vector search, deploys or repository-wide refactors.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 02](02-contracts-and-identity.md) as the next prompt.
