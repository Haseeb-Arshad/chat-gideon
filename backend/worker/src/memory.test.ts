import { describe, expect, it } from 'vitest'
import { DurableObjectMemoryStore, SupabaseMemoryStore } from './memory'
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
})
