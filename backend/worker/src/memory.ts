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
