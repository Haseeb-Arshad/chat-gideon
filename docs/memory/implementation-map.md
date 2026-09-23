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

## Feature-flag names and current wiring state

These names are server-side controls. Stage 09 wires the Node HTTP/realtime
adapter behind them, but defaults remain off and production remains gated by
the separately authorized Stage 15 cutover. A flag being present is not proof
that its capability is enabled or production-verified.

| Capability | Environment flag | Current state |
|---|---|---|
| Capture committed conversation evidence | `GIDEON_MEMORY_CAPTURE_ENABLED=1` | Stage 09 Node HTTP/realtime only; default off |
| Canonical command writes | `GIDEON_MEMORY_COMMAND_WRITES_ENABLED=1` | Stage 09 Node HTTP/realtime only; default off |
| Memory recall/context injection | `GIDEON_MEMORY_RECALL_ENABLED=1` | Stage 09 Node HTTP/realtime only; default off |
| Stable owner rollout cohort | `GIDEON_MEMORY_ROLLOUT_PERCENT=0..100` | Stage 09 server-selected FNV owner bucket; unset/malformed means 0 |
| Production cutover gate | `GIDEON_MEMORY_STAGE15_CUTOVER=1` | Required in `NODE_ENV=production`; Stage 15 owns authorization |
| Automatic/background learning | `GIDEON_MEMORY_LEARNING_ENABLED=1` | Stage 10 Node runner; per-owner via the same cohort and production gate; default off |
| Background maintenance runner | `GIDEON_MEMORY_BACKGROUND_ENABLED=1` | Stage 10 process-level purge, stale-view rebuild and learning queue; production gated; default off |
| Runner interval | `GIDEON_MEMORY_BACKGROUND_INTERVAL_MS` | Stage 10; clamped to 1 s–10 min, default 10 s |
| Extractor selection | `GIDEON_MEMORY_EXTRACTOR=rules\|model` | Stage 10; `rules` (local, no network) unless `model` **and** the spend switch below are both set |
| Remote extraction spend switch | `GIDEON_MEMORY_EXTRACTOR_REMOTE_ALLOWED=1` | Stage 10; required for any paid model extraction; never set by default |
| Extractor model | `GIDEON_MEMORY_EXTRACTOR_MODEL` | Stage 10; defaults to `openai/gpt-6-luna` (changed in Stage 11 at the user's instruction) when the model extractor is enabled |
| Semantic/vector search | `GIDEON_MEMORY_SEMANTIC_SEARCH_ENABLED` | Stage 08 adapter exists; no provider configured by default |
| Classifier-assisted learning | `GIDEON_MEMORY_CLASSIFIER_MODE=shadow\|enforce` | Stage 11; unset = off. Needs `GIDEON_MEMORY_CLASSIFIER_REMOTE_ALLOWED=1`; production gated. See ADR 0001 |
| Classifier provider / workflow | `GIDEON_MEMORY_CLASSIFIER_PROVIDER=jev\|substitute`, `GIDEON_MEMORY_CLASSIFIER_WORKFLOW=verify\|gate` | Stage 11; defaults `jev`, `verify`; Jev needs `TYPESAFE_API_KEY` (absent) |
| Pinned classifier models | `GIDEON_MEMORY_JEV_MODEL`, `GIDEON_MEMORY_CLASSIFIER_MODEL` | Stage 11; defaults `jev-1.13.0`, `openai/gpt-6-luna` |

The three Stage 09 capability flags are independent: enabling one does not
enable capture, command writes, or recall. The rollout owner is derived from a
server-bound owner and is never accepted from request or browser data.

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

## Stage 09 ChatGideon HTTP, realtime voice, cards, and action ledger

Stage 09 is locally verified only. It connects the Stage 08 retrieval and
Stage 03–07 authority seams to the Node HTTP and realtime application paths
without changing the Worker authority or enabling production behavior.

### Shared application adapter and rollout

- `src/server/node-memory-integration.ts` is the shared Node adapter used by
  both `src/lib/openrouter.server.ts` and `src/server/realtime-host.ts`. It
  resolves the signed `gideon-owner` cookie, binds the authenticated
  `MemorySession<PostgresMemoryStore>`, selects the server-owned rollout
  cohort, and lazily creates the existing PostgreSQL store. No client owner,
  scope, grant or policy epoch is accepted as authority.
- `src/lib/memory/rollout.ts` keeps capture, canonical command writes and
  recall independent. A missing or malformed `GIDEON_MEMORY_ROLLOUT_PERCENT`
  is zero; unauthenticated/missing owners are disabled; production requires
  `GIDEON_MEMORY_STAGE15_CUTOVER=1`. With all capabilities off, no PostgreSQL
  pool is created by the Node adapter.
- A missing database configuration or unavailable database becomes a typed
  unavailable memory result. The adapter does not create an empty replacement
  corpus and does not report a successful save after a timeout.

### Turn binding and structured recall

- `src/lib/memory/turn-runtime.ts` defines the shared turn binding: client
  `turnId`, server-issued `responseId`, principal/scope/policy epoch,
  timezone, exact latest-user transcript SHA-256, speculative bit, depth and
  bounded `ConversationState`.
- `src/lib/agent-core.ts` injects the attributed Stage 08 `ContextPack` as
  untrusted evidence, with coverage/unavailable status and identity/binding
  checks. It does not turn retrieved text into tool authority. Legacy direct
  memory injection remains only for callers without the canonical runtime.
- Speculative recall is bound to owner, scope, policy epoch, response/turn and
  exact transcript. A stale or mismatched result is discarded, and speculative
  turns never capture events or execute durable commands.

### Canonical capture and commands

- Committed user capture is performed once after the latest user message is
  known. `buildCommittedUserEvent()` creates one authenticated `user_statement`
  event with a deterministic event/idempotency key and an exact source span;
  it never treats browser-provided assistant history as evidence. PostgreSQL
  sequence assignment occurs inside the capture transaction when requested.
- `src/lib/tools/registry.ts` routes `remember`, `correct`, `forget` and deep
  `recall` through `MemoryTurnRuntime` when the canonical runtime exists.
  Ambiguous correction/forget requests remain pending and ask for a choice;
  accepted commands expose their receipt ID/state; failures are explicit.
  Runtime presence plus a disabled individual capability fails closed rather
  than silently falling back to legacy mutation. The old direct `MemoryStore`
  compatibility path remains for non-canonical callers and existing tests.
- `backend/memory/src/commands.ts` validates exact source spans and includes
  them in command hashes/events/evidence. `backend/memory/src/postgres.ts`
  compares semantic event content for idempotency and allocates a sequence in
  the transaction, so retries do not duplicate a committed capture.
- `src/lib/conversation-state.ts` and `src/components/AgentPage.tsx` record
  final verified tool outcomes separately from speech delivery. An
  interruption can invalidate pending speech without erasing a completed
  action; a pending action is not treated as accepted.

### Text, audio, card, and observation provenance

- `src/lib/protocol.ts` is protocol version 4. Server frames carry response
  IDs, text segment character ranges, action receipt state/ID, and card
  artifact IDs/display revisions. Client speak and observation frames carry
  only bounded provenance claims that the server can validate.
- `src/lib/realtime-session.ts` and `src/lib/realtime-client.ts` reject forged
  audio spans, issue server-owned audio segment IDs, preserve late terminal
  receipts after interruption, and accept only observations tied to issued
  response/segment/artifact records. HTTP fallback keeps the same frame
  contract, while browser tool fulfilment remains socket-only.
- `src/lib/delivery-observations.ts` is a bounded, deduplicated ledger. It
  distinguishes generated text, sent audio, playback-reported ranges,
  interruption points and displayed artifact revisions. An interruption has
  conservative bounds; generated text is never automatically marked heard or
  agreed. `src/lib/voice-queue.ts` carries exact source ranges into speak calls.
- Cards receive stable server artifact IDs and monotonic revisions. The page
  reports displayed revisions into conversation state, allowing historical
  ordinal references to resolve against the visible artifact snapshot rather
  than the latest mutable card.

### Changed paths and compatibility

| Concern | Paths | Compatibility/boundary |
|---|---|---|
| Rollout and turn contracts | `src/lib/memory/rollout.ts`, `src/lib/memory/turn-runtime.ts` | Edge-safe types; no client authority; production default off |
| Node HTTP integration | `src/lib/openrouter.server.ts`, `src/server/node-memory-integration.ts`, `src/server/memory-session.ts` | Signed Node owner and PostgreSQL only when enabled; unavailable is typed |
| Node realtime integration | `src/server/realtime-host.ts`, `src/lib/realtime-session.ts` | Same adapter as HTTP; no Worker import of `pg` |
| Agent/context/action path | `src/lib/agent-core.ts`, `src/lib/tools/registry.ts`, `src/lib/conversation-state.ts` | Structured evidence is not policy; legacy compatibility remains when no canonical runtime |
| Transport provenance | `src/lib/protocol.ts`, `src/lib/realtime-client.ts`, `src/lib/delivery-observations.ts`, `src/lib/voice-queue.ts` | Version 4 metadata is optional in compatibility callbacks but validated when present |
| UI cards/resources/voice | `src/components/AgentPage.tsx`, `src/components/ResourcesPanel.tsx`, `src/components/stage/Stage.tsx` | Stable artifact/display revisions and receipt states; no visual redesign |
| PostgreSQL event/command semantics | `backend/memory/src/serialization.ts`, `backend/memory/src/postgres.ts`, `backend/memory/src/commands.ts` | Existing migrations/authority retained; no new production migration |
| Tests | `src/lib/memory/*.test.ts`, `src/lib/*delivery*.test.ts`, `src/lib/openrouter-memory-integration.test.ts`, `src/server/node-memory-integration.test.ts`, `src/lib/agent-core.test.ts`, `src/lib/realtime-delivery.test.ts` | Local control-flow and disposable-authority evidence only |

The Worker continues using its prior local/ephemeral/ Durable Object memory
paths; Stage 09 does not make the Node PostgreSQL adapter edge-safe. The
existing account/session and memory authority contracts remain the source of
identity, consent, deletion and policy epoch truth.

### Stage 09 acceptance boundary

The implementation covers the local control paths for C01, C03, C15, C16,
C17, C18, C19, C25 and C34: stable artifact/card revisions, conservative
interruption state, independent action receipts, exact delivery provenance,
forged-segment rejection, speculative isolation, structured retrieval wiring,
typed outage handling and conversation-state continuity. The handoff records
the executable tests for each case. No case is promoted to staging or
production proof. Cross-socket invalidation/reconnect validation, a real
voice/browser/provider run, Worker/PostgreSQL cutover and automatic
commitment extraction remain later-stage work.

## Post-audit repairs to Stages 01–09 (2026-09-23)

An audit of Stages 01–09 before Stage 10 found nine issues. Each is repaired
with a regression test; see `handoffs/10-background-learning.md` for detail.

| Finding | Repair | Paths |
|---|---|---|
| Deleted tombstones kept an unkeyed hash of the forgotten text | Logical deletion and restore replay clear `canonical_key`; migration 006 scrubs existing tombstones; deleted-command replays stay blocked by retained event suppression | `backend/memory/src/deletion.ts`, `backend/memory/migrations/006-tombstone-canonical-keys.sql` |
| A forgotten fact could never be explicitly remembered again | A new explicit statement gets a new identity; a replay of the deleted command is still `suppressed` | same |
| The Cloudflare Worker bundle contained `pg` and the Node adapter | Cloudflare builds resolve the adapter to a stub; `build:cloudflare` fails if `pg`/the adapter reappears | `vite.config.ts`, `src/server/node-memory-integration.worker.ts`, `scripts/check-worker-bundle.mjs` |
| App recall ignored conversation state; tools could not scope or date memory; `replaces` was ignored | Recall carries topic, recent committed turns, local instructions and state; `remember` takes `appliesTo`/`until`/`replaces`+`since`; `correct` takes `change`/`since` | `src/lib/memory/recall-context.ts`, `src/server/node-memory-integration.ts`, `src/lib/tools/registry.ts` |
| No background worker ran purge, projections or the learning queue | Stage 10 maintenance runner | `backend/memory/src/background.ts` |
| Topic/label matching used substrings ("Taiwan" matched "AI") | Whole-word matching | `src/lib/conversation-state.ts` |
| Conversation context was cut silently at 8,000 chars | Oldest turns dropped with an explicit notice; a lone oversize line is marked | `src/lib/conversation-state.ts` |
| Concurrent identical captures got a retryable conflict | The waiting duplicate re-reads and returns the original receipt | `backend/memory/src/postgres.ts` |
| Capture and recall ran sequentially before the model | They run concurrently | `src/lib/agent-core.ts` |

## Stage 10 background learning and bounded maintenance

- `src/lib/memory/learning.ts` (edge-safe): extraction window/candidate
  contracts, secret screening before any extractor, strict output validation
  (every candidate's quote must equal the exact slice of the committed turn),
  deterministic reconciliation (`add`/`corroborate`/`dispute`/`reject`),
  the conservative promotion policy and the pure shadow-diff.
- `src/lib/memory/rule-extractor.ts` (edge-safe, default): local English /
  Roman Urdu / code-switch rules. Quotes, hypotheticals, jokes, questions,
  assistant echoes and spoken self-repairs are labelled and refused;
  per-task instructions become local candidates; stated changes are held for
  review. It cannot invent a claim.
- `src/lib/memory/screening.ts` (edge-safe): shared secret screen (also used by
  Stage 08 retrieval) and special-category detection; sensitive topics are
  never learned implicitly.
- `backend/memory/src/learning.ts`: the worker. The extractor runs outside any
  transaction; the commit transaction rechecks fence, lease, grant/deletion
  epochs, input suppression, source text and consent, reloads current memory,
  and reconciles. A deletion elsewhere in the scope forces recomputation
  (`stale_epoch`); deletion of the input dead-letters the job. Learned text
  never supersedes user-authored memory. Also `promoteLearnedCandidates()` and
  the non-writing `shadowReextract()`.
- `backend/memory/src/model-extractor.ts`: optional OpenRouter adapter, off by
  default, gated by an explicit spend switch; offsets are computed locally.
- `backend/memory/src/background.ts`: `runMemoryMaintenance()` (purge →
  stale views → fair, budgeted learning → promotion) and
  `startMemoryBackground()`; started lazily by the Node adapter when
  `GIDEON_MEMORY_BACKGROUND_ENABLED=1`.
- `backend/memory/migrations/007-background-learning.sql`: reason-code-only
  `learning_decisions` (cascade with their source event), per-user
  `learning_budgets`, `learned`/`promoted`/`retired` change kinds.
- Evaluation: `npm run memory:extraction:eval` over
  `scripts/fixtures/memory-extraction-dev.json`, report at
  `docs/memory/reports/stage-10-extraction-eval.json`.

## Stage 11 optional classification (Jev) and adoption decision

- `src/lib/memory/classification.ts` (edge-safe): Choice/Noul/Score contract in
  TypeSafe's shape, bounded request validation, strict answer parsing, the four
  allowed memory question families (candidacy, temporary vs durable, relation
  to retrieved memories, activity) and conservative verdicts.
- `src/lib/memory/classified-extractor.ts` (edge-safe): wraps any extractor
  in `verify` or `gate` mode. It can only refuse, hold for review (`review:
  'abstain'`) or narrow to the current task; failures abstain. The trace rides
  in the extractor output (`classificationTraceOf`).
- `src/lib/memory/learning.ts`: optional `review` on candidates and
  `knownMemories` on windows; `decideCandidate(..., { sourceText })` checks the
  whole source sentence for special-category topics (reader repair).
- `backend/memory/src/typesafe-classifier.ts`: server-only Jev adapter
  (`POST https://api.typesafe.ai/v1/systemone`, pinned `jev-1.13.0`).
  `backend/memory/src/llm-classifier.ts`: OpenRouter substitute, labeled
  `llm_substitute`, never reported as Jev.
- `backend/memory/src/learning.ts`: `shadow` extractor recording reason codes
  only (`compareShadow`, `learning_decisions.action = 'shadow'`) and the
  scope-bound `includeKnownMemories` read; `backend/memory/migrations/008-classifier-shadow.sql`.
- `src/server/node-memory-integration.ts`: `learningExtractorsFromEnv()` feeds
  the background runner only.
- Evaluation: `npm run memory:classifier:eval` (offline by default; live needs
  `MEMORY_CLASSIFIER_EVAL_PHASE=dev|heldout` and `MEMORY_CLASSIFIER_EVAL_LIVE=1`,
  refuses any model but `openai/gpt-6-luna`, caches responses under the ignored
  `output/memory-classifier-eval/`, stops at $0.25). Fixtures
  `scripts/fixtures/memory-classifier-{dev,heldout,thresholds}.json`; reports
  `docs/memory/reports/stage-11-{dev,heldout}.json`; decision
  `docs/memory/decisions/0001-jev-classification.md`.

Stage 11 is locally verified with a measured deferral: no Jev call was made
(no key), and every classifier mode is off by default.

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
- `src/lib/memory/learning.test.ts`, `src/lib/memory/recall-context.test.ts`: Stage 10 extraction, validation, reconciliation, promotion, shadow diff and post-audit recall/command-shape tests.
- `backend/memory/src/model-extractor.test.ts`: model-extractor plumbing against a fixture provider (no network) and Stage 10 flags.
- `backend/memory/src/postgres.live.test.ts`: Stage 10 real PostgreSQL learning, refusal, duplicate/corroboration, promotion, deletion races, shadow diff, budgets and maintenance.
- `scripts/memory-extraction-eval.test.ts` and `docs/memory/reports/stage-10-extraction-eval.json`: development-set extraction quality; rules only, zero provider calls.
- `scripts/check-worker-bundle.mjs`: fails the Cloudflare build when Node-only memory code enters the Worker bundle.
- `backend/memory/README.md`: local disposable PostgreSQL, migration, credential and rollback instructions.
