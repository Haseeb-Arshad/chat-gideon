# ChatGideon conversational memory implementation map

Stages 01–02 establish this map. It is a repository map and boundary record, not a claim that later memory stages already exist.

## Baseline snapshot

- Stage entry commit: `db4f6b4a4c8b958d2210fdd4659183a38ecee791` (`feat: complete broad research visualizations`).
- Branch: `fix/reliability-and-memory-isolation`, tracking `origin/fix/reliability-and-memory-isolation`.
- `master` and `origin/master` were fast-forwarded to the same commit before Stage 01 began.
- The pre-stage worktree was clean. Earlier unrelated visualization and `agent-core` edits were preserved, tested, committed, pushed, merged into `master`, and were not reset or overwritten.
- Pre-stage focused memory/Worker suite: 4 files, 48 tests passed.
- Pre-stage release evidence: 77 offline test files / 896 tests passed, TypeScript passed, and application plus realtime builds passed. These checks covered the pre-existing visualization release, not the Stage 01 changes.

## Runtime and ownership boundaries

### Shared core and legacy memory

- `src/lib/tools/memory.ts` contains the current `Memory`, lexical tokenisation/ranking, formatting-equivalent merge, exact destructive matching, serialised store contract, `JsonMemoryStore`, and `EphemeralMemoryStore`.
- Pure memory transformations are usable by the Worker; Node filesystem access remains inside the existing `JsonMemoryStore` adapter and is not expanded by this stage.
- `src/lib/tools/registry.ts` is the server-tool boundary for `remember`, `recall`, and `forget`. A success receipt is emitted only after `MemoryStore.mutate` returns successfully. Capacity, validation, and storage errors return `ok: false` outcomes with action-ledger summaries.
- `src/lib/agent-core.ts` copies `ToolOutcome.ok` and `ToolOutcome.summary` into the action frame. `src/lib/agent-core.test.ts` proves the capacity rejection appears as a failed action entry.

### Node HTTP and WebSocket

- `src/server/identity.ts` accepts only a valid, server-signed `gideon-owner` cookie for a durable `node/<owner>` key. Without that proof, `nodeMemoryStore()` returns an ephemeral store.
- `src/lib/openrouter.server.ts` selects the Node HTTP memory store from request headers and passes it into `streamTurn`.
- `src/server/realtime-host.ts` applies the same signed-cookie selection to `/api/realtime` WebSocket sessions. A browser-provided session identifier is not treated as ownership proof.
- `src/server/memory-authority.ts` serialises and versions the Node store; this remains the existing local authority. Stage 01 does not replace it.

### Cloudflare Worker HTTP and WebSocket

- `backend/worker/src/accounts.ts` resolves a Better Auth session and derives `user/<authenticated-user-id>`. The Worker overwrites the internal owner header; client-supplied owner values are not authoritative.
- `backend/worker/src/api.ts` calls `ownerOf()` and `memoryStoreForHttp()`. Verified owners use the session RPC; unverified callers receive an ephemeral per-response store.
- `backend/worker/src/realtime.ts` accepts only an internally injected `user/` or `ephemeral/` owner whose Durable Object name matches the current object. Account memory uses the existing `VersionedMemoryAuthority` over Durable Object storage or the existing Supabase adapter.
- No HTTP or WebSocket route was rewired in Stage 01. The only application behavior change is truthful legacy memory receipts.

## Chosen source layout

