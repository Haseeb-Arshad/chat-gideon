/**
 * Cloudflare persistence for GIDEON's small durable-memory corpus.
 *
 * WebSocket sessions are named by the browser's opaque session id, so a
 * Durable Object gives each conversation a serialized write lane. When the
 * Supabase bindings are present, the same store is mirrored in the database;
 * the Durable Object storage fallback keeps local Worker development and a
 * no-database deployment honest and functional.
 */

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
  const memory = value as Partial<Memory>
  return (
    typeof memory.id === 'string' &&
    typeof memory.text === 'string' &&
    typeof memory.createdAt === 'string' &&
    typeof memory.usedAt === 'string' &&
    typeof memory.uses === 'number' &&
    (memory.kind === 'fact' ||
      memory.kind === 'preference' ||
      memory.kind === 'plan' ||
      memory.kind === 'person')
  )
}

function validMemories(value: unknown): Memory[] {
  return Array.isArray(value) ? value.filter(isMemory) : []
}

abstract class SerialisedStore implements MemoryStore {
  private queue: Promise<unknown> = Promise.resolve()

  abstract all(): Promise<Memory[]>
  abstract save(memories: Memory[]): Promise<void>

  mutate<T>(change: (memories: Memory[]) => { memories: Memory[]; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await this.all()
      const { memories, result } = change(current)
      await this.save(memories)
      return result
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}

export class DurableObjectMemoryStore extends SerialisedStore {
  private cache: Memory[] | null = null

  constructor(private readonly storage: StorageLike) {
    super()
  }

  async all() {
    if (this.cache) return this.cache
    this.cache = validMemories(await this.storage.get<unknown>(MEMORY_KEY))
    return this.cache
  }

  async save(memories: Memory[]) {
    this.cache = memories
    await this.storage.put(MEMORY_KEY, memories)
  }
}

/** A no-op persistence layer used only when no external store is configured. */
export class EphemeralMemoryStore extends SerialisedStore {
  private memories: Memory[] = []

  async all() {
    return this.memories
  }

  async save(memories: Memory[]) {
    this.memories = memories
  }
}

/**
 * Supabase REST store. The service-role key never leaves the Worker.
 *
 * This deliberately uses REST instead of the Supabase JS client: the Worker
 * only needs two calls, and avoiding a Node-oriented SDK keeps the bundle
 * small and compatible with workerd.
 */
export class SupabaseMemoryStore extends SerialisedStore {
  private cache: Memory[] | null = null
  private readonly baseUrl: string

  constructor(
    private readonly env: MemoryEnv,
    private readonly ownerId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    super()
    this.baseUrl = (env.SUPABASE_URL ?? '').replace(/\/$/, '')
  }

  private headers() {
    const key = envValue(this.env.SUPABASE_SERVICE_ROLE_KEY)
    return {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    }
  }

  private rowUrl() {
    return `${this.baseUrl}/rest/v1/${MEMORY_TABLE}?session_id=${encodeURIComponent(`eq.${this.ownerId}`)}&select=memories`
  }

  async all() {
    if (this.cache) return this.cache
    if (!this.baseUrl || !envValue(this.env.SUPABASE_SERVICE_ROLE_KEY)) {
      this.cache = []
      return this.cache
    }

    try {
      const response = await this.fetcher(this.rowUrl(), {
        headers: this.headers(),
      })
      if (!response.ok) {
        this.cache = []
        return this.cache
      }
      const body = (await response.json()) as unknown
      const row = Array.isArray(body) ? body[0] : null
      this.cache = validMemories(
        row && typeof row === 'object' ? (row as { memories?: unknown }).memories : [],
      )
    } catch {
      // A database outage should not make the voice companion crash. The
      // in-process cache still lets the current turn finish.
      this.cache = []
    }
    return this.cache
  }

  async save(memories: Memory[]) {
    this.cache = memories
    if (!this.baseUrl || !envValue(this.env.SUPABASE_SERVICE_ROLE_KEY)) return

    try {
      const response = await this.fetcher(`${this.baseUrl}/rest/v1/${MEMORY_TABLE}`, {
        method: 'POST',
        headers: {
          ...this.headers(),
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ session_id: this.ownerId, memories }),
      })
      await response.body?.cancel()
    } catch {
      // The local cache is still useful for the rest of this live session.
    }
  }
}

function envValue(value: string | undefined) {
  return value?.trim() || ''
}

export function hasSupabaseMemory(env: MemoryEnv) {
  return Boolean(envValue(env.SUPABASE_URL) && envValue(env.SUPABASE_SERVICE_ROLE_KEY))
}

export function memoryStoreForHttp(env: MemoryEnv, ownerId: string): MemoryStore {
  return hasSupabaseMemory(env)
    ? new SupabaseMemoryStore(env, ownerId)
    : new EphemeralMemoryStore()
}

