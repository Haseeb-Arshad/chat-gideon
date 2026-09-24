# Stage 16 handoff: portable framework, SQLite, SDK, MCP and second integration

Status: LOCAL_VERIFIED (package private and unpublished; no deployment)
Implementation commits:
- `746e610`: portable contract and core; SQLite backend; PostgreSQL adapter; cross-backend conformance
- `1e1aebb`: local memory server and typed SDK
- `22c6501`: MCP server with identity bound to the connection
- `dab480b`: second host example (visitor notes)
- `137199d`: package manifest, README, capability matrix, release review
- the commit that adds this handoff

Date: 2026-09-25
Environment: Windows 10, Node 22.13 (`node:sqlite`, experimental), disposable
local PostgreSQL 17. No registry publication, deployment or real-user data.

## Prerequisite evidence

Stage 15 local cutover rehearsal passed (`handoffs/15-migration-and-rollout.md`),
which this stage's entry gate requires. No public production launch was
needed.

## Audit of coupling (step 1)

| Assumption in the ChatGideon memory code | How the framework handles it |
|---|---|
| UI (inspector, voice) | Not in the framework; hosts build their own |
| Identity provider (signed Node cookie, Worker accounts) | The host supplies `scopeId`/`principalId`/grants to `openMemory`; the server maps bearer tokens; MCP fixes the scope at launch; the example signs its own visitor cookie |
| Cloudflare Worker | Not involved; the Worker bundle is unchanged and still free of the adapter |
| Filesystem (legacy JSON files) | Not used; SQLite file with owner-only creation |
| Database driver | SQLite via `node:sqlite`; PostgreSQL via the existing `pg`-based authority |
| Model providers | None: explicit commands and lexical search need no model |

The ChatGideon runtime (learning, warm snapshots, conversation state,
context packs, voice) stays in ChatGideon. The PostgreSQL adapter is a thin
layer over the proven Stage 04/05 commands, so the app keeps working unchanged.

## Implemented behavior

- **`packages/memory/src/contract.ts`:** wire protocol, stored schema and export
  format versioned separately; capability flags (transactions, revisions,
  idempotency, temporal, suppression, cross-process writers, fenced leases,
  search); typed `MemoryError` codes.
- **`core.ts`:** `openMemory` builds the only kind of handle, from host
  identity, with validation, grants, cancellation, paging, and export/import.
  Import refuses anything forgotten since the export (by original id) or
  since an earlier import (by command).
- **`sqlite.ts`:**
  - `BEGIN IMMEDIATE` plus WAL and busy timeout, so separate processes
    serialise through the database lock;
  - foreign keys, a stored-schema version check, a per-scope quota, and
    owner-only file creation;
  - a token index for search (this Node build has no FTS5);
  - forget removes content in the same transaction and blocks replay and
    re-import;
  - fenced job leases.
- **`postgres.ts`:** the same contract over the ChatGideon authority
  (`executeExplicitCommand`, `executeForgetCommand`, `readAssertionAsOf`,
  capture, job claims). One scope per principal; anything else is
  `unsupported`.
- **`server.ts` + `sdk.ts`:**
  - server: loopback by default, bearer-token identity (a body naming a
    scope is refused), protocol version check, body limit, cancellation on
    client disconnect;
  - SDK: typed errors, timeouts, `listAll` paging.
- **`mcp.ts` + `bin/mcp-sqlite.ts`:**
  - `recall/get/remember/correct/forget/resume/explain` over stdio JSON-RPC;
  - no tool takes an identity, and unknown arguments are errors;
  - outputs are bounded, and history is its own call.
- **`examples/visitor-notes`:** a second host with no ChatGideon code.
  - Server-signed visitor sessions pick the memory.
  - The owner's published notes are shared through an explicit read-only
    grant.
  - There is no linking by name or email; scopes stay isolated.

## Verification

