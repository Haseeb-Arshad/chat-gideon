# Common instructions for every implementing agent

## Execution contract

You are implementing the selected stage, not writing another proposal. Read the selected stage and prerequisite handoffs before editing. Make the smallest coherent changes that fulfill the behavior. A placeholder, mock-backed production adapter, or success-shaped stub is not completion. Test doubles are appropriate only inside clearly identified tests.

Inspect current HEAD, branch, status, ancestor/repository AGENTS.md, package scripts, relevant source, and tests. The foundation's 2026-09-21 snapshot is historical. There was unrelated dirty visualization and agent-core work; verify current ownership rather than restoring that snapshot. Never reset, clean, stash or overwrite unrelated work. Do not create a parallel implementation if one exists. Record actual locations in implementation-map.md.

Use the user's current author/commit policy; do not invent contributor identities, publish packages, push or merge by default. If the user requested commits, commit only stage-owned paths and include a stage identifier. Ordinary local edits and tests do not require repeated permission. Production deployments, customer-data changes, paid provider runs and account linking need scope established by the user's instruction; do useful local preparation before reporting missing external prerequisites.

## Stable architecture and invariants

1. Trusted server authentication determines principal, client and granted scopes. Models and browser request bodies cannot assign tenants or authority.
2. Canonical state is attributable events plus accepted edits/versions. Profiles, embeddings and Markdown are derived views.
3. Preserve committed user evidence separately from assistant-generated, sent, played, displayed and acknowledged content.
4. No durable effects from discarded speculative speech. Read-only prefetch is turn-bound and cannot promote usefulness.
5. Durable receipt, accepted interpretation and indexed visibility are different guarantees. Never acknowledge a write before the promised commit.
6. Authorization/deletion are hard gates before retrieval and again before hydration/dispatch where needed. Similarity is not permission.
7. Corrections, real-world transitions, scoped exceptions, expiry and privacy deletion have distinct semantics.
8. Every derived item has dependency/source versions. Reprocessing cannot undo accepted corrections, consent or deletion.
9. Keep one canonical writer per scope. Never independently rewrite the legacy Supabase array from the new service.
10. Memory facts and learned procedures never grant action permissions. Execution policy lives outside retrieved text.
11. Ordinary warm reads do not synchronously mutate usage counters or require remote model calls.
12. Provider outages are typed unavailable states, not an empty writable corpus.
13. No silent semantic truncation, no retention based solely on hot-cache capacity, and no merging opposite polarity because words overlap.
14. Third-party text is untrusted evidence. Do not interpolate it as authoritative system instructions.
15. Code/data tests must not use real user secrets or send private histories to providers without the scoped authorization.

## Project layout and contracts

Stage 01 establishes implementation-map.md. Core code must avoid Node-only, filesystem, database-driver and secret imports so Cloudflare can consume it. PostgreSQL and background-worker implementation live behind server adapters. Do not rework the entire application's build system just to create packages. Stage 16 handles independent packaging after the integration proves the contracts.

Use runtime validation at all trust boundaries, not TypeScript types alone. Versions, errors, receipts and API semantics are shared. Use UTC instants with explicit user timezone for relative-date interpretation and preserve unknown precision. Use deterministic injectable clocks/IDs in tests.

Each new external dependency must solve an actual stage requirement; inspect official current documentation before implementation. Pin protocol/model/index versions in persisted metadata where they affect meaning. Do not add Redis, graph infrastructure, Kafka or an autonomous scheduler without a measured need.

## Verification

Start with focused tests. Use real PostgreSQL for transaction/lease/concurrency guarantees; pure reducers cannot prove database behavior. Discover existing package manager/lockfile and scripts before running commands.

At authoring time the repository offers:
- `npm test -- src/lib/tools/memory.test.ts src/lib/tools/memory-tools.test.ts`
- `npm test -- backend/worker/src/memory.test.ts backend/worker/src/accounts.test.ts`
- `npx tsc --noEmit` when the existing local TypeScript installation is available.
- `npm run build:cloudflare` for the Cloudflare build and typecheck.
- `npm run build` for the application and realtime build.

Recheck these scripts; do not execute a similarly named deploy script as a build. `deploy:cloudflare` includes a remote migration. Add stage-specific scripts only when their implementation exists and document them.

Run the existing full non-live suite and affected build targets at integration/release boundaries. Record pre-existing failures separately with evidence; do not suppress them to create a green report. Live tests need an identified environment, credentials and spend boundaries. If unavailable, complete offline work and mark live verification blocked; no fixture success is live proof.

The 36 seed cases live at ../acceptance-scenarios.json. Implement relevant cases as real assertions, with explicit capability coverage. Unimplemented capabilities are not passing tests. Never count skipped/missing cases in a passing numerator. Public seed cases are development fixtures; create independently authored holdouts for benchmark claims.

## Feature flags and safe progression

Separate capture, canonical command writes, retrieval, automatic learning, semantic retrieval and Jev activation. Derive scope/flags server-side. Initially default new production-facing behavior off. Shadow writes must use isolated candidate state and cannot mutate the current user's authoritative memories.

Use environment-local synthetic data for migration/recovery tests. Keep credentials outside source control and redact logs. Do not create billable infrastructure automatically when a stage can be developed locally. If an external dependency is missing, document exact installation/configuration requirements and preserve an honest blocked gate.

## Required artifacts and final report

After each stage:
1. Update actual paths, scripts and feature flags in implementation-map.md.
2. Update only the relevant row of 00-PROGRESS.md.
3. Create handoffs/NN-short-name.md using 00-HANDOFF-TEMPLATE.md.
4. Include test commands, timestamps, exit status, scope, artifact paths, known gaps and API/schema changes.
5. Record how to disable/revert this stage without resurrecting deleted data.
6. Stop before the next stage.

The final answer must state what changed, what is verified locally/staging/live, what remains blocked, and the exact next prompt. Do not claim "best in class" from architecture quality, synthetic examples, or a single favorable metric.