| Concern | Stage 01 location | Boundary |
|---|---|---|
| Edge-safe memory algorithms and baseline adapters | `src/lib/tools/memory.ts`, `src/lib/memory-baseline.ts` | No new Node, database-driver, secret, or provider imports in the baseline adapter |
| Existing Node/local authority | `src/server/identity.ts`, `src/server/memory-authority.ts`, `JsonMemoryStore` | Signed-cookie owner selection and local JSON persistence |
| Existing Worker adapter | `backend/worker/src/memory.ts`, `backend/worker/src/accounts.ts`, `backend/worker/src/realtime.ts` | Authenticated owner / Durable Object boundary; no new migration in this stage |
| Future PostgreSQL adapter and migrations | `backend/memory/` (reserved; not created in Stage 01) | Stage 03 only, after contracts and identity are stable |
| Baseline runner | `src/lib/memory-baseline-runner.ts`, `scripts/memory-baseline.test.ts`, `npm run memory:baseline` | Loads the supplied seed schema and runs local synthetic fixtures |
| Baseline and conformance reports | `docs/memory/reports/` | Metadata and measurements only; no raw user text |
| Stage handoffs | `docs/memory/handoffs/` | One evidence handoff per completed stage |
| Progress and map | `docs/memory/implementation/00-PROGRESS.md`, this file | Navigation and explicit evidence boundary |

This layout is intentionally compatible with the prompt pack's later split: an edge-safe core can be extracted without moving the existing HTTP/Worker adapters, and PostgreSQL remains behind a server adapter rather than entering the client-facing core.

## Feature-flag names reserved for later stages

These names are documented now but not wired as working capabilities. New production-facing behavior remains off until its own stage and verification gate.

| Capability | Reserved environment flag | Stage 01 state |
|---|---|---|
| Capture committed conversation evidence | `GIDEON_MEMORY_CAPTURE_ENABLED` | Not wired |
| Canonical command writes | `GIDEON_MEMORY_COMMAND_WRITES_ENABLED` | Not wired; legacy tools remain the current path |
| Memory recall/context injection | `GIDEON_MEMORY_RECALL_ENABLED` | Not wired; current legacy recall remains unchanged except for failed receipts |
| Automatic/background learning | `GIDEON_MEMORY_LEARNING_ENABLED` | Not wired |
| Semantic/vector search | `GIDEON_MEMORY_SEMANTIC_SEARCH_ENABLED` | Not wired |
| Jev classification | `GIDEON_MEMORY_JEV_ENABLED` | Not wired |

No flag is evidence that its enabled behavior exists. Server-side scope and rollout ownership will be defined by the stages that implement each capability.

## Stage 03 PostgreSQL authority and worker boundary

- `backend/memory/src/index.ts` is the Node-only entry point. It exports the
  PostgreSQL store, capture seam, migration runner, health/readiness checks, and
  fenced job worker. It is not imported by the Worker or browser graph.
- `backend/memory/src/postgres.ts` implements `MemoryStorageCapabilities` with
  transaction-scoped reads, exact versions, source/dependency edges, scalar
  slot locks, suppression checks, durable capture receipts, and outbox jobs.
  `captureEvent()` requires an authenticated server session, a database grant,
  a matching policy epoch, and a memory consent reference.
- `backend/memory/src/jobs.ts` claims bounded pending/retry/expired-running jobs
  with `FOR UPDATE SKIP LOCKED`, leases, attempts and monotonically increasing
  fences. Provider/model handlers run outside database transactions;
  completion reacquires the transaction and checks the current lease,
  policy/deletion epochs, source suppression and scope before committing.
- `backend/memory/migrations/001-memory-authority.sql` owns the canonical
  principals, scopes, grants, epochs, events, receipts, assertion versions,
  evidence/dependencies, projections, jobs, scalar locks and deletion
  suppression tables. `002-memory-indexes.sql` adds scoped lookup, scalar-slot,
  job-claim and suppression indexes. Composite foreign keys preserve scope
  consistency for events, assertions, evidence, projections and suppressions.
- `scripts/memory-postgres-harness.mjs` creates and removes a disposable local
  PostgreSQL cluster for the real integration gate. `memory:postgres:status`
  is read-only; `memory:postgres:migrate` requires `GIDEON_MEMORY_MIGRATE=1`
  and refuses remote URLs unless explicitly overridden. See
  `backend/memory/README.md` for local setup and safety boundaries.
- `backend/memory/src/postgres.live.test.ts` is the real PostgreSQL conformance
  suite. It covers atomic event/job capture and rollback, same-key content
  conflicts, cross-worker claims, scalar first-insert contention, retries,
  scoped reads, stale-fence rejection, accepted receipts and unavailable
  database health.

