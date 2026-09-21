# Stage 02: Shared contracts, runtime validation, and authenticated memory sessions

Status: LOCAL_VERIFIED
Implementation commit or working-tree identifier: Stage 02 commit `feat: establish shared memory contracts and identity sessions` (the pushed commit containing this handoff)
Date: 2026-09-21
Environment: Windows 10.0.19045 x64, Node v22.13.0, npm 11.0.0, Vitest 4.1.5; local synthetic data only

## Prerequisite evidence

- Read and followed `docs/memory/implementation/00-COMMON-INSTRUCTIONS.md`,
  `docs/memory/FOUNDATION-2026-09-21.md` sections 4–6 and 10,
  `docs/memory/implementation/00-PROGRESS.md`, the acceptance coverage map,
  the complete Stage 02 prompt, and `handoffs/01-baseline-and-receipts.md`.
- Rechecked the clean feature branch at `1a0ef51` before editing. The branch
  tracks `origin/fix/reliability-and-memory-isolation`; `master` and
  `origin/master` remain at the earlier merged visualization baseline
  `db4f6b4`.
- Reused the existing Better Auth/Worker owner path and signed Node cookie
  boundary. No second account system, automatic person linking, or grant
  broadening was introduced.
- Reviewed current Cloudflare Durable Object guidance for deterministic
  per-entity routing, Worker-side authentication/validation, RPC boundaries,
  and test isolation. This stage does not add a Durable Object class or change
  storage migrations.

## Implemented behavior

- Added an edge-safe schema-versioned contract module for principals, clients,
  subjects, scopes, grants, events, immutable source spans, assertion variants,
  evidence/dependencies, projections, public/bound commands, storage
  capabilities, typed failures, and contradictory-state-safe receipts.
- Runtime validators parse JSON-shaped data rather than trusting TypeScript
  objects. They reject unknown unsafe enum values, unknown fields, invalid span
  offsets/hashes, oversized payloads, unsupported slot cardinality, mismatched
  assertion/payload kinds, unknown temporal precision, unbounded failure
  details, and receipt states that claim impossible revisions/watermarks.
- Actor and subject are separate. Third-party quotes and browser assistant
  reports cannot become user self-preferences or server-generated assistant
  evidence. Hypothetical, role-play, and quotation mode markers are retained as
  evidence but are refused by the self-assertion admission predicate.
- `MemorySession` is constructed through the server binder only. The binder
  derives scope, subject, principal, grants, authority, and policy epoch from a
  server-selected owner; it accepts no public tenant, grant, or source-authority
  fields. Unverified requests are explicitly ephemeral.
- Node HTTP and Node realtime resolve the signed cookie through the new
  Node-specific resolver. Worker HTTP and Worker Durable Object realtime bind
  the owner already resolved by Better Auth/Worker ingress. Model-visible
  memory tools use the bound session store and grant check when a session is
  present; the direct store field remains an explicitly documented compatibility
  path for Stage 01 tests and baseline fixtures.
- Added a test-only capability adapter with transaction, exact-version,
  scoped-read, slot-lock, lease, suppression, and dependency seams. It is not
  exported by the edge entry point and is not presented as PostgreSQL proof.

## Source and schema map

- `src/lib/memory/contracts.ts`: edge-safe schema v1 types, validators,
  receipt/error unions, time semantics, source attribution, policy functions,
  and storage capability interfaces.
- `src/lib/memory/index.ts`: the only Worker-facing contract export.
- `src/lib/memory/test-adapter.ts`: explicitly test-only in-memory capability
  implementation.
- `src/lib/memory/contracts.test.ts`: malformed JSON, attribution,
  hypothetical, slot/cardinality, command spoofing, scope, injection,
  assistant-forgery, receipt, version, and adapter tests.
- `src/lib/memory/edge-entry.test.ts`: import-graph proof that the edge entry
  does not reach Node/filesystem/server/database/provider/secret modules and
  does not export the test adapter.
- `src/server/memory-session.ts`: shared server-only owner-to-session binder.
- `src/server/node-memory-session.ts`: signed-cookie Node resolver; kept out of
  the Worker import graph.
- `src/server/memory-session.test.ts`: authenticated/ephemeral derivation,
  descriptor serialization, and malformed-owner tests.
- `src/lib/tools/registry.ts`: grant-check and bound-store use for memory tools.
- `src/lib/agent-core.ts`, `src/lib/realtime-session.ts`: prebound session
  threading into model-visible server tools.
- `src/lib/openrouter.server.ts`, `src/server/realtime-host.ts`: Node HTTP and
  socket resolver integration.
- `backend/worker/src/api.ts`, `backend/worker/src/realtime.ts`: Worker HTTP
  and Durable Object session binding.
- `docs/memory/contracts-and-identity.md`: API semantics, wire/bound split,
  receipt meanings, bounded failures, and schema upgrade strategy.
- `docs/memory/implementation-map.md` and
  `docs/memory/implementation/00-PROGRESS.md`: actual ownership and evidence
  status.

No migration, database table, provider, package, production feature flag, or
new account authority was added. Existing memory feature flags remain reserved
and off; Stage 09 will decide how enabled application capture/commands use the
new seam.

## Decisions and deviations

- The contracts are in a small new `src/lib/memory/` entry point rather than
  moving the legacy `src/lib/tools/memory.ts`. This keeps existing application
  behavior stable and makes the Worker import boundary auditable.
