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

## Stage 04 explicit commands and temporal history

- `backend/memory/src/commands.ts` is the server-only explicit command service.
  It accepts only a server-bound authenticated session, validates exact
  correction targets and revisions, creates durable user-command events, and
  commits accepted assertion versions through the Stage 03 transaction writer.
  It provides deterministic formatting-equivalent duplicate handling, scoped
  temporary exceptions, source-revision checks, current/known-at/valid-at
  reads, ambiguity-safe target resolution, and an accepted-change overlay.
- `src/lib/memory/contracts.ts` extends the public command contract with
  bounded valid-time input, temporal relation, polarity, exact correction
  revision/source checks, assertion supersession metadata and a server-computed
  canonical commit key. Receipt and authority validation remains edge-safe.
- `backend/memory/migrations/003-commands-and-temporal.sql` adds canonical
  assertion identity, per-scope quota limits, monotonic change-feed
  watermarks, accepted command receipts, and change-feed records. The command
  transaction writes the event, accepted version/evidence, change notification,
  projection invalidation job and command receipt together.
- `backend/memory/src/postgres.ts` now authorizes individual database actions,
  preserves canonical keys, gates exact/current/candidate/historical reads on
  suppression records, exposes version/source reads, allocates command event
  sequences, and supports projection invalidation jobs.
- `backend/memory/src/postgres.live.test.ts` contains the real PostgreSQL
  Stage 04 cases: C04 transition/correction time reads, C05 interpretation
  correction, C06/C07 scoped expiry, C19 accepted overlay/read-your-writes,
  C20 expected-revision contention, C21 ambiguous-response idempotency, C26
  durable quota-independent admission, C33 explicit quota rejection, and
  C36 preservation of the global preference during a scoped exception.

Stage 04 is still an isolated Node/PostgreSQL authority. No HTTP, realtime,
Worker, Durable Object, legacy JSON, Supabase, provider, deployment or remote
migration was enabled. Captured-only events are not returned by the accepted
overlay; only committed accepted command changes receive a change watermark.

## Stage 05 deletion, revocation, and resurrection prevention

- `backend/memory/src/deletion.ts` is the Node-only control plane for
  short-lived exact deletion plans, logical suppression, bounded dependency
  invalidation, physical purge tasks, status receipts, grant revocation,
  private snapshot leases, pre-dispatch epoch guards, and restore-ledger
  reconciliation. Query targets must resolve to one exact assertion revision;
  an ambiguous query creates no plan and an exact authorized target does not
  require a second confirmation step.
- `backend/memory/migrations/004-deletion-revocation.sql` adds deletion plans
  and operations, bounded purge tasks, per-scope deletion/revocation control
  ledger rows, grant revocation timestamps, recovery guards, private snapshot
  leases, and an adapter-owned managed-cache table. Suppression foreign keys
  are removed only so physical purge can retain the non-content tombstone; the
  suppression rows retain identifiers/epochs, never deleted propositions or
  source text. Canonical identity tombstones retain a non-content canonical
  key so a later explicit command cannot recreate a privacy-deleted identity.
- `backend/memory/src/postgres.ts` applies restore readiness and active-grant
  gates to authorization, maps canonical-identity unique conflicts to typed
  `suppressed` failures, and retains suppression checks on exact/current,
  historical and candidate reads. `backend/memory/src/commands.ts` filters
  accepted overlays and stored command retries through the same guard.
- `backend/memory/src/jobs.ts` excludes suppressed/recovery-blocked inputs from
  new claims and rejects completion after policy/deletion epoch changes. A
  deletion cancels pending/retry input jobs and leaves a running stale worker
  unable to publish an assertion.
- `backend/memory/src/health.ts` reports restore reconciliation as unavailable
  readiness rather than as an empty memory corpus. `backend/memory/src/index.ts`
  exports the Stage 05 Node-only APIs; no Worker, Durable Object, legacy JSON,
  Supabase or browser import was added.
- `backend/memory/src/postgres.live.test.ts` covers the real PostgreSQL C22/C23
  deletion/restore race, C24 scope isolation, C25 five-second lease and
  dispatch cancellation behavior, grant revocation independence, and C29
  third-party authority-claim handling. It inspects canonical rows, source
  events, receipts, change feed, projections, managed cache, jobs, tombstones
  and purge status rather than only a response-shaped result.

