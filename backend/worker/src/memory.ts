import { Client } from 'pg'
import type { Memory, MemoryStore } from '../../../src/lib/tools/memory'

const MEMORY_KEY = 'memories'
const MEMORY_TABLE = 'gideon_memories'

interface StorageLike {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}
export interface MemoryEnv {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}
function isMemory(value: unknown): value is Memory {
  if (!value || typeof value !== 'object') return false
  const m = value as Partial<Memory>
  return typeof m.id === 'string' && typeof m.text === 'string' &&
    typeof m.createdAt === 'string' && typeof m.usedAt === 'string' &&
    typeof m.uses === 'number' && Number.isFinite(m.uses) &&
    ['fact', 'preference', 'plan', 'person'].includes(m.kind ?? '')
}
export function validMemories(value: unknown): Memory[] {
  return Array.isArray(value) ? value.filter(isMemory) : []
}
function decodeMemories(value: unknown): Memory[] {
  if (!Array.isArray(value) || !value.every(isMemory)) throw new Error('Invalid memory data')
  return structuredClone(value)
}
export function adoption(current: Memory[], incoming: unknown): { memories: Memory[]; result: number } {
  const found = validMemories(incoming)
  if (current.length || !found.length) return { memories: current, result: 0 }
  return { memories: found, result: found.length }
}

abstract class SerialisedStore implements MemoryStore {
  private queue: Promise<unknown> = Promise.resolve()
  abstract all(): Promise<Memory[]>
  abstract save(memories: Memory[]): Promise<void>
  mutate<T>(change: (memories: Memory[]) => { memories: Memory[]; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const { memories, result } = change(structuredClone(await this.all()))
      await this.save(memories)
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
export class DurableObjectMemoryStore extends SerialisedStore {
  private cache: Memory[] | null = null
  constructor(private readonly storage: StorageLike) { super() }
  async all() {
    if (!this.cache) {
      const data = await this.storage.get<unknown>(MEMORY_KEY)
      this.cache = data === undefined ? [] : decodeMemories(data)
    }
    return structuredClone(this.cache)
  }
  async save(memories: Memory[]) {
    const next = decodeMemories(memories)
    await this.storage.put(MEMORY_KEY, next)
    this.cache = next
  }
}
/** Used per request/connection, never persisted or shared between strangers. */
export class EphemeralMemoryStore extends SerialisedStore {
  private memories: Memory[] = []
  async all() { return structuredClone(this.memories) }
  async save(memories: Memory[]) { this.memories = decodeMemories(memories) }
}

/** Only instantiated by the owner's DO, never by an HTTP request or socket. */
export class SupabaseMemoryStore extends SerialisedStore {
  private cache: Memory[] | null = null
  private readonly baseUrl: string
  constructor(private readonly env: MemoryEnv, private readonly ownerId: string,
    private readonly fetcher: typeof fetch = fetch) {
    super()
    this.baseUrl = (env.SUPABASE_URL ?? '').replace(/\/$/, '')
  }
  private headers() {
    if (!hasSupabaseMemory(this.env)) throw new Error('Memory database is not configured')
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY!.trim()
    return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  }
  async all() {
    if (this.cache) return structuredClone(this.cache)
    const url = `${this.baseUrl}/rest/v1/${MEMORY_TABLE}?session_id=${encodeURIComponent(`eq.${this.ownerId}`)}&select=memories`
    const response = await this.fetcher(url, { headers: this.headers() })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Memory read failed') }
    const body: unknown = await response.json()
    if (!Array.isArray(body) || body.length > 1) throw new Error('Invalid memory response')
    this.cache = body.length === 0 ? [] : decodeMemories(body[0]?.memories)
    return structuredClone(this.cache)
  }
  async save(memories: Memory[]) {
    const next = decodeMemories(memories)
    const response = await this.fetcher(`${this.baseUrl}/rest/v1/${MEMORY_TABLE}`, {
      method: 'POST', headers: { ...this.headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ session_id: this.ownerId, memories: next }),
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error('Memory write failed')
    this.cache = next
  }
}
/** The part of a PostgreSQL client the memory store uses. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
  end(): Promise<void>
}

/** A fresh client per operation: a Worker cannot reuse a socket across requests, and Hyperdrive pools the real ones. */
export function hyperdriveClients(connectionString: string): () => Promise<SqlClient> {
  return async () => {
    const client = new Client({ connectionString })
    client.on('error', () => undefined)
    await client.connect()
    return client
  }
}

/**
 * The same `gideon_memories` row as the REST store, read and written over
 * SQL through Hyperdrive. Only instantiated by the owner's DO, which
 * serialises every write, so the cache stays the source of truth between reads.
 */
export class HyperdriveMemoryStore extends SerialisedStore {
  private cache: Memory[] | null = null
  constructor(private readonly connect: () => Promise<SqlClient>, private readonly ownerId: string) { super() }
  private async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.connect()
    try { return await work(client) } finally { await client.end().catch(() => undefined) }
  }
  async all() {
    if (this.cache) return structuredClone(this.cache)
    const { rows } = await this.run((client) => client.query(`SELECT memories FROM public.${MEMORY_TABLE} WHERE session_id = $1`, [this.ownerId]))
    if (rows.length > 1) throw new Error('Invalid memory response')
    this.cache = rows.length === 0 ? [] : decodeMemories((rows[0] as { memories?: unknown }).memories)
    return structuredClone(this.cache)
  }
  async save(memories: Memory[]) {
    const next = decodeMemories(memories)
    // Serialised by hand: the driver would send a JavaScript array as a PostgreSQL array, not JSON.
    await this.run((client) => client.query(
      `INSERT INTO public.${MEMORY_TABLE} (session_id, memories) VALUES ($1, $2::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET memories = excluded.memories`,
      [this.ownerId, JSON.stringify(next)],
    ))
    this.cache = next
  }
}

export function hasSupabaseMemory(env: MemoryEnv) {
  return Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim())
}

export interface MemorySnapshot { memories: Memory[]; version: string }
/** RPC carries data only. The authority compares the baseline inside its mutation queue. */
export interface MemoryRpc {
  memorySnapshot(owner: string): Promise<MemorySnapshot>
  memoryCommit(owner: string, expected: string, memories: Memory[]): Promise<boolean>
}
/** The slice of the session namespace the memory RPC needs. */
export interface MemoryNamespace {
  idFromName(name: string): { toString(): string }
  get(id: { toString(): string }): MemoryRpc
}
export function memoryStoreForHttp(_env: MemoryEnv, ownerId: string, session?: MemoryNamespace): MemoryStore {
  if (!ownerId.startsWith('user/')) return new EphemeralMemoryStore()
  if (!session) throw new Error('Memory authority is unavailable')
  return new RpcMemoryStore(session.get(session.idFromName(ownerId)), ownerId)
}

export class RpcMemoryStore implements MemoryStore {
  constructor(private readonly rpc: MemoryRpc, private readonly owner: string) {}
  async all() { return (await this.rpc.memorySnapshot(this.owner)).memories }
  async save(_memories: Memory[]): Promise<void> {
    throw new Error('Replacement writes require a versioned mutation')
  }
  async mutate<T>(change: (memories: Memory[]) => { memories: Memory[]; result: T }): Promise<T> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const snapshot = await this.rpc.memorySnapshot(this.owner)
      const { memories, result } = change(snapshot.memories)
      if (await this.rpc.memoryCommit(this.owner, snapshot.version, memories)) return result
    }
    throw new Error('Memory is busy; retry this operation')
  }
}
