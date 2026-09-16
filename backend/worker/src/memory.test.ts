import { describe, expect, it } from 'vitest'
import { DurableObjectMemoryStore, RpcMemoryStore, SupabaseMemoryStore, memoryStoreForHttp } from './memory'
import { VersionedMemoryAuthority } from '../../../src/server/memory-authority'
import type { Memory } from '../../../src/lib/tools/memory'

const firstMemory: Memory = {
  id: 'memory-1',
  kind: 'fact',
  text: 'The user likes tea.',
  createdAt: '2026-09-10T00:00:00.000Z',
  usedAt: '2026-09-10T00:00:00.000Z',
  uses: 0,
}

describe('Durable Object memory store', () => {
  it('round-trips memories through Durable Object storage', async () => {
    const values = new Map<string, unknown>()
    const storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => void values.set(key, value),
    }
    const store = new DurableObjectMemoryStore(storage)

    await store.save([firstMemory])

    expect(await store.all()).toEqual([firstMemory])
  })

  it('serializes read-modify-write mutations', async () => {
    const values = new Map<string, unknown>()
    const storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        await Promise.resolve()
        values.set(key, value)
      },
    }
    const store = new DurableObjectMemoryStore(storage)

    await Promise.all(
      [1, 2].map((number) =>
        store.mutate((memories) => {
          const next = { ...firstMemory, id: `memory-${number}`, text: `Fact ${number}.` }
          return { memories: [...memories, next], result: next.id }
        }),
      ),
    )

    expect((await store.all()).map((memory) => memory.id).sort()).toEqual([
      'memory-1',
      'memory-2',
    ])
  })

  it('uses the server-only Supabase REST binding for the mirror', async () => {
    const requests: Array<{ url: string; method: string }> = []
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET' })
      if (init?.method === 'POST') return new Response(null, { status: 201 })
      return new Response(JSON.stringify([{ memories: [firstMemory] }]), { status: 200 })
    }
    const store = new SupabaseMemoryStore(
      { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-key' },
      'session-1',
      fetcher,
    )

    expect(await store.all()).toEqual([firstMemory])
    await store.save([firstMemory])

    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST'])
    expect(requests[0]?.url).toContain('session_id=eq.session-1')
  })

  it('never writes a failed read as an empty baseline; retries recover', async () => {
    let failed = true
    let writes = 0
    const store = new SupabaseMemoryStore(
      { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' }, 'user/a',
      async (_input, init) => {
        if (init?.method === 'POST') { writes++; return new Response(null, { status: 201 }) }
        return failed ? new Response(null, { status: 503 }) : Response.json([{ memories: [firstMemory] }])
      },
    )
    await expect(store.mutate((memories) => ({ memories, result: 1 }))).rejects.toThrow('read failed')
    expect(writes).toBe(0)
    failed = false
    expect(await store.all()).toEqual([firstMemory])
  })

  it('does not publish failed writes to cache and its queue remains retryable', async () => {
    let failed = true
    const store = new SupabaseMemoryStore(
      { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' }, 'user/a',
      async (_input, init) => init?.method === 'POST'
        ? new Response(null, { status: failed ? 503 : 201 })
        : Response.json([{ memories: [firstMemory] }]),
    )
    await store.all()
    await expect(store.mutate(() => ({ memories: [], result: 0 }))).rejects.toThrow('write failed')
    expect(await store.all()).toEqual([firstMemory])
    failed = false
    await store.mutate(() => ({ memories: [], result: 0 }))
    expect(await store.all()).toEqual([])
  })

  for (const remote of [false, true]) it(`serializes HTTP RPC and socket mutations (${remote ? 'Supabase' : 'DO storage'})`, async () => {
    let persisted: Memory[] = []
    const backing = remote
      ? new SupabaseMemoryStore({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' }, 'user/a',
          async (_input, init) => {
            if (init?.method === 'POST') {
              persisted = JSON.parse(String(init.body)).memories
              return new Response(null, { status: 201 })
            }
            return Response.json([{ memories: persisted }])
          })
      : new DurableObjectMemoryStore({
          get: async <T>() => persisted as T,
          put: async <T>(_key: string, value: T) => { persisted = structuredClone(value) as Memory[] },
        })
    const authority = new VersionedMemoryAuthority(backing)
    const rpc = {
      memorySnapshot: async () => structuredClone(await authority.snapshot()),
      memoryCommit: async (_owner: string, version: string, memories: Memory[]) => authority.commit(version, structuredClone(memories)),
    }
    const http = memoryStoreForHttp({}, 'user/a', { idFromName: (name) => name, get: () => rpc })
    const http2 = new RpcMemoryStore(rpc, 'user/a')
    await Promise.all([http, authority, http2].map((store, index) =>
      store.mutate((memories) => ({ memories: [...memories, { ...firstMemory, id: String(index) }], result: index })),
    ))
    expect((await http.all()).map((m) => m.id).sort()).toEqual(['0', '1', '2'])
    expect(persisted).toHaveLength(3)
    await expect(http.save([])).rejects.toThrow('versioned')
  })

  it('unverified callers never reach a durable namespace or share anonymous memory', async () => {
    const a = memoryStoreForHttp({}, 'anonymous')
    const b = memoryStoreForHttp({}, 'anonymous')
    await a.mutate(() => ({ memories: [firstMemory], result: 1 }))
    expect(await b.all()).toEqual([])
  })
})
