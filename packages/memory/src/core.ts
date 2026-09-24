import {
  EXPORT_FORMAT_VERSION,
  LIMITS,
  MEMORY_KINDS,
  MemoryError,
  assertGrant,
  assertLive,
  type CallOptions,
  type Grant,
  type MemoryBackend,
  type MemoryItem,
  type MemoryKind,
  type MemoryRevision,
  type Page,
  type Scope,
  type WriteResult,
} from './contract.ts'
import { canonicalKey, normalizeText, sha256 } from './text.ts'

/**
 * The memory a host hands to one verified user. The host builds it from its
 * own identity check; nothing a caller or a model sends can change the scope.
 * Explicit remember/correct/forget need no model and no embeddings.
 */

export interface OpenMemoryOptions {
  backend: MemoryBackend
  /** From the host's own authentication; never from request data. */
  scopeId: string
  principalId: string
  grants?: readonly Grant[]
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u
const ALL_GRANTS: readonly Grant[] = ['read', 'write', 'forget', 'capture', 'export', 'jobs']

function required(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !normalizeText(value)) throw new MemoryError('validation', `${name} is required.`)
  if (value.length > max) throw new MemoryError('validation', `${name} is longer than ${max} characters.`)
  return value
}

function commandId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new MemoryError('validation', 'commandId must be 1-160 letters, digits or ._:/- and start with a letter or digit.')
  return value
}

function kind(value: unknown): MemoryKind {
  if (value === undefined) return 'fact'
  if (!MEMORY_KINDS.includes(value as MemoryKind)) throw new MemoryError('validation', `kind must be one of ${MEMORY_KINDS.join(', ')}.`)
  return value as MemoryKind
}

function instant(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new MemoryError('validation', `${name} must be an ISO date or time.`)
  return new Date(value).toISOString()
}

export interface MemoryExport {
  format: 'gideon-memory-export'
  version: typeof EXPORT_FORMAT_VERSION
  exportedAt: string
  /** A fingerprint of the scope, not its id; importing into another scope is refused. */
  scope: string
  /** `id` is the opaque id the memory had here; importing it after it was forgotten is refused. */
  items: { id: string; key: string; kind: MemoryKind; text: string; validFrom: string | null; createdAt: string }[]
}

export interface ImportReport { created: number; duplicate: number; replayed: number; suppressed: number }

export class ScopedMemory {
  readonly scope: Scope
  constructor(private readonly backend: MemoryBackend, scope: Scope) {
    this.scope = Object.freeze({ ...scope, grants: Object.freeze([...scope.grants]) })
  }

  get capabilities() { return this.backend.capabilities }

  async remember(input: { commandId: string; text: string; kind?: MemoryKind; validFrom?: string | null }, options?: CallOptions): Promise<WriteResult> {
    assertGrant(this.scope, 'write')
    assertLive(options)
    return this.backend.remember(this.scope, { commandId: commandId(input.commandId), text: required(input.text, 'text', LIMITS.textLength), kind: kind(input.kind), validFrom: instant(input.validFrom, 'validFrom') }, options)
  }

  async correct(input: { commandId: string; id: string; expectedRevision: number; text: string; change?: 'mistake' | 'changed'; since?: string | null }, options?: CallOptions): Promise<WriteResult> {
    assertGrant(this.scope, 'write')
    assertLive(options)
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new MemoryError('validation', 'expectedRevision must be the revision you read.')
    const change = input.change ?? 'mistake'
    if (change !== 'mistake' && change !== 'changed') throw new MemoryError('validation', "change must be 'mistake' or 'changed'.")
    if (change === 'mistake' && input.since) throw new MemoryError('validation', "A mistake has no 'since': the old value was never true.")
    if (change === 'changed' && this.backend.capabilities.temporal === 'none') throw new MemoryError('unsupported', 'This backend does not keep real-world validity.')
    return this.backend.correct(this.scope, { commandId: commandId(input.commandId), id: required(input.id, 'id', 200), expectedRevision: input.expectedRevision, text: required(input.text, 'text', LIMITS.textLength), change, since: instant(input.since, 'since') }, options)
  }

  async forget(input: { commandId: string; id: string; expectedRevision: number }, options?: CallOptions) {
    assertGrant(this.scope, 'forget')
    assertLive(options)
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new MemoryError('validation', 'expectedRevision must be the revision you read.')
    return this.backend.forget(this.scope, { commandId: commandId(input.commandId), id: required(input.id, 'id', 200), expectedRevision: input.expectedRevision }, options)
  }

  async get(id: string, options?: CallOptions): Promise<MemoryItem | null> {
    assertGrant(this.scope, 'read')
    assertLive(options)
    return this.backend.get(this.scope, required(id, 'id', 200), options)
  }

  async getAt(id: string, validAt: string, options?: CallOptions): Promise<MemoryItem | null> {
    assertGrant(this.scope, 'read')
    assertLive(options)
    if (this.backend.capabilities.temporal === 'none') throw new MemoryError('unsupported', 'This backend does not keep real-world validity.')
    return this.backend.getAt(this.scope, required(id, 'id', 200), instant(validAt, 'validAt')!, options)
  }