| Command/check | Environment | Result |
|---|---|---|
| `npx vitest run packages/memory` | local, SQLite | 29 passed (conformance 12, SQLite specifics 6, server/SDK 5, MCP 5, example 1); PostgreSQL file skipped without the harness |
| `node scripts/memory-postgres-harness.mjs packages/memory/test/postgres.live.test.ts` | disposable PostgreSQL | 12/12, the same conformance suite |
| `npx vitest run` | local | 1091 passed |
| `npm run memory:postgres:test` | disposable PostgreSQL | 76/76 |
| Stage 14 ops + Stage 15 cutover + PostgreSQL conformance | disposable PostgreSQL | 27/27 |
| `npm run build`, `npm run build:cloudflare` | local | pass; Worker bundle free of PostgreSQL code; no secrets |

Independent processes:
- four OS processes writing and correcting one SQLite file (every
  acknowledged write present, gapless revisions);
- a real stdio MCP process;
- the example run as a separate process and restarted on the same file.

Defects the conformance suite found in this stage, all fixed before commit:
- **Stale-export resurrection:** importing an export taken before a forget
  recreated the memory. Exports now carry opaque ids, and import refuses
  forgotten ones on both backends.
- **Cursor checks:** SQLite returned an empty page before validating a
  foreign cursor.
- **Cursor precision:** the PostgreSQL cursor lost microseconds and repeated
  rows.
- **Server:** it treated a completed request body as a client disconnect
  (every call cancelled), and it could not shut down with keep-alive
  connections open.

Seed cases:

| Case | Evidence |
|---|---|
| C04 | conformance "C04: a real change keeps the old value…" (both backends) |
| C05 | conformance "C05: a mistake correction replaces the value at every point in time" |
| C19, C20 | conformance "C19/C20: a stale revision is refused…"; SQLite four-process test |
| C21 | conformance "C21: a repeated command replays…"; MCP requestId retry |
| C22 | conformance "C22: forgetting removes content, blocks replay and re-import…"; example forget |
| C23 | Stage 14 restore drill (PostgreSQL); SQLite has no restore protocol (limitation) |
| C24 | conformance "C24: another scope reads… nothing"; server token isolation; MCP; example visitors |
| C25 | SQLite "a closed store fails loudly…"; SDK unreachable server is `unavailable`; PostgreSQL outage tests (Stage 14) |
| C29 | MCP "C29: a tool argument naming another identity is refused…"; server refuses scope fields |
| C33 | SQLite quota test; PostgreSQL quota (Stage 04 suite) |

## Decisions and deviations

- The portable contract is deliberately narrower than ChatGideon's runtime.
  Learning, conversation state, warm snapshots and context packs are not part
  of it, and the capability matrix says so rather than wrapping them in
  get/set calls.
- The package lives in the repository (`packages/memory`) with `.ts` sources
  and no workspace wiring, so the root install and builds are unchanged.
- MCP is implemented directly on JSON-RPC, with no new dependency downloaded.
- Account linking is not implemented; scopes stay isolated, and sharing is
  only an explicit grant configured by the host.

## Remaining gaps

- **Not published:** licensing is undecided (`UNLICENSED`), there is no
  compiled output, and the PostgreSQL adapter imports repository paths. See
  `packages/memory/RELEASE.md`.
- **SQLite limits:**
  - `node:sqlite` is experimental;
  - there is no FTS5, so search uses a token index;
  - there is no restore protocol;
  - calls block the event loop while waiting on the lock, so it suits a
    local host, not shared multi-tenant serving.
- **Deletion:** captured turns are not linked to memories in the portable
  contract, so forget does not reach them there.
- **Remote server:** needs TLS in front and real token management. The
  server only refuses non-loopback binds without an explicit opt-in.
- **The public second-host deployment was not performed** (a separate scoped
  action).

## Disable or revert

Nothing in ChatGideon imports `packages/memory`. Removing the directory
removes the framework and leaves the app unchanged. The PostgreSQL adapter
writes to the same tables through the same commands; it adds no schema.

## Next stage contract

`packages/memory` exports: `openMemory`, `ScopedMemory`,
`SqliteMemoryBackend`, `PostgresMemoryBackend`, `createMemoryServer`,
`createMemoryClient`, `createMcpHandler`, `runMcpStdio`, and
`backendConformance` (test).

Stages 17 (procedural learning) and 18 (multimodal memory) are optional and
independent. Continue with 17 only if the procedural track is chosen.
