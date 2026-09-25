# @gideon/memory

Long-term memory for applications that must keep one person's memory
separate from everyone else's, keep corrections, and make forgetting stick.

It provides:
- the same contract on SQLite (local, one file) and PostgreSQL (the
  ChatGideon authority);
- a local HTTP server and a TypeScript SDK;
- an MCP server for model clients.

Explicit remember, correct and forget need no model and no embeddings.

Status: 0.1.0, private, not published. It lives in the ChatGideon repository
and needs Node 22.13 or later (it uses the built-in `node:sqlite`, which is
still experimental in Node).

## Quickstart (SQLite)

```ts
import { openMemory } from './packages/memory/src/core.ts'
import { SqliteMemoryBackend } from './packages/memory/src/sqlite.ts'

const backend = new SqliteMemoryBackend({ path: './data/memory.db' })
// scopeId/principalId come from your own authentication, never from request data.
const memory = openMemory({ backend, scopeId: 'user-42', principalId: 'user-42' })

const saved = await memory.remember({ commandId: 'req-1', text: 'I prefer aisle seats', kind: 'preference' })
await memory.correct({ commandId: 'req-2', id: saved.item.id, expectedRevision: 1, text: 'I prefer window seats', change: 'changed', since: '2026-09-01' })
console.log(await memory.search('which seat do I like?'))
await backend.close()
```

Run it twice: the second run replays `req-1` instead of saving again (same
command id, same content), and the memory survived the restart. A complete
host is in `examples/visitor-notes` (signed visitor sessions, a shared
read-only owner memory):

```
NOTES_DATA=./data/notes.db NOTES_SECRET=<32+ random characters> \
  node node_modules/jiti/lib/jiti-cli.mjs packages/memory/examples/visitor-notes/main.ts
```

## Surfaces

- **Library:** `openMemory({ backend, scopeId, principalId, grants })` returns a
  `ScopedMemory`: `remember`, `correct`, `forget`, `get`, `getAt`, `history`,
  `list` (keyset pages), `search`, `capture`, `claimJobs`/`completeJob`,
  `exportAll`/`importAll`. Every call takes an `AbortSignal`; failures are
  `MemoryError` with a `code` (`validation`, `unauthorized`, `conflict`,
  `not_found`, `suppressed`, `quota`, `unavailable`, `unsupported`,
  `cancelled`).
- **Local server:** `createMemoryServer({ backend, tokens })`. It uses
  loopback only unless `allowRemote` is set; if you set it, put it behind
  TLS. A bearer token maps to one identity, and a request body that names a
  scope is refused.
- **SDK:** `createMemoryClient({ baseUrl, token })`, the same methods without a
  scope, with `listAll()` paging.
- **MCP:** `recall`, `get`, `remember`, `correct`, `forget`, `resume`,
  `explain` over stdio (`bin/mcp-sqlite.ts`, configured with
  `GIDEON_MEMORY_MCP_DB` and `GIDEON_MEMORY_MCP_SCOPE`). No tool takes an
  identity, and unknown arguments are errors. stdio is not a security
  boundary: give each person their own configuration and database.

## Versions

| What | Version | Changes when |
|---|---|---|
| Wire protocol (`x-gideon-memory-protocol`) | 1 | request/response shapes change; the server refuses other versions |
| Stored schema (SQLite `meta.schema_version`) | 1 | the SQLite tables change; a newer file is refused, not read |
| Export format (`gideon-memory-export`) | 1 | the export document changes |

## Capability matrix

| Guarantee | SQLite | PostgreSQL |
|---|---|---|
| Atomic writes | yes (`BEGIN IMMEDIATE`) | yes |
| Optimistic revisions (stale edit is a conflict) | yes | yes |
| Idempotent commands (replay; other payload is a conflict) | yes | yes |
| Point-in-time reads (`getAt`, valid-at) | yes | yes |
| Forget removes content, blocks replay and re-import | yes, content removed in the same transaction | yes, suppression at once, physical purge by the purge worker |
| Cross-process writers | database write lock (WAL, busy timeout) | row locks and transactions |
| Fenced job leases | yes | yes |
| Lexical search | token index (this Node build has no FTS5) | PostgreSQL full text |
| Semantic search | no | no (not configured) |
| Scope ≠ principal | yes (a scope binds to its first principal) | no: `unsupported` (one account scope per principal) |
| Item quota | 1,000 per scope (configurable) | 1,000 per scope (database setting) |
| Warm snapshots, learning, conversation state, context packs | not provided | ChatGideon runtime only, not part of this contract |

Unsupported guarantees fail with `unsupported`; nothing is emulated.

## Conformance

The same suite (`test/conformance.ts`) runs against every backend:

```
npx vitest run packages/memory                                                          # SQLite and the rest
node scripts/memory-postgres-harness.mjs packages/memory/test/postgres.live.test.ts     # PostgreSQL (disposable)
```

A new backend passes only if it passes that suite unchanged.

## Deletion and export limits

- Forgetting keeps ids, dates and revision numbers as tombstones, never text.
  Copies outside the database (backups, exports already downloaded, anything
  a model already read) are not reachable. Exports taken before a forget
  cannot bring the memory back through `importAll`.
- Captured turns (`capture`) are not linked to memories in this contract.
  Forgetting a memory does not delete a captured turn that mentions it.
  ChatGideon's runtime does link them.
- SQLite files are created owner-only on POSIX systems. Windows ACLs are not
  changed. The database is not encrypted at rest.
- Exports contain memory text and opaque ids, a scope fingerprint instead of
  the scope id, and never tokens or credentials.

## Optional: verified procedures (Stage 17)

`SqliteProcedureStore` + `openProcedures` learn declarative task procedures
from episodes whose success was observed (a tool result or an external check),
promote them only after independent review and held-out and
negative-precondition checks, and give them back as **advice**. Advice is
checked at recall against the environment, tool versions, preconditions and
the capabilities the host granted, and it never runs or grants anything. A
manifest cannot carry memory policy, credentials, temporary ids, scripts or
bypass instructions. SQLite only.

## Optional: media assets (Stage 18)

`SqliteAssetStore` + `openAssets` keep images (PNG, JPEG, WebP), documents
(PDF, plain text, Markdown) and audio (WAV) under **per-modality consent**:
raw bytes, derived text (descriptions, OCR, transcripts) and a retention
window are each opt-in, and text-memory consent never covers media.
Embeddings are not supported. Uploads are checked by magic bytes and size;
URLs are refused and nothing is fetched.

- **Interpreters.** Only plain text and Markdown are read out of the box.
  PDF parsing, OCR, image description and speech recognition need an
  `AssetInterpreter` from the host; until then those uploads stay
  uninterpreted and recall says nothing about them.
- **Old pictures are not the present.** Every recalled item is labelled a
  historical observation with its capture date, producer and confidence. What
  something looks like now needs a fresh upload or re-observation.
- **Interrupted audio** is transcribed only for the part that arrived.
- **Deletion** removes raw bytes, derived text and search terms, and a parse
  running at the time cannot bring them back. No thumbnails are generated.
  Backups, downloaded exports and anything a model already read are out of
  reach.
- **Not supported:** face or voice identity linking, sensitive-trait
  extraction, a permanent microphone archive. SQLite only.

## Dependencies and license

See `RELEASE.md`.