Stage 05 is locally verified only. The managed-cache table is the only cache
surface this adapter can physically purge; browser caches, provider logs,
already transmitted model content and uncontrolled exported clones are not
claimed revocable. Backup retention is therefore reported as
`not_controlled` and restore requires control-ledger replay. No application or
voice route, deployment, remote migration or real-user deletion drill was run.

## Stage 06 conversation state, reference resolution, and episode continuity

- `src/lib/conversation-state.ts` is the edge-safe bounded state machine. It
  stores the active topic and bounded suspended-topic stack, committed recent
  turns, exact artifact display revisions, stable referent candidates,
  decisions and rejection reasons, local constraints, open questions,
  requests/proposals/commitments, verified tool outcomes, correction lineage,
  checkpoint coverage and expiry. Reducers accept only explicit committed
  events; speculative turns are never inserted by this module.
- `resolveArtifactReference()` requires the artifact identity and display
  revision when an ordinal is carried across a changing display. It returns a
  bounded ambiguity question or stale-snapshot result rather than guessing.
  `resolveTopic()` has the same bounded ambiguity behavior for similarly named
  topics. `conversationContext()` labels state as attributed continuity data,
  includes recent turns uncovered by a lagging checkpoint, and filters
  topic-local constraints/decisions/questions to the resumed active topic.
- `backend/memory/src/episodes.ts` is the Node-only durable checkpoint seam.
  `persistEpisodeCheckpoint()` writes a server-generated checkpoint event,
  accepted `episode_checkpoint` assertion version, evidence edges and receipt
  in one PostgreSQL transaction. `resumeEpisodeCheckpoint()` reads the latest
  visible exact checkpoint, applies deterministic expiry, and returns a typed
  resumed/not-found/expired result. Idempotency is keyed by episode and source
  watermark; the retry path reuses the original event sequence.
- `src/lib/memory/contracts.ts` now requires the bounded serialized `state`
  member on `EpisodeCheckpointPayload`. Stage 05 suppression/evidence/purge
  behavior therefore applies to checkpoints without a new table or migration;
  checkpoint evidence includes the generated checkpoint event and supplied
  source events.
- `src/lib/agent-core.ts`, `src/lib/protocol.ts`,
  `src/lib/realtime-session.ts`, `src/lib/realtime-client.ts`,
  `src/lib/openrouter.server.ts`, `src/routes/api.chat.ts`, and
  `backend/worker/src/api.ts` carry a validated bounded state snapshot through
  both realtime and HTTP fallback turns. `src/components/AgentPage.tsx`
  records final user transcripts, committed assistant text, display revisions,
  selections, and heard-text interruption corrections locally in the snapshot
  sent with later turns.
- Tests are in `src/lib/conversation-state.test.ts`, the episode payload case in
  `src/lib/memory/contracts.test.ts`, and the real PostgreSQL conformance case
  in `backend/memory/src/postgres.live.test.ts`. No migration, provider call,
  autonomous reminder, workflow engine, or model extraction path was added.

Stage 06 is locally verified only. The client carries bounded continuity and
the Node authority exposes authorized checkpoint persistence/resume, but no
production route or automatic consented checkpoint policy was enabled. Local
PostgreSQL evidence is not staging or production proof; browser/provider logs,
remote voice behavior and model interpretations remain outside this stage.

## Stage 07 profiles, warm snapshots, and immediate correction overlays

- `src/lib/memory/projections.ts` is the edge-safe projection core. It builds
  bounded warm snapshots from current accepted assertion versions while
  retaining exact assertion revision references, source event ids, basis,
  scope, conditions, valid time and promotion reason on every profile bullet.
  Stable profile bullets are separate from active-topic bullets. Only explicit
  user statements and user corrections can promote a preference or decision;
  inferred preferences and generated summaries are excluded from profile
  evidence. Temporary exceptions are not stable profile bullets and expire from
  the constraints index at their valid-time boundary.
- The same core includes active `episode_checkpoint` heads, a topic-aware
  constraints index, bounded lexical term/frequency material, recent accepted
  changes, input coverage, epoch/dependency metadata, missing-input/conflict
  diagnostics, and bounded snapshot serialization/parsing. It exposes
  `buildWarmSnapshot()`, `applyAcceptedCorrectionOverlays()`,
  `serializeWarmSnapshot()`, `parseWarmSnapshot()`, `WarmSnapshotCache` and
  `SnapshotTelemetryBuffer`. Cache telemetry is a bounded in-memory control
  signal with separate retrieved/included/cited/independently-useful counts; it
  never mutates canonical records or ordinary context selection.