Stage 03 remains isolated from the existing legacy JSON, Supabase, D1 and
Durable Object authorities. No production-facing feature flag is enabled and
no Cloudflare Worker bundle imports the `pg` driver. A future Cloudflare
deployment must use the platform's supported database connection boundary; this
local Node adapter is not a Worker database client.

## Stage 01 receipt contract

`remember()` now returns `stored`, `merged`, or `rejected` with rejection reasons `empty`, `too_long`, and `capacity`. The new record is considered stored only when it is present in the returned corpus. If the full 400-record hot cache would evict the new zero-use record, the input corpus is preserved and the tool returns `ok: false`; it does not promise unlimited durable retention. Text longer than 240 characters is rejected without semantic truncation. A rejecting `MemoryStore.save()` also returns `ok: false`, and its failure summary reaches the action ledger.

Formatting-equivalent duplicate merging and exact destructive matching remain unchanged. PostgreSQL, automatic extraction, vector search, Jev, deployment, and production migration are outside this stage.

## Stage 02 contract and identity boundary

- `src/lib/memory/index.ts` is the edge-safe Worker entry point. It exports only
  `src/lib/memory/contracts.ts`; the import-graph test proves that the entry
  point cannot reach Node, filesystem, database-driver, provider, or secret
  modules.
- `src/lib/memory/contracts.ts` defines schema version 1, bounded runtime
  validators, event/source-span and assertion variants, registered slot
  cardinality, temporal semantics, typed failures, receipt states, storage
  capability interfaces, public commands, bound commands, and deterministic
  source/grant policy.
- `src/server/memory-session.ts` is the only shared server binder. It derives
  account scope, subject, grants, and authority from a server-selected owner;
  callers cannot provide those fields. `src/server/node-memory-session.ts`
  resolves the signed Node cookie without entering the Worker graph.
- `src/lib/tools/registry.ts`, `src/lib/agent-core.ts`, and
  `src/lib/realtime-session.ts` accept the prebound session for model-visible
  memory tools. The existing direct `MemoryStore` field remains only as an
  explicit compatibility path for current unit tests and Stage 01 baseline
  adapters.
- `backend/worker/src/api.ts` and `backend/worker/src/realtime.ts` bind the
  verified Worker owner before invoking the shared core. `src/server/realtime-host.ts`
  and `src/lib/openrouter.server.ts` use the Node resolver for HTTP and socket
  parity.
- `src/lib/memory/test-adapter.ts` is test-only and is not exported by the edge
  entry point. It does not substitute for the PostgreSQL authority required by
  Stage 03.

The contract documentation and version/upgrade policy live in
`docs/memory/contracts-and-identity.md`. No new account system, database table,
migration, provider, grant broadening, or deployment was added.

## Verification paths

- `src/lib/tools/memory.test.ts`: pure admission, exact-cap insertion, full-capacity rejection, duplicate merge, exact matching, and non-truncating validation.
- `src/lib/tools/memory-tools.test.ts`: tool receipts, C26 capacity membership, and rejecting storage adapter behavior.
- `src/lib/agent-core.test.ts`: failed capacity receipt in the user-visible action ledger.
- `src/lib/memory-baseline.test.ts`: current-memory and supplied-summary baseline adapters with no usage mutation.
- `scripts/memory-baseline.test.ts`: schema loading, all 36 case records, C26 execution, C33 `NOT_IMPLEMENTED`, corpus-size measurements, and local JSON persistence measurement.
- `docs/memory/reports/stage-01-baseline.json`: generated local evidence artifact. Its latency measurements are local selection or local JSON persistence only, not end-to-end voice latency.
- `backend/memory/src/postgres.live.test.ts`: Stage 03 real PostgreSQL acceptance suite; it is excluded from the ordinary offline suite and run through `npm run memory:postgres:test`.
- `backend/memory/README.md`: local disposable PostgreSQL, migration, credential and rollback instructions.