- `MemorySession` stores a selected `MemoryStore` only after server binding.
  The serializable descriptor deliberately omits that handle, so a browser or
  model cannot send one over the wire. The legacy `ToolContext.store` fallback
  remains for current baseline/unit adapters and is not used by the new server
  routes when they provide a session.
- The policy layer is deterministic and receives structured trusted fields;
  retrieved text is never passed to grant evaluation. It cannot authorize
  payment/action permissions, and Stage 02 does not add any such actions.
- The public session descriptor validator is for known internal serialization
  only; the production binder does not deserialize grants from request payloads.
  Server code derives them from the authenticated owner and policy.
- Current Node/Worker stores still provide legacy memory persistence. The new
  storage capability interface is intentionally unimplemented in production;
  transactional PostgreSQL, idempotency, leases, and cross-process locking are
  Stage 03 responsibilities.

## Verification

| Command/check | Environment | Result | Evidence artifact |
|---|---|---|---|
| `npm test -- src/lib/memory/contracts.test.ts src/lib/memory/edge-entry.test.ts src/server/memory-session.test.ts src/lib/tools/memory-tools.test.ts` | Local Node/Vitest, synthetic fixtures | PASS, 4 files / 30 tests | Contract and session test output |
| `npm test -- src/lib/memory/contracts.test.ts src/lib/memory/edge-entry.test.ts src/server/memory-session.test.ts src/lib/tools/memory.test.ts src/lib/tools/memory-tools.test.ts src/lib/agent-core.test.ts src/server/identity.test.ts src/server/realtime-host.test.ts src/lib/realtime-session-regression.test.ts backend/worker/src/memory.test.ts backend/worker/src/accounts.test.ts backend/worker/src/api.test.ts` | Local Node/Vitest, offline | PASS, 12 files / 95 tests | Worker, identity, transport, and memory regression output |
| `npx tsc --noEmit` | Local TypeScript | PASS | Exit code 0 |
| `npm run build:cloudflare` | Local Vite Cloudflare build and TypeScript | PASS | Client/SSR Cloudflare bundle completed; existing large-chunk warning only |
| `git diff --check` | Local Git | PASS | No whitespace errors |

Acceptance mapping for this stage:

- C11: `keeps a colleague quote attributed to the third party` proves actor
  and claim subject remain distinct and no self-claim basis is created.
- C12: `does not treat hypothetical future speech as an explicit self fact`
  proves the explicit hypothetical mode is refused by
  `sourceCanEstablishSelfAssertion`.
- C24: `denies a cross-scope candidate read before selection` proves the pure
  grant gate denies a requested foreign scope before any candidate read.
- C29: `does not turn retrieved prompt injection into action authority` proves
  policy is independent of retrieved content and client-reported assistant
  text cannot establish server assistant authority.

Additional forbidden-outcome assertions cover tenant/grant/source-authority
spoofing, forged assistant attribution, oversized payloads, invalid source
spans, unknown enum/schema versions, unregistered slots, bounded failure
details, contradictory receipts, and model-supplied scope fields. These are
local contract/policy tests, not database, provider, deployment, or voice proof.

## Operational behavior

- A verified Node cookie creates a durable-owner session using the existing
  `nodeMemoryStore`; a missing/invalid cookie creates a fresh ephemeral session
  and store. Better Auth/Worker owner resolution remains the source of Worker
  account identity, and the DO still checks its internally injected owner
  against its deterministic object identity.
- No new storage is written by contract validation. The test adapter is only
  instantiated by tests. No D1/PostgreSQL/Supabase migration or remote command
  ran.
- The session is attached before `streamTurn` and before realtime model tool
  dispatch. The model only supplies the validated public operation/content; the
  session supplies storage, subject, scope, grants, and authority.
- To disable Stage 02 safely, revert its stage-owned commit. Existing routes
  can fall back to their prior `memoryStore` plumbing; no Stage 02 migration or
  data deletion needs rollback. Do not remove existing account/cookie or memory
  files as part of disablement.

## Remaining gaps

- No staging or production deployment, database, provider, or live voice test
  was run. The Cloudflare build is local build evidence, not deployment proof.
- PostgreSQL transaction authority, event/outbox persistence, idempotency,
  leases/fencing, cross-process concurrency, correction history, deletion
  suppression, projections, retrieval, automatic learning, Jev, migration,
  controls, and production rollout remain unimplemented.
- The current legacy memory tools still accept their compatibility store path
  when a caller omits a session. Stage 09 is responsible for changing enabled
  application behavior to structured commands/receipts and removing or
  narrowing that compatibility path after its own tests.
- The pure C24 authorization test does not prove database row-level security or
  hydration isolation; that requires Stage 03 and later operational gates.

## Next stage contract

Stage 03 may rely on:

- `src/lib/memory/index.ts` and `contracts.ts` as the edge-safe shared contract
  surface.
- `MemoryStorageCapabilities` / `MemoryStorageTransaction` for a real
  PostgreSQL adapter with transactions, idempotency, exact versions, scoped
  reads, slot locking, outbox leases, suppression checks, and dependency reads.
- `MemoryReceipt` meanings and `MemoryFailureCode` values; a durable backend
  must not collapse captured/accepted/indexed/pending/failed into one boolean.
- `MemorySession` from `createServerMemorySession` for trusted principal/scope
  binding; PostgreSQL must recheck the session scope and grants inside its
  transaction.
- `TestMemoryAdapter` only for pure conformance/reducer tests, never as a
  substitute for real PostgreSQL acceptance.

Next prompt: `docs/memory/implementation/03-postgres-and-jobs.md`. Do not treat
any pure test adapter result as the Stage 03 database gate.