- Input composition is capped at 256 accepted versions and serialized snapshots
  at 128 KiB. If input or view material exceeds a bound, the inspector marks
  the view incomplete and identifies omitted data; canonical assertions remain
  untouched. Private cache leases expire within five seconds.
- `backend/memory/src/projections.ts` is the Node-only PostgreSQL adapter. It
  reads accepted current versions, suppression-visible source edges, recent
  change-feed entries, current event/change watermarks and policy/deletion
  epochs. Pure snapshot composition happens after the bounded read transaction;
  the publish transaction locks/rechecks epochs, watermarks, current input
  revisions and newer projection generations before writing the existing
  `projections`, `projection_members` and `managed_cache_entries` tables.
  Stale computation returns an explicit stale result and does not publish.
- `encodeProjectionChangeCursor()` and `readProjectionChangeFeed()` provide a
  bounded HMAC-authenticated cursor bound to principal, scope, policy epoch,
  deletion epoch and watermark. Invalid, cross-scope, epoch-stale, compacted
  or ahead cursors return `reset_required`; they never silently reinterpret a
  cursor for another owner.
- Warm reads validate the server-bound PostgreSQL session, epochs, private cache
  identity and snapshot schema. The lease is capped at five seconds, expired or
  invalidated entries are treated as cold, and an authority outage cannot
  replace a usable private snapshot with an empty corpus. Stage 05 deletion and
  revocation already purge these projection/cache/member rows and increment the
  epochs used by this adapter; no new migration was required.
- `src/lib/memory/projections.test.ts` provides deterministic edge-safe
  coverage for explicit-only promotion, stable/active separation, temporary
  expiry, correction replacement, duplicate-summary exclusion, size/parser
  bounds, identity/epoch/order/lease behavior, unavailable-authority behavior,
  invalidation and telemetry. The Stage 07 case in
  `backend/memory/src/postgres.live.test.ts` exercises real PostgreSQL
  publication, signed-feed pagination, correction overlays, stale publication,
  cursor reset, and deletion-driven projection/cache/member removal.

Stage 07 is locally verified only. The projection adapter is exported for later
server-side retrieval work but is not wired into ordinary HTTP, realtime voice,
Worker, browser or model context paths. No staging/production migration,
deployment, provider call, live voice test or real-user cache/deletion drill was
run. The five-second private cache is an inspectable bounded view, not an
independent authority and not an indefinite lease.

## Stage 08 hybrid retrieval and context composition

- `src/lib/memory/retrieval.ts` defines the authenticated `RetrievalRequest`,
  rejects caller-supplied authority, retains unresolved referents as unknown,
  builds a bounded query from resolved context and a small relevant committed
  span, ranks authorized lexical candidates, fuses branches deterministically,
  selects constraints independently of lexical overlap, and composes attributed
  context sections under a provider tokenizer or conservative UTF-8-byte
  ceiling. Non-positive cosine scores do not become semantic candidates.
- `backend/memory/src/retrieval.ts` is the Node/PostgreSQL adapter. Exact
  assertion/entity/decision reads, current constraints, PostgreSQL full-text
  search, requested warm-snapshot hints, exact versioned-vector scans and
  permitted source-only fallback run under a shared deadline. SQL scopes before
  candidate selection; hydration rechecks accepted versions and suppression;
  source fallback is limited to this principal's committed user statements and
  corrections with memory-capture/retention consent. A final policy/deletion
  epoch comparison withholds stale results. Returned packs require dispatch
  revalidation and confer no action authority.
- `indexAuthorizedEmbeddings()` accepts at most 16 exact current accepted
  versions, skips secret-like text before the provider call, stores only a
  scope/version/model/dimension/content-hash/vector record, and rechecks current
  authority before insert. Remote providers require a server-side authorization
  callback; no real provider is configured by default. Semantic hydration
  recomputes source hashes and validates evidence ownership, consent, source
  eligibility, source reference and suppression before ranking a stored vector.
- Exact cosine search is capped at 512 rows per scope and filters scope,
  current revision, model/version, dimensions, content hash and positive
  similarity before score ordering. It is a bounded development-scale scan, not
  an ANN index. PostgreSQL full text uses OR-composed bounded terms and GIN
  expression indexes.
