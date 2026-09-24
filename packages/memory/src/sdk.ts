import {
  MemoryError,
  WIRE_PROTOCOL_VERSION,
  type Capabilities,
  type CapturedEvent,
  type MemoryErrorCode,
  type MemoryItem,
  type MemoryKind,
  type MemoryRevision,
  type Page,
  type WriteResult,
} from './contract.ts'
import type { ImportReport, MemoryExport } from './core.ts'

/**
 * TypeScript client for the local memory server. The token is the identity;
 * no method takes a scope. Every call accepts an AbortSignal and fails with a
 * typed MemoryError (network trouble is `unavailable`, retryable).
 */

export interface MemoryClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
  /** Per-call timeout when no signal is given. */
  timeoutMs?: number
}

export interface MemoryClient {
  capabilities(options?: { signal?: AbortSignal }): Promise<Capabilities>
  remember(input: { commandId: string; text: string; kind?: MemoryKind; validFrom?: string | null }, options?: { signal?: AbortSignal }): Promise<WriteResult>
  correct(input: { commandId: string; id: string; expectedRevision: number; text: string; change?: 'mistake' | 'changed'; since?: string | null }, options?: { signal?: AbortSignal }): Promise<WriteResult>
  forget(input: { commandId: string; id: string; expectedRevision: number }, options?: { signal?: AbortSignal }): Promise<{ id: string; forgotten: true }>
  get(id: string, options?: { signal?: AbortSignal }): Promise<MemoryItem | null>
  getAt(id: string, validAt: string, options?: { signal?: AbortSignal }): Promise<MemoryItem | null>
  history(id: string, options?: { signal?: AbortSignal }): Promise<MemoryRevision[]>
  list(page?: { limit?: number; cursor?: string | null }, options?: { signal?: AbortSignal }): Promise<Page<MemoryItem>>
  /** Every current memory, one bounded page at a time. */
  listAll(options?: { pageSize?: number; signal?: AbortSignal }): AsyncGenerator<MemoryItem>
  search(query: string, limit?: number, options?: { signal?: AbortSignal }): Promise<MemoryItem[]>
  capture(input: { idempotencyKey: string; text: string }, options?: { signal?: AbortSignal }): Promise<CapturedEvent>
  exportAll(options?: { signal?: AbortSignal }): Promise<MemoryExport>
  importAll(document: MemoryExport, options?: { signal?: AbortSignal }): Promise<ImportReport>
}

export function createMemoryClient(options: MemoryClientOptions): MemoryClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const base = options.baseUrl.replace(/\/+$/u, '')

  async function call<T>(operation: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const effective = signal ?? AbortSignal.timeout(options.timeoutMs ?? 10_000)
    if (effective.aborted) throw new MemoryError('cancelled', 'The call was cancelled before it ran.')
    let response: Response
    try {
      response = await doFetch(`${base}/v1/${operation}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json', 'x-gideon-memory-protocol': String(WIRE_PROTOCOL_VERSION) },
        body: JSON.stringify(body ?? {}),
        signal: effective,
      })
    } catch (error) {
      if (effective.aborted) throw new MemoryError('cancelled', 'The call was cancelled.')
      throw new MemoryError('unavailable', `The memory server could not be reached (${(error as Error).name}).`, true)
    }
    let payload: { ok?: boolean; result?: unknown; error?: { code?: MemoryErrorCode; message?: string; retryable?: boolean } }
    try {
      payload = await response.json() as typeof payload
    } catch {
      throw new MemoryError('unavailable', `The memory server answered ${response.status} without JSON.`, response.status >= 500)
    }
    if (payload.ok) return payload.result as T
    throw new MemoryError(payload.error?.code ?? 'unavailable', payload.error?.message ?? `HTTP ${response.status}`, Boolean(payload.error?.retryable))
  }

  return {
    capabilities: (o) => call('capabilities', {}, o?.signal),
    remember: (input, o) => call('remember', input, o?.signal),
    correct: (input, o) => call('correct', input, o?.signal),
    forget: (input, o) => call('forget', input, o?.signal),
    get: (id, o) => call('get', { id }, o?.signal),
    getAt: (id, validAt, o) => call('get-at', { id, validAt }, o?.signal),
    history: (id, o) => call('history', { id }, o?.signal),
    list: (page = {}, o) => call('list', page, o?.signal),
    async *listAll(o = {}) {
      let cursor: string | null = null
      do {
        const page: Page<MemoryItem> = await call('list', { limit: o.pageSize ?? 50, cursor }, o.signal)
        yield* page.items
        cursor = page.nextCursor
      } while (cursor)
    },
    search: (query, limit, o) => call('search', { query, limit }, o?.signal),
    capture: (input, o) => call('capture', input, o?.signal),
    exportAll: (o) => call('export', {}, o?.signal),
    importAll: (document, o) => call('import', { document }, o?.signal),
  }
}
