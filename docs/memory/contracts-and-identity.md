# Stage 02 contract and identity semantics

Stage 02 defines the edge-safe semantic boundary. It does not create a
database, change the account system, or claim that an assertion has been
accepted merely because a JSON object parsed.

## Trust boundary

`src/lib/memory/index.ts` is the Worker-facing entry point. It exports only
the contracts, validators, deterministic policy functions, and bounded
constants in `contracts.ts`. It has no runtime imports from Node, the
filesystem, a database driver, a provider, or a secret-bearing server module.

`MemorySession` is a server-bound object. `src/server/memory-session.ts` derives
the principal, account scope, subject, grants, authority, and policy epoch from
an owner that a server adapter has already authenticated. It accepts a store,
but it does not accept a scope or grant set from the caller. The Node cookie
resolver is isolated in `src/server/node-memory-session.ts` so importing the
generic binder into the Cloudflare Worker does not pull Node identity code into
the edge graph.

Unverified requests receive an explicitly `ephemeral` session and a private
request/connection store. The session is useful for anonymous conversation but
does not turn an untrusted browser identifier into durable ownership.

## Wire versus bound objects

Public model/browser commands are parsed by `parsePublicMemoryCommand`. Their
allowed fields are limited to the operation and user content. `tenant`,
`principal`, `scope`, `grantSet`, `sourceAuthority`, `actor`, and canonical
revision fields are rejected as unsafe fields. `bindMemoryCommand` adds the
server-owned subject, scope, principal, authority, and policy epoch from the
prebound session.

`parseSessionDescriptor` validates a serialized identity/policy descriptor but
does not accept a storage handle. Storage is deliberately absent from the wire
shape; only a trusted server resolver attaches it to `MemorySession`.

## Attribution and temporal semantics

Events keep `actor` and `subject` separate. A colleague quote is a third-party
actor/source and cannot become a user self-claim. Assistant-generated text is
trusted only when the source authority is `server_generated`; a client playback
or display report is not assistant authorship. Hypothetical, role-play, and
quotation mode markers are retained as evidence but fail
`sourceCanEstablishSelfAssertion`.

Assertions have explicit payload variants for facts, conditional preferences,
constraints, decisions, and episode checkpoints. Slot propositions must use the
registered scalar/set/event cardinality. A free-form proposition may retain an
unresolved subject rather than guessing an entity or canonical slot.

Source/valid time and system interpretation time are separate. Unknown
effective dates are represented by `from: null`, `until: null`, and
`precision: "unknown"`; the validator rejects a date paired with unknown
precision. A local source timezone is retained in `sourceTimeZone`. Correction,
real-world transition, and temporary exception are distinct temporal relations.

## Receipts and failures

`MemoryReceipt` is a discriminated union:

- `captured` has an event but no canonical revision or index watermark.
- `accepted` has a canonical revision but no index watermark.
- `indexed` has both a canonical revision and index watermark.
- `pending` has neither and names the pending interpretation/index/provider work.
- `failed` has `ok: false`, no revision/watermark, and one typed bounded failure.

The validator rejects contradictory combinations. Failure codes include
`unauthorized`, `conflict`, `ambiguous`, `unavailable`, `budget_exhausted`,
`validation`, `not_found`, and `suppressed`. Messages are bounded and failure
details are flat scalar metadata only; raw source text, provider errors, and
secrets are not part of the contract.

## Versioning strategy

Every wire object carries `schemaVersion: 1`. Unknown versions, unknown enum
members, unknown fields, unsafe authority fields, and incompatible temporal or
receipt combinations fail closed. A future version should add a new parser or
an explicit pure upgrade function that accepts only a known older version,
produces a complete current object, and records the source version in the
producer/metadata where the meaning can change. It must not silently reinterpret
unknown fields or downgrade a newer object.

The current core does not perform migrations. PostgreSQL transaction and
upgrade work belongs to Stage 03. The test adapter is intentionally not an
authority and is never exported from the edge entry point.

## Storage capability boundary

`MemoryStorageCapabilities` exposes a transaction callback. Its transaction
surface includes idempotent event lookup/insert, exact-version lookup, scoped
candidate reads, optimistic assertion commits, slot locking, outbox leases,
suppression checks, and dependency reads. This prevents a later adapter from
claiming correctness through an insufficient `get`/`set` abstraction.

`src/lib/memory/test-adapter.ts` implements that surface only for deterministic
policy/reducer tests. It does not provide PostgreSQL durability, cross-process
locking, crash recovery, or production isolation.