- Constraint selection preserves unknown conditions as conditional, honors
  validity/exception windows and explicit task-only overrides, and keeps a
  general preference out of a task when neither explicit scope/condition nor
  useful lexical relevance applies. Hard constraints have priority; if budget
  cannot carry one, the pack exposes omitted handles and a budget-exhausted
  warning rather than silently implying it does not exist. Facts/conflict
  bundles are all-or-nothing; partial context status is consolidated into the
  coverage line so the highest-ranked fact is not discarded merely to print a
  long omission list.
- `runBoundedDeepRecall()` exposes cancellation and hard caps of 32 relationship
  edges and 64 evidence fetches. The exported adapter remains a seam; this stage
  does not add a user-facing route, automatic recall dispatch, reranker, Jev
  dependency, or graph database.
- `backend/memory/migrations/005-retrieval-embeddings.sql` adds the scoped
  derivative table and full-text indexes after migrations 001–004. It has been
  applied only by the owned disposable PostgreSQL test harness; it has not been
  run on a shared, staging, or production database.
- Tests: `src/lib/memory/retrieval.test.ts` covers request identity, unresolved
  references, Roman Urdu/negation, C07 expiry, C09 applicability, C10 irrelevant
  profile exclusion, C28 contextual preferences, C35 volatile prices, C36 task
  overrides, tenant/revision/model/vector filtering, conflicts, token ceilings,
  partial packs, C27 honest empty results and bounded cancellation.
  `backend/memory/src/postgres.live.test.ts` adds real PostgreSQL C09/C24/C27
  reads, evidence-only fallback, cross-scope isolation, metadata-only vector
  persistence, secret/remote-provider denial, current-revision retrieval,
  warm-preferred correction freshness and deletion cascade checks.
- `scripts/memory-retrieval-ablation.test.ts`, run by
  `npm run memory:retrieval:ablation`, pairs lexical, deterministic hybrid and
  applicability variants on 12 synthetic fixtures. Aggregate evidence is in
  `docs/memory/reports/stage-08-retrieval-ablation.json`. Fixture vectors are
  control-flow probes only; latency excludes PostgreSQL, provider, network and
  application/voice costs and cannot establish real semantic quality.
- `backend/memory/README.md` lists migration 005 and keeps its migration local-
  test-only for this stage. `src/lib/memory/index.ts` and
  `backend/memory/src/index.ts` export the retrieval contracts/adapter without
  wiring them into the application entry points.

Stage 08 is locally verified only after the ledger is marked `LOCAL_VERIFIED`
and the handoff records the final test run. No staging/production migration,
provider/model call, deployment, route integration, live voice check or
real-user privacy drill is performed. Stage 09 owns app and voice integration.

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
- `src/lib/conversation-state.test.ts`: deterministic topic suspension/resumption, exact display-revision references, correction lineage, local constraints, decision reasons, verified outcomes, expiry and full-state restore coverage for Stage 06.
- `backend/memory/src/postgres.live.test.ts`: Stage 06 real PostgreSQL checkpoint idempotency, revision updates, fresh-session resume, scope isolation and deletion/purge coverage, run through `npm run memory:postgres:test`.
- `src/lib/memory/projections.test.ts`: Stage 07 edge-safe profile, snapshot, correction-overlay, cache, invalidation, parser-bound and telemetry tests.
- `backend/memory/src/postgres.live.test.ts`: Stage 07 real PostgreSQL projection preparation/publication, signed change-feed cursor pagination/reset, stale computation rejection and deletion purge coverage, run through `npm run memory:postgres:test`.
- `src/lib/memory/retrieval.test.ts`: Stage 08 request/query planning, ranking/applicability, exact-vector filters, expiry, conflicts, safe preference overrides and tokenizer/budget outcomes.
- `backend/memory/src/postgres.live.test.ts`: Stage 08 real PostgreSQL exact/lexical/evidence retrieval, tenant isolation, embedding index/revision checks, provider authorization, warm correction and deletion cascade coverage.
- `scripts/memory-retrieval-ablation.test.ts` and `docs/memory/reports/stage-08-retrieval-ablation.json`: paired synthetic-only lexical/hybrid/applicability diagnostics; no model/network calls.
- `backend/memory/README.md`: local disposable PostgreSQL, migration, credential and rollback instructions.
