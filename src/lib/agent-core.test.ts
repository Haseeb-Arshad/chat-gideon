import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamTurn, type TurnOptions } from './agent-core'
import { MAX_MEMORIES, EphemeralMemoryStore, remember, type Memory } from './tools/memory'
import type { ServerFrame } from './protocol'
import { createServerMemorySession } from '../server/memory-session'
import type { MemoryTurnRuntime } from './memory/turn-runtime'
import type { ContextPack } from './memory/retrieval'

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
    const frames = await collect()
    expect(frames.at(-1)).toMatchObject({ t: 'done' })
    const deltas = frames.filter((frame) => frame.t === 'delta')
    const finalText = (frames.at(-1) as Extract<ServerFrame, { t: 'done' }>).text
    let offset = 0
    for (const delta of deltas) {
      expect(delta).toMatchObject({ responseId: expect.any(String), segmentId: expect.any(String), startChar: offset })
      offset = delta.endChar ?? offset
      expect(delta.endChar).toBe(delta.startChar! + delta.text.length)
    }
    expect(offset).toBe(finalText.length)
    expect(deltas.map((delta) => delta.text).join('')).toBe(finalText)
  })
  it('never executes a truncated tool call even with complete JSON arguments', async () => {
    const store = new EphemeralMemoryStore()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(tool)))
    expect((await collect({ memoryStore: store })).at(-1)).toMatchObject({ code: 'stream_interrupted' })
    expect(await store.all()).toEqual([])
  })
})

describe('turn memory boundary', () => {
  it('binds retrieved context to this authenticated owner and exact current user transcript', async () => {
    const session = createServerMemorySession({
      owner: 'user/stage09-recall', store: new EphemeralMemoryStore(), channel: 'http', authority: 'node_signed_cookie',
    })
    const captured: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      captured.push(init)
      return new Response(text + 'data: [DONE]\n\n')
    }))
    const runtime = {
      flags: { capture: false, commandWrites: false, recall: true },
      retrieve: vi.fn(async (_query: string, binding: Parameters<MemoryTurnRuntime['retrieve']>[1]) => ({
        status: 'ready' as const,
        binding,
        pack: {
          status: 'ready',
          text: 'Source-backed context: user prefers concise explanations.',
          authenticatedContext: { principalId: session.principal.id, scopeId: session.scope.id, policyEpoch: session.policyEpoch },
          coverage: { authority: { principalId: session.principal.id, scopeId: session.scope.id, policyEpoch: session.policyEpoch } },
        } as ContextPack,
      })),
      execute: vi.fn(),
    } as unknown as MemoryTurnRuntime

    await collect({ memorySession: session, memoryRuntime: runtime })
    const binding = vi.mocked(runtime.retrieve).mock.calls[0]?.[1]
    expect(binding).toMatchObject({
      turnId: 'turn', principalId: session.principal.id, scopeId: session.scope.id,
      policyEpoch: session.policyEpoch, latestUserText: 'cello', speculative: false,
    })
    expect(binding?.responseId).not.toBe('turn')
    expect(binding?.transcriptHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(captured[0]?.body)).toContain('Source-backed context: user prefers concise explanations.')
  })

  it('refuses stale speculative recall and never phrases unavailable as no memory', async () => {
    const session = createServerMemorySession({
      owner: 'user/stage09-stale', store: new EphemeralMemoryStore(), channel: 'websocket', authority: 'node_signed_cookie',
    })
    const captured: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      captured.push(init)
      return new Response(text + 'data: [DONE]\n\n')
    }))
    const runtime = {
      flags: { capture: false, commandWrites: false, recall: true },
      retrieve: vi.fn(async (_query: string, binding: Parameters<MemoryTurnRuntime['retrieve']>[1]) => ({
        status: 'ready' as const,
        binding: { ...binding, transcriptHash: 'stale-transcript' },
        pack: {
          status: 'ready', text: 'STALE PRIVATE FACT',
          authenticatedContext: { principalId: session.principal.id, scopeId: session.scope.id, policyEpoch: session.policyEpoch },
          coverage: { authority: { principalId: session.principal.id, scopeId: session.scope.id, policyEpoch: session.policyEpoch } },
        } as ContextPack,
      })),
      execute: vi.fn(),
    } as unknown as MemoryTurnRuntime

    await collect({ memorySession: session, memoryRuntime: runtime, speculative: true })
    const requestBody = String(captured[0]?.body)
    expect(requestBody).not.toContain('STALE PRIVATE FACT')
    expect(requestBody).toContain('authorized memory lookup was unavailable')
    const request = JSON.parse(requestBody) as { messages?: Array<{ role?: string; content?: string }> }
    const unavailableMessage = request.messages?.find((message) => message.content?.includes('authorized memory lookup was unavailable'))
    expect(unavailableMessage?.content).toContain('cannot access it right now')
  })

  it('emits a committed memory receipt after interruption without completing assistant speech', async () => {
    const controller = new AbortController()
    const session = createServerMemorySession({
      owner: 'user/stage09-receipt', store: new EphemeralMemoryStore(), channel: 'websocket', authority: 'node_signed_cookie',
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`${tool}data: [DONE]\n\n`)))
    const runtime = {
      flags: { capture: true, commandWrites: true, recall: false },
      retrieve: vi.fn(),
      execute: vi.fn(async () => {
        controller.abort()
        return { ok: true, content: 'I saved that.', summary: 'Memory accepted', receiptState: 'accepted' as const }
      }),
    } as unknown as MemoryTurnRuntime
    const frames: ServerFrame[] = []
    for await (const frame of streamTurn('turn', [{ role: 'user', content: 'Remember that I play cello.' }], controller.signal, {
      memorySession: session,
      memoryRuntime: runtime,
    })) frames.push(frame)
    expect(frames.some((frame) => frame.t === 'action' && frame.name === 'remember' && frame.summary === 'Memory accepted' && frame.receiptState === 'accepted' && frame.pending === false)).toBe(true)
    expect(frames.some((frame) => frame.t === 'done')).toBe(false)
  })

  it('emits a failed action ledger entry when legacy admission rejects a new fact', async () => {
    const store = new EphemeralMemoryStore()
    const stamp = '2026-01-01T00:00:00.000Z'
    const existing: Memory[] = Array.from({ length: MAX_MEMORIES }, (_, index) => ({
      id: `existing-${index}`,
      kind: 'fact',
      text: `Existing durable detail ${index}`,
      createdAt: stamp,
      usedAt: stamp,
      uses: 1,
    }))
    await store.save(existing)

    let round = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      (round++ === 0 ? tool : text) + 'data: [DONE]\n\n',
    )))

    const frames = await collect({ memoryStore: store })

    expect(frames).toContainEqual(expect.objectContaining({
      t: 'action',
      name: 'remember',
      ok: false,
      summary: 'Memory was not stored: capacity reached',
    }))
    expect(await store.all()).toHaveLength(MAX_MEMORIES)
  })

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