  async history(id: string, options?: CallOptions): Promise<MemoryRevision[]> {
    assertGrant(this.scope, 'read')
    assertLive(options)
    return this.backend.history(this.scope, required(id, 'id', 200), options)
  }

  async list(page: { limit?: number; cursor?: string | null } = {}, options?: CallOptions): Promise<Page<MemoryItem>> {
    assertGrant(this.scope, 'read')
    assertLive(options)
    return this.backend.list(this.scope, { limit: Math.max(1, Math.min(page.limit ?? 20, LIMITS.pageSize)), cursor: page.cursor ?? null }, options)
  }

  async search(query: string, limit = 8, options?: CallOptions): Promise<MemoryItem[]> {
    assertGrant(this.scope, 'read')
    assertLive(options)
    return this.backend.search(this.scope, required(query, 'query', 500), Math.max(1, Math.min(limit, LIMITS.searchResults)), options)
  }

  async capture(input: { idempotencyKey: string; text: string }, options?: CallOptions) {
    assertGrant(this.scope, 'capture')
    assertLive(options)
    return this.backend.capture(this.scope, { idempotencyKey: commandId(input.idempotencyKey), text: required(input.text, 'text', LIMITS.captureTextLength) }, options)
  }

  async claimJobs(input: { workerId: string; limit?: number; leaseMs?: number }, options?: CallOptions) {
    assertGrant(this.scope, 'jobs')
    assertLive(options)
    return this.backend.claimJobs(this.scope, { workerId: commandId(input.workerId), limit: input.limit ?? 10, leaseMs: input.leaseMs ?? 30_000 }, options)
  }

  async completeJob(input: { jobId: string; fence: number }, options?: CallOptions) {
    assertGrant(this.scope, 'jobs')
    assertLive(options)
    return this.backend.completeJob(this.scope, input, options)
  }

  /** Current memories only; nothing forgotten, no credentials, no internal ids. */
  async exportAll(options?: CallOptions): Promise<MemoryExport> {
    assertGrant(this.scope, 'export')
    const items: MemoryExport['items'] = []
    let cursor: string | null = null
    do {
      assertLive(options)
      const page: Page<MemoryItem> = await this.backend.list(this.scope, { limit: LIMITS.pageSize, cursor }, options)
      for (const item of page.items) items.push({ id: item.id, key: canonicalKey(item.kind, item.text), kind: item.kind, text: item.text, validFrom: item.validFrom, createdAt: item.createdAt })
      cursor = page.nextCursor
    } while (cursor)
    return { format: 'gideon-memory-export', version: EXPORT_FORMAT_VERSION, exportedAt: options?.now ?? new Date().toISOString(), scope: scopeFingerprint(this.scope.scopeId), items }
  }

  /**
   * Idempotent: each item's command id comes from its content, so importing
   * the same document twice replays. An item forgotten since the export (by
   * its original id) or since an earlier import (by its command) is refused
   * as suppressed rather than written again.
   */
  async importAll(document: unknown, options?: CallOptions): Promise<ImportReport> {
    assertGrant(this.scope, 'write')
    const doc = document as Partial<MemoryExport> | null
    if (!doc || doc.format !== 'gideon-memory-export' || doc.version !== EXPORT_FORMAT_VERSION || !Array.isArray(doc.items)) throw new MemoryError('validation', 'Not a memory export this version can read.')
    if (doc.scope !== scopeFingerprint(this.scope.scopeId)) throw new MemoryError('validation', 'This export belongs to a different memory.')
    const report: ImportReport = { created: 0, duplicate: 0, replayed: 0, suppressed: 0 }
    for (const item of doc.items) {
      assertLive(options)
      const itemKind = kind(item.kind)
      const text = required(item.text, 'text', LIMITS.textLength)
      try {
        const sourceId = typeof item.id === 'string' && item.id.length <= 200 ? item.id : undefined
        const result = await this.backend.remember(this.scope, { commandId: `import/${canonicalKey(itemKind, text).slice(0, 48)}`, text, kind: itemKind, validFrom: instant(item.validFrom, 'validFrom'), basis: 'imported', sourceId }, options)
        report[result.outcome] += 1
      } catch (error) {
        if (error instanceof MemoryError && error.code === 'suppressed') report.suppressed += 1
        else throw error
      }
    }
    return report
  }
}

export function scopeFingerprint(scopeId: string): string {
  return sha256(`gideon-memory-scope\0${scopeId}`).slice(0, 32)
}

/** Only host code calls this, after its own identity check. */
export function openMemory(options: OpenMemoryOptions): ScopedMemory {
  if (!ID.test(options.scopeId) || !ID.test(options.principalId)) throw new MemoryError('validation', 'scopeId and principalId must be stable ids.')
  const grants = options.grants ?? ALL_GRANTS
  for (const grant of grants) if (!ALL_GRANTS.includes(grant)) throw new MemoryError('validation', `Unknown grant ${grant}.`)
  return new ScopedMemory(options.backend, { scopeId: options.scopeId, principalId: options.principalId, grants })
}
