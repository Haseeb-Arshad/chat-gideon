import { afterEach, expect, it, vi } from 'vitest'

const dependencies = vi.hoisted(() => ({ session: null as unknown, runtime: null as unknown }))
vi.mock('../server/node-memory-integration', () => ({ resolveNodeMemoryForTurn: async () => ({ memorySession: dependencies.session, memoryRuntime: dependencies.runtime }) }))
import { streamChat } from './openrouter.server'
import { createServerMemorySession } from '../server/memory-session'
import { EphemeralMemoryStore } from './tools/memory'
import type { MemoryTurnRuntime } from './memory/turn-runtime'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  dependencies.session = null
  dependencies.runtime = null
})

it('carries enabled authenticated retrieval through the typed HTTP stream adapter', async () => {
  vi.stubEnv('OPENROUTER_API_KEY', 'fixture')
  const session = createServerMemorySession({
    owner: 'user/stage09-http', store: new EphemeralMemoryStore(), channel: 'http', authority: 'node_signed_cookie',
  })
  dependencies.session = session
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    requests.push(init)
    return new Response('data: {"choices":[{"delta":{"content":"Typed reply."}}]}\n\ndata: [DONE]\n\n')
  }))
  const runtime = {
    flags: { capture: false, commandWrites: false, recall: true },
    retrieve: vi.fn(async (_query: string, binding: Parameters<MemoryTurnRuntime['retrieve']>[1]) => ({
      status: 'ready' as const,
      binding,
      pack: {
        status: 'ready', text: 'HTTP source-backed context.',
        authenticatedContext: { principalId: session.principal.id, scopeId: session.scope.id, policyEpoch: session.policyEpoch },
        coverage: { authority: { principalId: session.principal.id, scopeId: session.scope.id, policyEpoch: session.policyEpoch } },
      } as never,
    })),
    execute: vi.fn(),
  } as unknown as MemoryTurnRuntime
  dependencies.runtime = runtime

  const response = streamChat(
    'http-turn', [{ role: 'user', content: 'typed question' }], new AbortController().signal,
    'UTC', false, null, null, new Request('http://localhost/api/chat'),
  )
  const frames = (await response.text()).trim().split('\n').map((line) => JSON.parse(line)) as unknown[]
  expect(frames[0]).toMatchObject({ t: 'start', id: 'http-turn' })
  expect(frames.at(-1)).toMatchObject({ t: 'done', id: 'http-turn', text: 'Typed reply.' })
  expect(runtime.retrieve).toHaveBeenCalledOnce()
  expect(String(requests[0]?.body)).toContain('HTTP source-backed context.')
})
