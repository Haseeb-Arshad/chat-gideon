/**
 * @gideon/memory contract: the part every backend and every host shares.
 *
 * Three versions move independently:
 * - WIRE_PROTOCOL_VERSION: the HTTP/MCP request and response shapes;
 * - STORED_SCHEMA_VERSION: what a backend writes to its own database;
 * - EXPORT_FORMAT_VERSION: the portable export document.
 *
 * A backend declares its guarantees in `capabilities`. Asking for something a
 * backend does not guarantee fails with `unsupported`; nothing is emulated.
 */

export const WIRE_PROTOCOL_VERSION = 1
export const STORED_SCHEMA_VERSION = 1
export const EXPORT_FORMAT_VERSION = 1

export const MEMORY_KINDS = ['fact', 'preference', 'constraint', 'decision'] as const
export type MemoryKind = typeof MEMORY_KINDS[number]

/** A scope is one owner's memory. Only the host constructs it, from its own verified identity. */
export interface Scope {
  scopeId: string
  principalId: string
  grants: readonly Grant[]
}

export type Grant = 'read' | 'write' | 'forget' | 'capture' | 'export' | 'jobs'

export interface MemoryItem {
  id: string
  revision: number
  kind: MemoryKind
  text: string
  /** Real-world validity; null means "not stated". */
  validFrom: string | null
  validUntil: string | null
  basis: 'explicit' | 'correction' | 'imported'
  createdAt: string
  updatedAt: string
}

export interface Capabilities {
  backend: string
  storedSchemaVersion: number
  /** Every write is one transaction; a failed write leaves nothing behind. */
  atomicWrites: true
  /** Correct/forget name the revision they expect; a stale one is a conflict. */
  optimisticRevisions: true
  /** A command id replays its first result; a different payload under the same id is a conflict. */
  idempotentCommands: true
  /** Point-in-time reads over real-world validity. */
  temporal: 'valid_at' | 'none'
  /** Forgetting removes content, blocks replay of the commands that created it, and blocks re-import. */
  suppression: 'content_removed' | 'logical_only'
  /** How writers in different processes are serialised. */
  crossProcessWriters: 'database_locking' | 'single_process_only'
  /** Job claims carry a fence; a stale fence cannot complete a job. */
  fencedJobLeases: true
  lexicalSearch: 'full_text' | 'token_index'
  /** Semantic/vector recall. */
  semanticSearch: false
}

export type MemoryErrorCode =
  | 'validation'
  | 'unauthorized'
  | 'conflict'
  | 'not_found'
  | 'suppressed'
  | 'quota'
  | 'unavailable'
  | 'unsupported'
  | 'cancelled'

export class MemoryError extends Error {
  readonly name = 'MemoryError'
  constructor(readonly code: MemoryErrorCode, message: string, readonly retryable = false) {
    super(message)
  }
}

export type WriteOutcome = 'created' | 'duplicate' | 'replayed'

export interface WriteResult { outcome: WriteOutcome; item: MemoryItem }

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface CapturedEvent { eventId: string; outcome: 'captured' | 'replayed' }

export interface ClaimedJob { jobId: string; eventId: string; fence: number; attempt: number; leaseUntil: string }

export interface CallOptions { signal?: AbortSignal; now?: string }

/** One revision of a memory; `text` is null once the memory was forgotten. */
export interface MemoryRevision {
  revision: number
  basis: MemoryItem['basis']
  text: string | null
  validFrom: string | null
  validUntil: string | null
  /** Replaced as a mistake: it was never true at any time. */
  supersededAsMistake: boolean
  createdAt: string
}

/**
 * What a storage backend must implement. The scope is always passed by the
 * core, never by a caller; a backend refuses any scope it was not given.
 */
export interface MemoryBackend {
  readonly capabilities: Capabilities
  /** `sourceId`: the id this memory had in an export; if that memory was forgotten, the write is refused as suppressed. */
  remember(scope: Scope, input: { commandId: string; text: string; kind: MemoryKind; validFrom?: string | null; basis?: 'explicit' | 'imported'; sourceId?: string }, options?: CallOptions): Promise<WriteResult>
  correct(scope: Scope, input: { commandId: string; id: string; expectedRevision: number; text: string; change: 'mistake' | 'changed'; since?: string | null }, options?: CallOptions): Promise<WriteResult>
  forget(scope: Scope, input: { commandId: string; id: string; expectedRevision: number }, options?: CallOptions): Promise<{ id: string; forgotten: true }>
  get(scope: Scope, id: string, options?: CallOptions): Promise<MemoryItem | null>
  getAt(scope: Scope, id: string, validAt: string, options?: CallOptions): Promise<MemoryItem | null>
  /** Every revision, oldest first; an unknown id is an empty list. A forgotten memory keeps ids and dates, never text. */
  history(scope: Scope, id: string, options?: CallOptions): Promise<MemoryRevision[]>
  list(scope: Scope, page: { limit: number; cursor: string | null }, options?: CallOptions): Promise<Page<MemoryItem>>
  search(scope: Scope, query: string, limit: number, options?: CallOptions): Promise<MemoryItem[]>
  capture(scope: Scope, input: { idempotencyKey: string; text: string }, options?: CallOptions): Promise<CapturedEvent>
  claimJobs(scope: Scope, input: { workerId: string; limit: number; leaseMs: number }, options?: CallOptions): Promise<ClaimedJob[]>
  completeJob(scope: Scope, input: { jobId: string; fence: number }, options?: CallOptions): Promise<'completed' | 'lease_lost'>
  close(): Promise<void>
}

export const LIMITS = Object.freeze({
  textLength: 1_000,
  commandIdLength: 160,
  pageSize: 100,
  searchResults: 20,
  captureTextLength: 8_192,
})

export function assertGrant(scope: Scope, grant: Grant): void {
  if (!scope.grants.includes(grant)) throw new MemoryError('unauthorized', `This session may not ${grant}.`)
}

export function assertLive(options?: CallOptions): void {
  if (options?.signal?.aborted) throw new MemoryError('cancelled', 'The call was cancelled before it ran.')
}
