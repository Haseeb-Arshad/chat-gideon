import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamTurn, type TurnOptions } from './agent-core'
import { EphemeralMemoryStore, remember } from './tools/memory'
import type { ServerFrame } from './protocol'

const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
const text = event({ choices: [{ delta: { content: 'A partial reply.' } }] })
const tool = event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'remember', arguments: JSON.stringify({ text: 'The user plays the cello' }) } }] } }] })
async function collect(options: TurnOptions = {}, id = 'turn') {
  const frames: ServerFrame[] = []
  for await (const frame of streamTurn(id, [{ role: 'user', content: 'cello' }], new AbortController().signal, options)) frames.push(frame)
  return frames
}
beforeEach(() => vi.stubEnv('OPENROUTER_API_KEY', 'fixture'))
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('upstream terminal completion', () => {
  it.each(['', event({ error: { message: 'failed' } }), event({ choices: [{ finish_reason: 'length' }] }), event({ choices: [{ finish_reason: 'error' }] })])('keeps partial deltas and errors without success', async (ending) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text + ending)))
    const frames = await collect()
    expect(frames).toContainEqual(expect.objectContaining({ t: 'delta' }))
    expect(frames.at(-1)).toMatchObject({ t: 'error', code: 'stream_interrupted', retryable: true })
    expect(frames.some((frame) => frame.t === 'done')).toBe(false)
  })
  it.each(['data: [DONE]\n\n', event({ choices: [{ finish_reason: 'stop' }] })])('accepts explicit completion', async (ending) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text + ending)))
    expect((await collect()).at(-1)).toMatchObject({ t: 'done' })
  })
  it('never executes a truncated tool call even with complete JSON arguments', async () => {
    const store = new EphemeralMemoryStore()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(tool)))
    expect((await collect({ memoryStore: store })).at(-1)).toMatchObject({ code: 'stream_interrupted' })
    expect(await store.all()).toEqual([])
  })
})

describe('turn memory boundary', () => {
  it('retrieves speculation context without touching metadata or saving', async () => {
    const store = new EphemeralMemoryStore()
    await store.save(remember([], 'fact', 'The user plays the cello').memories)
    const before = structuredClone(await store.all())
    const mutate = vi.spyOn(store, 'mutate')
    const fetch = vi.fn(async () => new Response(text + 'data: [DONE]\n\n'))
    vi.stubGlobal('fetch', fetch)
    await collect({ memoryStore: store, speculative: true })
    expect(mutate).not.toHaveBeenCalled()
    expect(await store.all()).toEqual(before)
    await collect({ memoryStore: store })
    expect((await store.all())[0].uses).toBe(before[0].uses + 1)
  })
  it('shares a default store within one run, never with another run', async () => {
    const requests: string[] = []
    let round = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(String(init.body))
      return new Response((round++ === 0 ? tool : text) + 'data: [DONE]\n\n')
    }))
    await collect()
    await collect()
    expect(requests[1]).toContain('Stored.')
    expect(requests[2]).not.toContain('Things you already know about this person')
  })
})
